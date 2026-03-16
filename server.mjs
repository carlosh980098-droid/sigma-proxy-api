import http from "node:http";
import https from "node:https";

const PORT = parseInt(process.env.PORT || "3000");
const API_KEY = process.env.API_KEY || "sigma-proxy-secret-key";

/**
 * Sigma Proxy API with Cloudflare Bypass
 * 
 * This server forwards HTTP requests to Sigma panels.
 * When Cloudflare challenge is detected, it uses Puppeteer to solve it
 * and caches the clearance cookies for subsequent requests.
 * 
 * Endpoints:
 * - POST /api/proxy - Forward a request to a Sigma panel API
 * - GET /health - Health check
 */

// Cache of Cloudflare clearance cookies per domain
// { domain: { cookies: string, userAgent: string, expiresAt: number } }
const cfCookieCache = {};

// Puppeteer instance (lazy loaded)
let puppeteerModule = null;

async function getPuppeteer() {
  if (!puppeteerModule) {
    try {
      puppeteerModule = await import("puppeteer");
    } catch (e) {
      console.error("[Proxy] Puppeteer not available:", e.message);
      return null;
    }
  }
  return puppeteerModule.default || puppeteerModule;
}

/**
 * Check if a response is a Cloudflare challenge page
 */
function isCloudflareChallenge(status, body) {
  if (status !== 403 && status !== 503) return false;
  const bodyStr = typeof body === "string" ? body : "";
  return bodyStr.includes("cf-browser-verification") ||
    bodyStr.includes("challenge-platform") ||
    bodyStr.includes("_cf_chl_opt") ||
    bodyStr.includes("Checking your browser") ||
    bodyStr.includes("Attention Required");
}

/**
 * Get cached Cloudflare cookies for a domain
 */
function getCachedCfCookies(domain) {
  const cached = cfCookieCache[domain];
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }
  // Expired or not found
  delete cfCookieCache[domain];
  return null;
}

/**
 * Use Puppeteer to solve Cloudflare challenge and get clearance cookies
 */
async function solveCfChallenge(url) {
  const puppeteer = await getPuppeteer();
  if (!puppeteer) {
    throw new Error("Puppeteer not available - cannot solve Cloudflare challenge");
  }

  const parsedUrl = new URL(url);
  const domain = parsedUrl.hostname;
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;

  console.log(`[CF-Bypass] Solving Cloudflare challenge for ${domain}...`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-extensions",
      ],
    });

    const page = await browser.newPage();
    
    // Set a realistic user agent
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    await page.setUserAgent(userAgent);
    await page.setViewport({ width: 1920, height: 1080 });

    // Navigate to the base URL to trigger CF challenge
    console.log(`[CF-Bypass] Navigating to ${baseUrl}...`);
    await page.goto(baseUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for Cloudflare to resolve (up to 20 seconds)
    console.log(`[CF-Bypass] Waiting for Cloudflare challenge to resolve...`);
    let resolved = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      
      const pageContent = await page.content();
      if (!pageContent.includes("_cf_chl_opt") && !pageContent.includes("challenge-platform")) {
        resolved = true;
        console.log(`[CF-Bypass] Challenge resolved after ${i + 1} seconds`);
        break;
      }
    }

    if (!resolved) {
      throw new Error("Cloudflare challenge did not resolve within 20 seconds");
    }

    // Extract cookies
    const cookies = await page.cookies();
    const cfCookies = cookies
      .filter(c => c.name.startsWith("cf_") || c.name === "__cf_bm" || c.name === "cf_clearance")
      .map(c => `${c.name}=${c.value}`)
      .join("; ");

    // Also get all cookies for the domain
    const allCookies = cookies
      .map(c => `${c.name}=${c.value}`)
      .join("; ");

    if (!cfCookies && !allCookies) {
      throw new Error("No Cloudflare cookies obtained after challenge");
    }

    const cookieStr = allCookies || cfCookies;
    console.log(`[CF-Bypass] Got ${cookies.length} cookies for ${domain}`);

    // Cache for 25 minutes (CF clearance usually lasts 30 min)
    cfCookieCache[domain] = {
      cookies: cookieStr,
      userAgent,
      expiresAt: Date.now() + 25 * 60 * 1000,
    };

    return cfCookieCache[domain];
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Make an HTTP request with optional CF cookies
 */
function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || "GET",
      headers: {
        "User-Agent": options.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        ...options.headers,
      },
      timeout: 25000,
    };

    const req = client.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        const responseHeaders = {};
        for (const [key, value] of Object.entries(res.headers)) {
          responseHeaders[key] = value;
        }
        resolve({
          status: res.statusCode,
          headers: responseHeaders,
          body: data,
        });
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function handleProxy(reqBody) {
  const { url, method, headers, body } = reqBody;

  if (!url) {
    return { status: 400, body: JSON.stringify({ error: "URL is required" }) };
  }

  try {
    const parsedUrl = new URL(url);
    const domain = parsedUrl.hostname;

    // Check if we have cached CF cookies for this domain
    let cfData = getCachedCfCookies(domain);
    
    // Build request headers
    const requestHeaders = { ...headers };
    if (cfData) {
      // Merge CF cookies with any existing cookies
      const existingCookies = requestHeaders["Cookie"] || requestHeaders["cookie"] || "";
      requestHeaders["Cookie"] = existingCookies 
        ? `${existingCookies}; ${cfData.cookies}` 
        : cfData.cookies;
      requestHeaders["User-Agent"] = cfData.userAgent;
    }

    // Make the request
    let result = await makeRequest(url, {
      method: method || "GET",
      headers: requestHeaders,
      body: body || undefined,
      userAgent: cfData?.userAgent,
    });

    // If Cloudflare challenge detected, try to solve it
    if (isCloudflareChallenge(result.status, result.body)) {
      console.log(`[Proxy] Cloudflare challenge detected for ${domain}, attempting bypass...`);
      
      try {
        cfData = await solveCfChallenge(url);
        
        // Retry the request with CF cookies
        const retryHeaders = { ...headers };
        const existingCookies = retryHeaders["Cookie"] || retryHeaders["cookie"] || "";
        retryHeaders["Cookie"] = existingCookies 
          ? `${existingCookies}; ${cfData.cookies}` 
          : cfData.cookies;
        retryHeaders["User-Agent"] = cfData.userAgent;

        result = await makeRequest(url, {
          method: method || "GET",
          headers: retryHeaders,
          body: body || undefined,
          userAgent: cfData.userAgent,
        });

        console.log(`[Proxy] Retry after CF bypass - status: ${result.status}`);
      } catch (cfError) {
        console.error(`[Proxy] CF bypass failed: ${cfError.message}`);
        return {
          status: 502,
          body: JSON.stringify({
            error: `Cloudflare bypass failed: ${cfError.message}`,
            code: "CF_BYPASS_FAILED",
          }),
        };
      }
    }

    return {
      status: 200,
      body: JSON.stringify({
        status: result.status,
        headers: result.headers,
        body: result.body,
      }),
    };
  } catch (err) {
    return {
      status: 502,
      body: JSON.stringify({
        error: err.message,
        code: err.code || "UNKNOWN",
      }),
    };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
    return;
  }

  // Auth check
  const authHeader = req.headers["authorization"];
  const providedKey = authHeader?.replace("Bearer ", "");
  if (providedKey !== API_KEY) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  // Proxy endpoint
  if (req.url === "/api/proxy" && req.method === "POST") {
    try {
      const rawBody = await readBody(req);
      const reqBody = JSON.parse(rawBody);
      const result = await handleProxy(reqBody);
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(result.body);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Sigma Proxy API running on port ${PORT}`);
  console.log(`Cloudflare bypass: Puppeteer-based (auto-detect)`);
});
