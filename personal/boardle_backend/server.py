"""HTTP server: serves the static app and the /api endpoints.

    python3 serve.py [port]            # http://localhost:8000, SQLite at ~/.boardle/boardle.sqlite3

Environment (all optional):
  PORT / BOARDLE_PORT        listen port (CLI argument wins)          default 8000
  BOARDLE_HOST               bind address                             default "" (all interfaces)
  BOARDLE_STORAGE            sqlite | dynamodb                        default sqlite
  BOARDLE_DB_PATH            SQLite file                              default ~/.boardle/boardle.sqlite3
  BOARDLE_DDB_TABLE          DynamoDB table name                      default boardle
  AWS_REGION                 DynamoDB region
  API settings (BOARDLE_ALLOW_REGISTER, BOARDLE_INVITE_CODE, BOARDLE_COOKIE_SECURE,
  BOARDLE_SESSION_DAYS, BOARDLE_MAX_BODY, BOARDLE_ALLOWED_ORIGINS): see api.py.
The API logic itself lives in api.py so aws/lambda_handler.py can reuse it unchanged.
"""
import http.server
import os
import sys
from urllib.parse import urlsplit

from .api import COOKIE, Api, Request, RateLimiter, env_flag  # noqa: F401  (re-exported)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Never served as static files (backend code, local data, tooling, dotfiles)
BLOCKED_PREFIXES = ("/boardle_backend", "/tests", "/tools", "/data", "/node_modules", "/aws")
BLOCKED_SUFFIXES = (".py", ".pyc", ".sqlite3", ".sqlite", ".db", ".patch", ".zip", ".env", "Dockerfile", ".txt", ".sh")


class App(Api):
    """The API plus the static root it is served next to."""

    def __init__(self, store=None, root=ROOT):
        super().__init__(store=store)
        self.root = root


def make_handler(app: App):
    class Handler(http.server.SimpleHTTPRequestHandler):
        server_version = "Boardle/3"
        extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                          ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
                          ".svg": "image/svg+xml", ".md": "text/plain; charset=utf-8"}

        def __init__(self, *a, **kw):
            super().__init__(*a, directory=app.root, **kw)

        def log_message(self, fmt, *args):
            if os.environ.get("BOARDLE_QUIET") != "1":
                super().log_message(fmt, *args)

        # ---------- routing ----------
        def do_GET(self):
            path = urlsplit(self.path).path
            if path == "/healthz" or path.startswith("/api/"):
                return self._api("GET", path)
            if self._blocked(path):
                return self.send_error(404)
            return super().do_GET()

        def do_HEAD(self):
            path = urlsplit(self.path).path
            if path.startswith("/api/") or self._blocked(path):
                return self.send_error(404)
            return super().do_HEAD()

        def do_POST(self):
            self._api("POST", urlsplit(self.path).path)

        def do_PUT(self):
            self._api("PUT", urlsplit(self.path).path)

        def do_DELETE(self):
            self._api("DELETE", urlsplit(self.path).path)

        def end_headers(self):
            if not getattr(self, "_api_response", False):
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Referrer-Policy", "same-origin")
                # Static files: always revalidate (cheap 304s via Last-Modified). Without this,
                # browsers cache heuristically and can mix old + new modules after an update.
                self.send_header("Cache-Control", "no-store" if urlsplit(self.path).path.startswith("/api/") else "no-cache")
            super().end_headers()

        def _blocked(self, path):
            p = path.rstrip("/") or "/"
            if any(seg.startswith(".") for seg in p.split("/") if seg):
                return True
            if any(p == b or p.startswith(b + "/") for b in BLOCKED_PREFIXES):
                return True
            return p.endswith(BLOCKED_SUFFIXES)

        def _client_ip(self):
            fwd = self.headers.get("X-Forwarded-For")
            return fwd.split(",")[0].strip() if fwd else self.client_address[0]

        # ---------- API: adapt http.server <-> boardle_backend.api ----------
        def _api(self, method, path):
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            if n > app.max_body:
                return self._send(app.too_large())
            body = self.rfile.read(n) if n > 0 else b""
            req = Request(method, path, headers=list(self.headers.items()), body=body,
                          client_ip=self._client_ip(), secure=False)
            self._send(app.handle(req))

        def _send(self, resp):
            body = resp.body
            self._api_response = True
            self.send_response(resp.status)
            for k, v in resp.headers.items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(body)))
            for c in resp.cookies:
                self.send_header("Set-Cookie", c)
            self.end_headers()
            self._api_response = False  # handler objects are reused across keep-alive requests
            self.wfile.write(body)

    return Handler


def make_server(port=8000, host="", store=None, root=ROOT):
    app = App(store=store, root=root)
    httpd = http.server.ThreadingHTTPServer((host, port), make_handler(app))
    httpd.daemon_threads = True
    httpd.app = app
    return httpd


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    port = int(argv[0]) if argv else int(os.environ.get("BOARDLE_PORT") or os.environ.get("PORT") or 8000)
    host = os.environ.get("BOARDLE_HOST", "")
    httpd = make_server(port, host)
    st = httpd.app.store
    where = getattr(st, "path", None) or f"DynamoDB table {getattr(getattr(st, 'table', None), 'name', '?')}"
    print(f"Boardle running at http://localhost:{port}  (Ctrl+C to stop)")
    print(f"Profiles/history storage: {where}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
