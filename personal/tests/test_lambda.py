"""Tests for aws/lambda_handler.py with simulated Function URL (payload v2.0) events.

Runs against DynamoDB under moto when boto3+moto are installed (pip install boto3
'moto[dynamodb]'), otherwise against an in-memory SQLite store (rate limiter then
falls back to the in-memory one).
"""
import base64
import json
import os
import sys
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
PERSONAL = os.path.dirname(HERE)
sys.path.insert(0, PERSONAL)
sys.path.insert(0, os.path.join(PERSONAL, "aws"))

import lambda_handler as lh  # noqa: E402
from boardle_backend.store_sqlite import SqliteStore  # noqa: E402

try:
    import boto3  # noqa: F401
    from moto import mock_aws
    HAVE_MOTO = True
except Exception:  # pragma: no cover
    HAVE_MOTO = False

SECRET = "s3cr3t-verify-value"
ENV = {
    "BOARDLE_ORIGIN_VERIFY": SECRET,
    "BOARDLE_ALLOWED_ORIGINS": "https://ch35s.com,https://www.ch35s.com",
    "BOARDLE_COOKIE_SECURE": "1",
    "AWS_ACCESS_KEY_ID": "test", "AWS_SECRET_ACCESS_KEY": "test", "AWS_DEFAULT_REGION": "us-east-1",
}


def event(method, path, body=None, cookies=None, origin="https://ch35s.com", verify=SECRET, b64=False,
          headers=None, ip="203.0.113.7"):
    h = {"host": "abc123.lambda-url.us-east-1.on.aws", "x-boardle-client": "1",
         "cloudfront-viewer-address": f"{ip}:51234", "x-forwarded-for": f"{ip}, 130.176.0.1"}
    if verify is not None:
        h["x-origin-verify"] = verify
    if origin:
        h["origin"] = origin
    raw = None
    if body is not None:
        h["content-type"] = "application/json"
        raw = json.dumps(body)
        if b64:
            raw = base64.b64encode(raw.encode()).decode()
    h.update(headers or {})
    ev = {"version": "2.0", "routeKey": "$default", "rawPath": path, "rawQueryString": "", "headers": h,
          "requestContext": {"http": {"method": method, "path": path, "sourceIp": "130.176.0.1"}},
          "isBase64Encoded": b64}
    if raw is not None:
        ev["body"] = raw
    if cookies:
        ev["cookies"] = cookies
    return ev


def call(*a, **kw):
    r = lh.handler(event(*a, **kw), None)
    return r["statusCode"], (json.loads(r["body"]) if r["body"] else None), r


def session_cookie(resp):
    """Browser behaviour: keep only name=value of the boardle cookie."""
    for c in resp.get("cookies", []):
        nv = c.split(";", 1)[0]
        if nv.startswith("boardle_session="):
            return [nv] if nv != "boardle_session=" else []
    return None


class LambdaAdapterBase:
    def make_store(self):  # overridden
        raise NotImplementedError

    def setUp(self):
        self.env = mock.patch.dict(os.environ, ENV)
        self.env.start()
        self.store = self.make_store()
        lh._api = lh.build_api(self.store)

    def tearDown(self):
        lh._api = None
        self.env.stop()

    def test_origin_verify_header_required(self):
        s, body, _ = call("GET", "/healthz", verify=None)
        self.assertEqual(s, 403)
        s, _, _ = call("GET", "/api/me", verify="wrong")
        self.assertEqual(s, 403)
        s, body, r = call("GET", "/healthz")
        self.assertEqual((s, body), (200, {"ok": True}))
        self.assertEqual(r["headers"]["Cache-Control"], "no-store")
        self.assertEqual(call("GET", "/index.html")[0], 404)  # static files are S3's job

    def test_secret_rotation(self):
        with mock.patch.dict(os.environ, {"BOARDLE_ORIGIN_VERIFY": "new-one, " + SECRET}):
            self.assertEqual(call("GET", "/healthz", verify="new-one")[0], 200)
            self.assertEqual(call("GET", "/healthz")[0], 200)

    def test_register_login_history_cookies(self):
        s, body, r = call("POST", "/api/register", {"username": "Pete", "password": "correct horse"})
        self.assertEqual(s, 201, body)
        self.assertEqual(body["user"]["username"], "pete")
        self.assertNotIn("Set-Cookie", r["headers"])
        (cookie,) = r["cookies"]
        for attr in ("HttpOnly", "SameSite=Lax", "Path=/", "Secure"):
            self.assertIn(attr, cookie)
        jar = session_cookie(r)

        s, body, _ = call("GET", "/api/me", cookies=jar + ["other=1"])
        self.assertEqual(body["user"]["username"], "pete")
        self.assertIsNone(call("GET", "/api/me")[1]["user"])

        data = {"boardle:stats:classic": {"played": 4}, "junk": 1}
        s, body, _ = call("PUT", "/api/history", {"data": data, "baseRev": 0}, cookies=jar, b64=True)
        self.assertEqual((s, body), (200, {"rev": 1}))
        s, body, _ = call("GET", "/api/history", cookies=jar)
        self.assertEqual(body["data"], {"boardle:stats:classic": {"played": 4}})
        s, body, _ = call("PUT", "/api/history", {"data": data, "baseRev": 0}, cookies=jar)
        self.assertEqual((s, body["rev"]), (409, 1))

        # second device logs in; first device logs out
        s, body, r2 = call("POST", "/api/login", {"username": "pete", "password": "correct horse"},
                           origin="https://www.ch35s.com")
        self.assertEqual(s, 200, body)
        jar2 = session_cookie(r2)
        s, body, r3 = call("POST", "/api/logout", {}, cookies=jar)
        self.assertEqual(s, 200)
        self.assertIn("Max-Age=0", r3["cookies"][0])
        self.assertEqual(call("GET", "/api/history", cookies=jar)[0], 401)
        self.assertEqual(call("GET", "/api/history", cookies=jar2)[0], 200)

    def test_same_origin(self):
        body = {"username": "x1x", "password": "whatever123"}
        self.assertEqual(call("POST", "/api/login", body, origin="https://evil.example")[0], 403)
        self.assertEqual(call("POST", "/api/login", body, origin="http://ch35s.com")[0], 403)
        # X-Forwarded-Host path (other proxies) still works
        s, _, _ = call("POST", "/api/login", body, origin="https://proxy.example",
                       headers={"x-forwarded-host": "proxy.example"})
        self.assertEqual(s, 401)
        # form posts refused
        ev = event("POST", "/api/login")
        ev["headers"]["content-type"] = "application/x-www-form-urlencoded"
        ev["body"] = "username=a&password=b"
        self.assertEqual(lh.handler(ev)["statusCode"], 400)

    def test_body_limit(self):
        with mock.patch.dict(os.environ, {"BOARDLE_MAX_BODY": "100"}):
            lh._api = lh.build_api(self.store)
            s, _, _ = call("POST", "/api/register", {"username": "bigbig", "password": "x" * 200})
            self.assertEqual(s, 413)

    def test_rate_limit_uses_viewer_ip(self):
        call("POST", "/api/register", {"username": "dave", "password": "longenough1"})
        bad = {"username": "dave", "password": "nope-nope"}
        codes = [call("POST", "/api/login", bad)[0] for _ in range(11)]
        self.assertEqual(codes[:10], [401] * 10)
        self.assertEqual(codes[10], 429)
        # a different viewer is not affected (key is viewer IP + username)
        self.assertEqual(call("POST", "/api/login", bad, ip="198.51.100.9")[0], 401)

    def test_client_ip_parsing(self):
        self.assertEqual(lh._client_ip(lh.Headers({"cloudfront-viewer-address": "2001:db8::1:443"}), {}), "2001:db8::1")
        self.assertEqual(lh._client_ip(lh.Headers({"x-forwarded-for": "1.2.3.4, 5.6.7.8"}), {}), "1.2.3.4")
        self.assertEqual(lh._client_ip(lh.Headers({}), {"sourceIp": "9.9.9.9"}), "9.9.9.9")


class LambdaSqliteTest(LambdaAdapterBase, unittest.TestCase):
    def make_store(self):
        return SqliteStore(":memory:")


@unittest.skipUnless(HAVE_MOTO, "boto3 + moto not installed")
class LambdaDynamoTest(LambdaAdapterBase, unittest.TestCase):
    def make_store(self):
        self.moto = mock_aws()
        self.moto.start()
        self.addCleanup(self.moto.stop)
        from boardle_backend.store_dynamodb import DynamoStore, create_table
        create_table("boardle-lambda-test", region="us-east-1")
        return DynamoStore("boardle-lambda-test", region="us-east-1")

    def test_uses_dynamo_rate_limiter(self):
        from boardle_backend.store_dynamodb import DynamoRateLimiter
        self.assertIsInstance(lh._api.limiter, DynamoRateLimiter)
        lim = lh._api.limiter
        for _ in range(10):
            lim.fail("k")
        self.assertTrue(lim.blocked("k"))
        lim.clear("k")
        self.assertFalse(lim.blocked("k"))
        it = self.store.table.scan()["Items"]
        self.assertFalse(any("k" == i["pk"][5:] for i in it))  # keys are hashed
        self.assertTrue(all(int(i.get("ttl", time.time() + 10)) > time.time() for i in it))


if __name__ == "__main__":
    unittest.main()
