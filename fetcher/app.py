"""fxebay fetcher — fetches eBay pages with a browser TLS fingerprint.

eBay rejects requests by TLS/HTTP2 fingerprint, so the Cloudflare Worker can't
fetch listings itself. This tiny service does it with curl_cffi and returns a
trimmed page (meta tags + JSON-LD) for the worker to parse.

  GET /item/<id>      -> trimmed listing HTML
  GET /short/<code>   -> {"location": "..."} for ebay.us short links
  GET /health         -> ok

Env: FETCHER_TOKEN (required bearer token), PORT (default 8790), HOST (default 127.0.0.1).
"""

import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from curl_cffi import requests

TOKEN = os.environ.get("FETCHER_TOKEN", "")
PORT = int(os.environ.get("PORT", "8790"))
HOST = os.environ.get("HOST", "127.0.0.1")

# Tried in order; the first one eBay accepts is remembered.
FINGERPRINTS = ["safari", "safari_ios", "chrome", "firefox", "edge"]
CACHE_TTL = 600

_good_fp = FINGERPRINTS[0]
_cache: dict[str, tuple[float, int, str]] = {}


def fetch_ebay(url: str, allow_redirects=True):
    global _good_fp
    order = [_good_fp] + [f for f in FINGERPRINTS if f != _good_fp]
    last = None
    for fp in order:
        try:
            r = requests.get(url, impersonate=fp, timeout=15, allow_redirects=allow_redirects)
        except Exception as e:  # network error: try the next fingerprint
            last = e
            continue
        if r.status_code != 403:
            _good_fp = fp
            return r
        last = r
    if isinstance(last, Exception):
        raise last
    return last


def trim(html: str) -> str:
    title = re.search(r"<title>([^<]*)", html)
    metas = [
        m for m in re.findall(r"<meta [^>]*>", html)
        if '\\"' not in m and re.search(r"og:|twitter:", m)
    ]
    lds = re.findall(r"<script[^>]+application/ld\+json[^>]*>[\s\S]*?</script>", html)
    return (
        "<!doctype html><html><head>\n"
        f"<title>{title.group(1) if title else ''}</title>\n"
        + "\n".join(metas) + "\n" + "\n".join(lds)
        + "\n</head><body></body></html>\n"
    )


def get_item(item_id: str):
    hit = _cache.get(item_id)
    if hit and hit[0] > time.time():
        return hit[1], hit[2]
    r = fetch_ebay(f"https://www.ebay.com/itm/{item_id}")
    body = trim(r.text) if r.status_code == 200 else ""
    if r.status_code == 200:
        _cache[item_id] = (time.time() + CACHE_TTL, 200, body)
    return r.status_code, body


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body, ctype="text/plain; charset=utf-8"):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self.send(200, "ok")
        if not TOKEN or self.headers.get("authorization") != f"Bearer {TOKEN}":
            return self.send(401, "unauthorized")

        m = re.fullmatch(r"/item/(\d{9,15})", self.path)
        if m:
            try:
                status, body = get_item(m.group(1))
            except Exception as e:
                return self.send(502, f"fetch failed: {e}")
            if status != 200:
                return self.send(502, f"ebay returned {status}")
            return self.send(200, body, "text/html; charset=utf-8")

        m = re.fullmatch(r"/short/((?:m/)?[A-Za-z0-9]{4,12})", self.path)
        if m:
            try:
                r = fetch_ebay(f"https://ebay.us/{m.group(1)}", allow_redirects=False)
            except Exception as e:
                return self.send(502, f"fetch failed: {e}")
            loc = r.headers.get("location")
            if not loc:
                return self.send(404, "no redirect")
            return self.send(200, json.dumps({"location": loc}), "application/json")

        self.send(404, "not found")

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("Set FETCHER_TOKEN to a long random string first.")
    print(f"fxebay fetcher on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
