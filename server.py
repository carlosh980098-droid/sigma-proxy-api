"""
Sigma Proxy API - Python/Cloudscraper version
Bypasses Cloudflare protection for Sigma IPTV panels
"""
import json
import os
import time
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
import cloudscraper

API_KEY = os.environ.get("API_KEY", "sigma-proxy-secret-key")
PORT = int(os.environ.get("PORT", 3000))

# Session cache to reuse cloudscraper sessions per domain
session_cache = {}
session_lock = threading.Lock()
SESSION_TTL = 300  # 5 minutes


def get_session(domain):
    """Get or create a cloudscraper session for a domain."""
    now = time.time()
    with session_lock:
        if domain in session_cache:
            sess, created = session_cache[domain]
            if now - created < SESSION_TTL:
                return sess
        # Create new session
        scraper = cloudscraper.create_scraper(
            browser={
                'browser': 'chrome',
                'platform': 'windows',
                'desktop': True,
            }
        )
        session_cache[domain] = (scraper, now)
        return scraper


class ProxyHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        """Suppress default logging."""
        pass

    def send_json(self, status, data):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_OPTIONS(self):
        self.send_json(200, {"ok": True})

    def do_GET(self):
        if self.path == "/health" or self.path == "/":
            self.send_json(200, {"status": "ok", "engine": "cloudscraper"})
            return
        self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        # Auth check
        auth = self.headers.get("Authorization", "")
        key = auth.replace("Bearer ", "") if auth.startswith("Bearer ") else auth
        if key != API_KEY:
            self.send_json(401, {"error": "Unauthorized"})
            return

        if self.path != "/api/proxy":
            self.send_json(404, {"error": "Not found"})
            return

        # Read body
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode()

        try:
            req = json.loads(body)
        except json.JSONDecodeError:
            self.send_json(400, {"error": "Invalid JSON"})
            return

        target_url = req.get("url", "")
        method = req.get("method", "GET").upper()
        headers = req.get("headers", {})
        req_body = req.get("body", "")

        if not target_url:
            self.send_json(400, {"error": "Missing url"})
            return

        # Extract domain from URL
        try:
            from urllib.parse import urlparse
            parsed = urlparse(target_url)
            domain = parsed.hostname
        except Exception:
            domain = "unknown"

        print(f"[Proxy] {method} {target_url} (domain: {domain})")

        try:
            scraper = get_session(domain)

            # First visit the main page to establish session/cookies if needed
            base_url = f"{parsed.scheme}://{parsed.hostname}"
            
            # Set headers
            request_headers = {
                "Accept": "application/json, text/plain, */*",
                "Content-Type": "application/json",
                "X-Requested-With": "XMLHttpRequest",
                "Origin": base_url,
                "Referer": f"{base_url}/",
            }
            request_headers.update(headers)

            if method == "GET":
                resp = scraper.get(target_url, headers=request_headers, timeout=30)
            elif method == "POST":
                resp = scraper.post(
                    target_url,
                    data=req_body,
                    headers=request_headers,
                    timeout=30,
                )
            else:
                resp = scraper.request(
                    method, target_url, data=req_body, headers=request_headers, timeout=30
                )

            # Try to parse response as JSON
            try:
                resp_body = resp.json()
            except Exception:
                resp_body = resp.text

            result = {
                "status": resp.status_code,
                "body": resp_body,
                "headers": dict(resp.headers),
            }
            print(f"[Proxy] Response: {resp.status_code}")
            self.send_json(200, result)

        except Exception as e:
            print(f"[Proxy] Error: {str(e)}")
            # If session failed, clear cache and retry once
            with session_lock:
                if domain in session_cache:
                    del session_cache[domain]

            try:
                scraper = get_session(domain)
                # Visit main page first
                scraper.get(base_url, timeout=15)
                
                if method == "GET":
                    resp = scraper.get(target_url, headers=request_headers, timeout=30)
                elif method == "POST":
                    resp = scraper.post(
                        target_url, data=req_body, headers=request_headers, timeout=30
                    )
                else:
                    resp = scraper.request(
                        method, target_url, data=req_body, headers=request_headers, timeout=30
                    )

                try:
                    resp_body = resp.json()
                except Exception:
                    resp_body = resp.text

                result = {
                    "status": resp.status_code,
                    "body": resp_body,
                    "headers": dict(resp.headers),
                }
                print(f"[Proxy] Retry response: {resp.status_code}")
                self.send_json(200, result)
            except Exception as e2:
                self.send_json(500, {
                    "error": f"Proxy request failed: {str(e2)}",
                    "status": 0,
                    "body": "",
                })


def main():
    server = HTTPServer(("0.0.0.0", PORT), ProxyHandler)
    print(f"Sigma Proxy API (cloudscraper) running on port {PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
