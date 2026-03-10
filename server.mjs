import http from "node:http";
import https from "node:https";

const PORT = parseInt(process.env.PORT || "3000");
const API_KEY = process.env.API_KEY || "sigma-proxy-secret-key";

/**
 * Sigma Proxy API
 * 
 * This server receives HTTP requests from the Sigma Dashboard and forwards them
 * to Sigma/HPLAY panels. Running on Railway, the IP is not blocked by Cloudflare.
 * 
 * Endpoints:
 * - POST /api/proxy - Forward a request to a panel API
 * - GET /health - Health check
 */

function makeRequest(url, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error("Too many redirects"));
      return;
    }
    
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        ...options.headers,
      },
      timeout: 25000,
    };

    const req = client.request(reqOptions, (res) => {
      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).toString();
        const newOptions = { ...options };
        if ([301, 302, 303].includes(res.statusCode)) {
          newOptions.method = "GET";
          delete newOptions.body;
        }
        makeRequest(redirectUrl, newOptions, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      
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
    const result = await makeRequest(url, {
      method: method || "GET",
      headers: headers || {},
      body: body || undefined,
    });

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
  console.log("Sigma Proxy API running on port " + PORT);
});
