"""AWS Lambda entry point for the Boardle API (Function URL behind CloudFront).

Handler: lambda_handler.handler   (deploy.sh puts this file at the zip root next to
boardle_backend/). It reuses boardle_backend.api.Api -- the exact code `python3 serve.py`
runs locally -- and only translates the event/response shapes:

  Function URL event (payload v2.0)          ->  api.Request
      requestContext.http.method / rawPath / headers / cookies[] / body (+isBase64Encoded)
  api.Response                               ->  {"statusCode", "headers", "cookies": [...], "body"}
      (each Set-Cookie goes in the `cookies` list; Function URLs emit one header per entry)

Environment (set by deploy.sh):
  BOARDLE_STORAGE=dynamodb, BOARDLE_DDB_TABLE=<table>   storage (see boardle_backend/store_dynamodb.py)
  BOARDLE_COOKIE_SECURE=1                               cookies are always Secure here anyway
  BOARDLE_ALLOWED_ORIGINS=https://ch35s.com,https://www.ch35s.com
  BOARDLE_ORIGIN_VERIFY=<random secret>                 CloudFront adds header X-Origin-Verify with this
                                                        value; requests without it (i.e. anyone calling
                                                        the raw *.lambda-url.* address) get 403.
                                                        Comma-separate two values to rotate without downtime.
  BOARDLE_RATE_LIMIT=dynamodb|memory                     default dynamodb when storage is DynamoDB

Same-origin check: CloudFront replaces Host with the Lambda URL host (managed origin request
policy AllViewerExceptHostHeader), so the browser's Origin (https://ch35s.com) is matched
against BOARDLE_ALLOWED_ORIGINS instead.
"""
import base64
import hmac
import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
for _p in (_here, os.path.dirname(_here)):  # zip root on Lambda; personal/ when run from the repo
    if os.path.isdir(os.path.join(_p, "boardle_backend")) and _p not in sys.path:
        sys.path.insert(0, _p)

from boardle_backend.api import Api, Headers, Request, Response  # noqa: E402
from boardle_backend.store_base import make_store  # noqa: E402

VERIFY_HEADER = "x-origin-verify"
_api = None


def build_api(store=None):
    """Create the Api with DynamoDB-backed rate limiting when available."""
    store = store or make_store()
    limiter = None
    table = getattr(store, "table", None)
    if table is not None and os.environ.get("BOARDLE_RATE_LIMIT", "dynamodb").lower() != "memory":
        from boardle_backend.store_dynamodb import DynamoRateLimiter
        limiter = DynamoRateLimiter(table)
    return Api(store=store, limiter=limiter)


def get_api():
    global _api
    if _api is None:  # once per warm container
        _api = build_api()
    return _api


def _secrets():
    return [s.strip() for s in os.environ.get("BOARDLE_ORIGIN_VERIFY", "").split(",") if s.strip()]


def _verified(headers):
    secrets = _secrets()
    if not secrets:
        return True  # check disabled (local tests / not yet configured)
    got = headers.get(VERIFY_HEADER) or ""
    return any(hmac.compare_digest(got.encode(), s.encode()) for s in secrets)


def _client_ip(headers, ctx_http):
    # CloudFront-Viewer-Address is "ip:port" (IPv6 too, port is after the last colon);
    # CloudFront sets it itself, so the viewer cannot spoof it.
    addr = headers.get("cloudfront-viewer-address")
    if addr and ":" in addr:
        return addr.rsplit(":", 1)[0].strip("[]")
    fwd = headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return ctx_http.get("sourceIp", "")


def to_request(event):
    ctx_http = (event.get("requestContext") or {}).get("http") or {}
    method = ctx_http.get("method") or event.get("httpMethod") or "GET"
    path = event.get("rawPath") or ctx_http.get("path") or event.get("path") or "/"
    raw_headers = dict(event.get("headers") or {})
    cookies = event.get("cookies")
    if cookies:  # payload v2.0 moves Cookie headers into a list
        raw_headers["cookie"] = "; ".join(cookies)
    headers = Headers(raw_headers)
    body = event.get("body") or ""
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body)
    elif isinstance(body, str):
        body = body.encode("utf-8")
    return Request(method, path, headers=headers, body=body,
                   client_ip=_client_ip(headers, ctx_http), secure=True), headers


def to_event_response(resp):
    out = {
        "statusCode": resp.status,
        "headers": dict(resp.headers),
        "body": resp.body.decode("utf-8"),
        "isBase64Encoded": False,
    }
    if resp.cookies:
        out["cookies"] = list(resp.cookies)
    return out


def handler(event, context=None):
    req, headers = to_request(event)
    if not _verified(headers):
        return to_event_response(Response(403, {"error": "Forbidden"}))
    api = get_api()
    if len(req.body) > api.max_body:
        return to_event_response(api.too_large())
    if req.method == "HEAD":
        resp = api.handle(req)
        out = to_event_response(resp)
        out["body"] = ""
        return out
    return to_event_response(api.handle(req))
