"""Transport-neutral API: the /api/* and /healthz logic, usable without an HTTP server.

Both front doors call `Api.handle(Request) -> Response`:
  * boardle_backend/server.py   -- the local `python3 serve.py` (http.server)
  * aws/lambda_handler.py       -- AWS Lambda Function URL behind CloudFront

Environment (all optional):
  BOARDLE_ALLOW_REGISTER     1/0 -- allow new accounts                 default 1
  BOARDLE_INVITE_CODE        if set, required to register
  BOARDLE_COOKIE_SECURE      1 = always mark the cookie Secure (set behind HTTPS)
  BOARDLE_SESSION_DAYS       session lifetime                         default 30
  BOARDLE_MAX_BODY           max request body bytes                   default 2000000
  BOARDLE_ALLOWED_ORIGINS    extra comma-separated origins accepted for writes,
                             e.g. "https://ch35s.com,https://www.ch35s.com"
"""
import hmac
import json
import os
import sys
import threading
import time
from http.cookies import SimpleCookie
from urllib.parse import urlsplit

from . import security
from .store_base import Conflict, make_store

COOKIE = "boardle_session"


def env_flag(name, default):
    v = os.environ.get(name)
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "on")


class RateLimiter:
    """Tiny in-memory failed-login limiter: N failures per window per key.

    In a long-running server this is exact. On Lambda each warm container has its own
    copy, so it is best-effort there; the DynamoDB store provides a shared limiter
    (DynamoRateLimiter) that the Lambda handler uses instead.
    """

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


class Headers:
    """Case-insensitive, read-only header lookup."""

    def __init__(self, items=None):
        self._d = {}
        for k, v in (items.items() if isinstance(items, dict) else (items or [])):
            if v is None:
                continue
            self._d[str(k).lower()] = str(v)

    def get(self, name, default=None):
        return self._d.get(name.lower(), default)

    def __contains__(self, name):
        return name.lower() in self._d


class Request:
    def __init__(self, method, path, headers=None, body=b"", client_ip="", secure=False):
        self.method = method.upper()
        self.path = path
        self.headers = headers if isinstance(headers, Headers) else Headers(headers)
        self.body = body or b""
        self.client_ip = client_ip or ""
        self.secure = secure  # request arrived over HTTPS (per the front door)


class Response:
    def __init__(self, status, obj, cookies=()):
        self.status = status
        self.obj = obj
        self.cookies = list(cookies)
        self.headers = {"Content-Type": "application/json", "Cache-Control": "no-store",
                        "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin"}

    @property
    def body(self):
        return json.dumps(self.obj).encode("utf-8")


def _err(code, msg, **extra):
    return Response(code, {"error": msg, **extra})


class Api:
    def __init__(self, store=None, limiter=None):
        self.store = store or make_store()
        self.allow_register = env_flag("BOARDLE_ALLOW_REGISTER", True)
        self.invite = os.environ.get("BOARDLE_INVITE_CODE", "")
        self.cookie_secure = env_flag("BOARDLE_COOKIE_SECURE", False)
        self.session_secs = int(float(os.environ.get("BOARDLE_SESSION_DAYS", "30")) * 86400)
        self.max_body = int(os.environ.get("BOARDLE_MAX_BODY", "2000000"))
        self.allowed_origins = {o.strip().rstrip("/").lower()
                                for o in os.environ.get("BOARDLE_ALLOWED_ORIGINS", "").split(",") if o.strip()}
        self.limiter = limiter or RateLimiter()

    # ---------- helpers ----------
    def _read_json(self, req):
        ctype = (req.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            raise ValueError("Content-Type must be application/json")
        if len(req.body) > self.max_body:
            raise OverflowError
        obj = json.loads(req.body.decode("utf-8") or "{}") if req.body else {}
        if not isinstance(obj, dict):
            raise ValueError("JSON object expected")
        return obj

    def _cookie(self, req, token, max_age):
        parts = [f"{COOKIE}={token}", "Path=/", "HttpOnly", "SameSite=Lax", f"Max-Age={max_age}"]
        if self.cookie_secure or req.secure or (req.headers.get("X-Forwarded-Proto", "").lower() == "https"):
            parts.append("Secure")
        return "; ".join(parts)

    @staticmethod
    def _token(req):
        raw = req.headers.get("Cookie")
        if not raw:
            return None
        try:
            c = SimpleCookie(raw)
        except Exception:
            return None
        return c[COOKIE].value if COOKIE in c else None

    def _current_user(self, req):
        tok = self._token(req)
        if not tok:
            return None
        return self.store.get_session(security.token_hash(tok), time.time())

    def same_origin(self, req):
        origin = req.headers.get("Origin")
        if not origin:
            return True  # non-browser clients; browsers always send Origin on POST/PUT/DELETE
        if origin.rstrip("/").lower() in self.allowed_origins:
            return True
        host = req.headers.get("X-Forwarded-Host") or req.headers.get("Host") or ""
        return urlsplit(origin).netloc.lower() == host.lower()

    def _start_session(self, req, username):
        tok = security.new_session_token()
        self.store.create_session(security.token_hash(tok), username, time.time() + self.session_secs)
        return self._cookie(req, tok, self.session_secs)

    # ---------- dispatch ----------
    @staticmethod
    def too_large():
        return _err(413, "Request too large.")

    def handle(self, req):
        path = req.path.split("?", 1)[0]
        method = req.method
        if path == "/healthz" and method in ("GET", "HEAD"):
            return Response(200, {"ok": True})
        if not path.startswith("/api/"):
            return _err(404, "Not found")
        try:
            if method != "GET":
                # CSRF defence: JSON content type (forces CORS preflight cross-site) + Origin check
                if not self.same_origin(req):
                    return _err(403, "Cross-origin request refused.")
            route = (method, path.rstrip("/"))
            fn = {
                ("GET", "/api/me"): self._me,
                ("POST", "/api/register"): self._register,
                ("POST", "/api/login"): self._login,
                ("POST", "/api/logout"): self._logout,
                ("GET", "/api/history"): self._get_history,
                ("PUT", "/api/history"): self._put_history,
            }.get(route)
            if fn is None:
                return _err(404, "Not found")
            return fn(req)
        except OverflowError:
            return _err(413, "Request too large.")
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as e:
            return _err(400, str(e) or "Bad request")
        except Exception as e:  # pragma: no cover - logged for operators
            sys.stderr.write(f"API error {method} {path}: {e!r}\n")
            return _err(500, "Server error")

    # ---------- endpoints ----------
    def _me(self, req):
        user = self._current_user(req)
        info = None
        if user:
            u = self.store.get_user(user)
            info = {"username": user, "created": u and u.get("created_at")}
        return Response(200, {"server": True, "user": info, "registration": self.allow_register,
                              "inviteRequired": bool(self.invite)})

    def _register(self, req):
        body = self._read_json(req)
        if not self.allow_register:
            return _err(403, "Registration is closed on this server.")
        if self.invite and not hmac.compare_digest(str(body.get("invite", "")), self.invite):
            return _err(403, "Invite code is required / incorrect.")
        username = security.normalize_username(body.get("username"))
        password = body.get("password")
        msg = security.validate_credentials(username, password)
        if msg:
            return _err(400, msg)
        if not self.store.create_user(username, security.hash_password(password), time.time()):
            return _err(409, "That username is taken.")
        return Response(201, {"user": {"username": username}}, cookies=[self._start_session(req, username)])

    def _login(self, req):
        body = self._read_json(req)
        username = security.normalize_username(body.get("username"))
        password = body.get("password") if isinstance(body.get("password"), str) else ""
        key = f"{req.client_ip}|{username}"
        if self.limiter.blocked(key):
            return _err(429, "Too many attempts. Try again in a few minutes.")
        u = self.store.get_user(username) if username else None
        ok = security.verify_password(password, u["pw_hash"] if u else security.DUMMY_HASH) and u is not None
        if not ok:
            self.limiter.fail(key)
            return _err(401, "Wrong username or password.")
        self.limiter.clear(key)
        return Response(200, {"user": {"username": username}}, cookies=[self._start_session(req, username)])

    def _logout(self, req):
        tok = self._token(req)
        if tok:
            self.store.delete_session(security.token_hash(tok))
        return Response(200, {"ok": True}, cookies=[self._cookie(req, "", 0)])

    def _get_history(self, req):
        user = self._current_user(req)
        if not user:
            return _err(401, "Sign in first.")
        data, rev, updated = self.store.get_history(user)
        return Response(200, {"data": data, "rev": rev, "updatedAt": updated})

    def _put_history(self, req):
        user = self._current_user(req)
        if not user:
            return _err(401, "Sign in first.")
        body = self._read_json(req)
        data = body.get("data")
        if not isinstance(data, dict):
            return _err(400, "data must be an object")
        data = {k: v for k, v in data.items() if isinstance(k, str) and k.startswith("boardle:")}
        try:
            base = int(body.get("baseRev", 0))
        except (TypeError, ValueError):
            return _err(400, "baseRev must be an integer")
        try:
            rev = self.store.put_history(user, data, base, time.time())
        except Conflict as c:
            return Response(409, {"error": "conflict", "data": c.data, "rev": c.rev, "updatedAt": c.updated_at})
        return Response(200, {"rev": rev})
