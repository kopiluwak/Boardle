"""HTTP server: serves the static app and the /api endpoints.

    python3 serve.py [port]            # http://localhost:8000, SQLite at ~/.boardle/boardle.sqlite3

Environment (all optional):
  PORT / BOARDLE_PORT        listen port (CLI argument wins)          default 8000
  BOARDLE_HOST               bind address                             default "" (all interfaces)
  BOARDLE_STORAGE            sqlite | dynamodb                        default sqlite
  BOARDLE_DB_PATH            SQLite file                              default ~/.boardle/boardle.sqlite3
  BOARDLE_DDB_TABLE          DynamoDB table name                      default boardle
  AWS_REGION                 DynamoDB region
  BOARDLE_ALLOW_REGISTER     1/0 — allow new accounts                 default 1
  BOARDLE_INVITE_CODE        if set, required to register
  BOARDLE_COOKIE_SECURE      1 = always mark the cookie Secure (set behind HTTPS)
  BOARDLE_SESSION_DAYS       session lifetime                         default 30
  BOARDLE_MAX_BODY           max request body bytes                   default 2000000
"""
import functools
import hmac
import http.server
import json
import os
import sys
import threading
import time
from http.cookies import SimpleCookie
from urllib.parse import urlsplit

from . import security
from .store_base import Conflict, make_store

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COOKIE = "boardle_session"
# Never served as static files (backend code, local data, tooling, dotfiles)
BLOCKED_PREFIXES = ("/boardle_backend", "/tests", "/tools", "/data", "/node_modules")
BLOCKED_SUFFIXES = (".py", ".pyc", ".sqlite3", ".sqlite", ".db", ".patch", ".zip", ".env", "Dockerfile", ".txt")


def env_flag(name, default):
    v = os.environ.get(name)
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "on")


class RateLimiter:
    """Tiny in-memory failed-login limiter: N failures per window per key."""

    def __init__(self, limit=10, window=900):
        self.limit, self.window = limit, window
        self.hits = {}
        self.lock = threading.Lock()

    def blocked(self, key):
        now = time.time()
        with self.lock:
            hits = [t for t in self.hits.get(key, []) if now - t < self.window]
            self.hits[key] = hits
            return len(hits) >= self.limit

    def fail(self, key):
        with self.lock:
            self.hits.setdefault(key, []).append(time.time())

    def clear(self, key):
        with self.lock:
            self.hits.pop(key, None)


class App:
    def __init__(self, store=None, root=ROOT):
        self.store = store or make_store()
        self.root = root
        self.allow_register = env_flag("BOARDLE_ALLOW_REGISTER", True)
        self.invite = os.environ.get("BOARDLE_INVITE_CODE", "")
        self.cookie_secure = env_flag("BOARDLE_COOKIE_SECURE", False)
        self.session_secs = int(float(os.environ.get("BOARDLE_SESSION_DAYS", "30")) * 86400)
        self.max_body = int(os.environ.get("BOARDLE_MAX_BODY", "2000000"))
        self.limiter = RateLimiter()


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
            if path == "/healthz":
                return self._json(200, {"ok": True})
            if path.startswith("/api/"):
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
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "same-origin")
            if urlsplit(self.path).path.startswith("/api/"):
                self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def _blocked(self, path):
            p = path.rstrip("/") or "/"
            if any(seg.startswith(".") for seg in p.split("/") if seg):
                return True
            if any(p == b or p.startswith(b + "/") for b in BLOCKED_PREFIXES):
                return True
            return p.endswith(BLOCKED_SUFFIXES)

        # ---------- helpers ----------
        def _json(self, code, obj, cookies=()):
            body = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            for c in cookies:
                self.send_header("Set-Cookie", c)
            self.end_headers()
            self.wfile.write(body)

        def _err(self, code, msg, **extra):
            self._json(code, {"error": msg, **extra})

        def _read_json(self):
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype != "application/json":
                raise ValueError("Content-Type must be application/json")
            n = int(self.headers.get("Content-Length") or 0)
            if n > app.max_body:
                raise OverflowError
            raw = self.rfile.read(n) if n else b"{}"
            obj = json.loads(raw.decode("utf-8") or "{}")
            if not isinstance(obj, dict):
                raise ValueError("JSON object expected")
            return obj

        def _secure(self):
            return app.cookie_secure or (self.headers.get("X-Forwarded-Proto", "").lower() == "https")

        def _cookie(self, token, max_age):
            parts = [f"{COOKIE}={token}", "Path=/", "HttpOnly", "SameSite=Lax", f"Max-Age={max_age}"]
            if self._secure():
                parts.append("Secure")
            return "; ".join(parts)

        def _token(self):
            raw = self.headers.get("Cookie")
            if not raw:
                return None
            try:
                c = SimpleCookie(raw)
            except Exception:
                return None
            return c[COOKIE].value if COOKIE in c else None

        def _current_user(self):
            tok = self._token()
            if not tok:
                return None
            return app.store.get_session(security.token_hash(tok), time.time())

        def _same_origin(self):
            origin = self.headers.get("Origin")
            if not origin:
                return True  # non-browser clients / same-origin GET-less fetches
            host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or ""
            return urlsplit(origin).netloc.lower() == host.lower()

        def _client_ip(self):
            fwd = self.headers.get("X-Forwarded-For")
            return fwd.split(",")[0].strip() if fwd else self.client_address[0]

        def _start_session(self, username):
            tok = security.new_session_token()
            app.store.create_session(security.token_hash(tok), username, time.time() + app.session_secs)
            return self._cookie(tok, app.session_secs)

        # ---------- API ----------
        def _api(self, method, path):
            try:
                if method != "GET":
                    # CSRF defence: JSON content type (forces CORS preflight cross-site) + Origin check
                    if not self._same_origin():
                        return self._err(403, "Cross-origin request refused.")
                route = (method, path.rstrip("/"))
                if route == ("GET", "/api/me"):
                    return self._me()
                if route == ("POST", "/api/register"):
                    return self._register()
                if route == ("POST", "/api/login"):
                    return self._login()
                if route == ("POST", "/api/logout"):
                    return self._logout()
                if route == ("GET", "/api/history"):
                    return self._get_history()
                if route == ("PUT", "/api/history"):
                    return self._put_history()
                return self._err(404, "Not found")
            except OverflowError:
                return self._err(413, "Request too large.")
            except (ValueError, json.JSONDecodeError) as e:
                return self._err(400, str(e) or "Bad request")
            except Exception as e:  # pragma: no cover - logged for operators
                sys.stderr.write(f"API error {method} {path}: {e!r}\n")
                return self._err(500, "Server error")

        def _me(self):
            user = self._current_user()
            info = None
            if user:
                u = app.store.get_user(user)
                info = {"username": user, "created": u and u.get("created_at")}
            self._json(200, {"server": True, "user": info, "registration": app.allow_register,
                             "inviteRequired": bool(app.invite)})

        def _register(self):
            body = self._read_json()
            if not app.allow_register:
                return self._err(403, "Registration is closed on this server.")
            if app.invite and not hmac.compare_digest(str(body.get("invite", "")), app.invite):
                return self._err(403, "Invite code is required / incorrect.")
            username = security.normalize_username(body.get("username"))
            password = body.get("password")
            msg = security.validate_credentials(username, password)
            if msg:
                return self._err(400, msg)
            if not app.store.create_user(username, security.hash_password(password), time.time()):
                return self._err(409, "That username is taken.")
            cookie = self._start_session(username)
            self._json(201, {"user": {"username": username}}, cookies=[cookie])

        def _login(self):
            body = self._read_json()
            username = security.normalize_username(body.get("username"))
            password = body.get("password") if isinstance(body.get("password"), str) else ""
            key = f"{self._client_ip()}|{username}"
            if app.limiter.blocked(key):
                return self._err(429, "Too many attempts. Try again in a few minutes.")
            u = app.store.get_user(username) if username else None
            ok = security.verify_password(password, u["pw_hash"] if u else security.DUMMY_HASH) and u is not None
            if not ok:
                app.limiter.fail(key)
                return self._err(401, "Wrong username or password.")
            app.limiter.clear(key)
            cookie = self._start_session(username)
            self._json(200, {"user": {"username": username}}, cookies=[cookie])

        def _logout(self):
            tok = self._token()
            if tok:
                app.store.delete_session(security.token_hash(tok))
            self._json(200, {"ok": True}, cookies=[self._cookie("", 0)])

        def _get_history(self):
            user = self._current_user()
            if not user:
                return self._err(401, "Sign in first.")
            data, rev, updated = app.store.get_history(user)
            self._json(200, {"data": data, "rev": rev, "updatedAt": updated})

        def _put_history(self):
            user = self._current_user()
            if not user:
                return self._err(401, "Sign in first.")
            body = self._read_json()
            data = body.get("data")
            if not isinstance(data, dict):
                return self._err(400, "data must be an object")
            data = {k: v for k, v in data.items() if isinstance(k, str) and k.startswith("boardle:")}
            try:
                base = int(body.get("baseRev", 0))
            except (TypeError, ValueError):
                return self._err(400, "baseRev must be an integer")
            try:
                rev = app.store.put_history(user, data, base, time.time())
            except Conflict as c:
                return self._json(409, {"error": "conflict", "data": c.data, "rev": c.rev, "updatedAt": c.updated_at})
            self._json(200, {"rev": rev})

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
