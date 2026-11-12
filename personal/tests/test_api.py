"""python3 -m unittest discover -s tests   (run from personal/)

API tests against a real server on an ephemeral port with a temp SQLite DB,
plus the DynamoDB adapter under moto when boto3+moto are installed.
"""
import http.cookiejar
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.environ["BOARDLE_QUIET"] = "1"

from boardle_backend import security  # noqa: E402
from boardle_backend.server import make_server  # noqa: E402
from boardle_backend.store_base import Conflict  # noqa: E402
from boardle_backend.store_sqlite import SqliteStore  # noqa: E402


class Client:
    def __init__(self, base):
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, method, path, body=None, headers=None):
        data = None if body is None else json.dumps(body).encode()
        h = {"X-Boardle-Client": "1"}
        if body is not None:
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with self.opener.open(req) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if r.headers.get("Content-Type", "").startswith("application/json") else raw), r.headers
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                payload = json.loads(raw)
            except Exception:
                payload = raw
            return e.code, payload, e.headers


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.store = SqliteStore(os.path.join(cls.tmp.name, "t.sqlite3"))
        cls.httpd = make_server(0, "127.0.0.1", store=cls.store)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.store.close()
        cls.tmp.cleanup()

    def test_static_and_blocked(self):
        c = Client(self.base)
        s, body, h = c.call("GET", "/index.html")
        self.assertEqual(s, 200)
        self.assertIn(b"Boardle", body)
        s, body, h = c.call("GET", "/app.js")
        self.assertEqual(s, 200)
        self.assertTrue(h["Content-Type"].startswith("text/javascript"))
        # static files must revalidate so old cached modules can't mix with a new release
        self.assertEqual(h["Cache-Control"], "no-cache")
        s, _, h = c.call("GET", "/openings/data.js?v=3.1")
        self.assertEqual((s, h["Cache-Control"]), (200, "no-cache"))
        s, _, h = c.call("GET", "/api/me")
        self.assertEqual(h["Cache-Control"], "no-store")
        for p in ("/serve.py", "/boardle_backend/server.py", "/tests/test_api.py", "/.git/config", "/requirements.txt",
                  "/aws/deploy.sh", "/aws/lambda_handler.py", "/aws/README-DEPLOY.md"):
            s, _, _ = c.call("GET", p)
            self.assertEqual(s, 404, p)
        s, body, _ = c.call("GET", "/healthz")
        self.assertEqual((s, body), (200, {"ok": True}))

    def test_me_signed_out(self):
        s, body, _ = Client(self.base).call("GET", "/api/me")
        self.assertEqual(s, 200)
        self.assertTrue(body["server"])
        self.assertIsNone(body["user"])

    def test_register_login_and_isolation(self):
        a, b = Client(self.base), Client(self.base)
        s, body, h = a.call("POST", "/api/register", {"username": "Alice", "password": "correct horse"})
        self.assertEqual(s, 201, body)
        self.assertEqual(body["user"]["username"], "alice")
        cookie = h["Set-Cookie"]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Lax", cookie)
        s, body, _ = b.call("POST", "/api/register", {"username": "bob", "password": "hunter2hunter2"})
        self.assertEqual(s, 201, body)

        # duplicate + validation
        self.assertEqual(Client(self.base).call("POST", "/api/register", {"username": "alice", "password": "whatever123"})[0], 409)
        self.assertEqual(Client(self.base).call("POST", "/api/register", {"username": "x", "password": "whatever123"})[0], 400)
        self.assertEqual(Client(self.base).call("POST", "/api/register", {"username": "carol", "password": "short"})[0], 400)

        # Alice writes, Bob sees nothing of hers
        s, body, _ = a.call("GET", "/api/history")
        self.assertEqual((s, body["data"], body["rev"]), (200, {}, 0))
        alice_data = {"boardle:stats:classic": {"played": 3, "wins": 2}, "boardle:openings:tests": {"it-main": {"solved": 1}},
                      "not-a-boardle-key": 1}
        s, body, _ = a.call("PUT", "/api/history", {"data": alice_data, "baseRev": 0})
        self.assertEqual((s, body["rev"]), (200, 1))
        s, body, _ = b.call("GET", "/api/history")
        self.assertEqual(body["data"], {})
        s, body, _ = b.call("PUT", "/api/history", {"data": {"boardle:stats:mini": {"played": 1}}, "baseRev": 0})
        self.assertEqual(s, 200)
        s, body, _ = a.call("GET", "/api/history")
        self.assertEqual(body["rev"], 1)
        self.assertEqual(body["data"]["boardle:stats:classic"]["played"], 3)
        self.assertNotIn("not-a-boardle-key", body["data"])
        self.assertNotIn("boardle:stats:mini", body["data"])

        # stale revision → 409 with the server copy
        s, body, _ = a.call("PUT", "/api/history", {"data": {"boardle:x": 1}, "baseRev": 0})
        self.assertEqual(s, 409)
        self.assertEqual(body["rev"], 1)
        self.assertIn("boardle:stats:classic", body["data"])

        # login from a second "device"
        a2 = Client(self.base)
        self.assertEqual(a2.call("POST", "/api/login", {"username": "alice", "password": "wrong password"})[0], 401)
        self.assertEqual(a2.call("POST", "/api/login", {"username": "nobody", "password": "wrong password"})[0], 401)
        s, body, _ = a2.call("POST", "/api/login", {"username": "ALICE", "password": "correct horse"})
        self.assertEqual(s, 200)
        s, body, _ = a2.call("GET", "/api/me")
        self.assertEqual(body["user"]["username"], "alice")
        s, body, _ = a2.call("GET", "/api/history")
        self.assertEqual(body["data"]["boardle:openings:tests"]["it-main"]["solved"], 1)

        # logout invalidates only that session
        self.assertEqual(a2.call("POST", "/api/logout", {})[0], 200)
        self.assertEqual(a2.call("GET", "/api/history")[0], 401)
        self.assertEqual(a.call("GET", "/api/history")[0], 200)

    def test_requires_auth_and_json(self):
        c = Client(self.base)
        self.assertEqual(c.call("GET", "/api/history")[0], 401)
        self.assertEqual(c.call("PUT", "/api/history", {"data": {}, "baseRev": 0})[0], 401)
        # form-encoded / cross-origin writes refused
        req = urllib.request.Request(self.base + "/api/login", data=b"username=a&password=b", method="POST",
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req)
        self.assertEqual(cm.exception.code, 400)
        s, _, _ = c.call("POST", "/api/login", {"username": "a", "password": "b"}, headers={"Origin": "https://evil.example"})
        self.assertEqual(s, 403)

    def test_login_rate_limit(self):
        c = Client(self.base)
        c.call("POST", "/api/register", {"username": "dave", "password": "longenough1"})
        codes = [Client(self.base).call("POST", "/api/login", {"username": "dave", "password": "nope-nope"})[0] for _ in range(11)]
        self.assertEqual(codes[:10], [401] * 10)
        self.assertEqual(codes[10], 429)


class SecurityTest(unittest.TestCase):
    def test_hash_roundtrip(self):
        h = security.hash_password("s3cret-pass")
        self.assertTrue(h.startswith(("scrypt$", "pbkdf2_sha256$")))
        self.assertTrue(security.verify_password("s3cret-pass", h))
        self.assertFalse(security.verify_password("s3cret-pasS", h))
        self.assertNotEqual(h, security.hash_password("s3cret-pass"))  # salted

    def test_sqlite_session_expiry_and_conflict(self):
        st = SqliteStore(":memory:")
        st.create_user("eve", "x", time.time())
        st.create_session("th", "eve", time.time() - 1)
        self.assertIsNone(st.get_session("th", time.time()))
        self.assertEqual(st.put_history("eve", {"boardle:a": 1}, 0, time.time()), 1)
        with self.assertRaises(Conflict):
            st.put_history("eve", {"boardle:a": 2}, 0, time.time())


try:
    import boto3  # noqa: F401
    from moto import mock_aws
    HAVE_MOTO = True
except Exception:  # pragma: no cover
    HAVE_MOTO = False


@unittest.skipUnless(HAVE_MOTO, "boto3 + moto not installed (pip install boto3 'moto[dynamodb]')")
class DynamoTest(unittest.TestCase):
    def test_dynamo_adapter(self):
        os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
        os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
        with mock_aws():
            from boardle_backend.store_dynamodb import DynamoStore, create_table
            create_table("boardle-test", region="us-east-1")
            st = DynamoStore("boardle-test", region="us-east-1")
            now = time.time()
            self.assertTrue(st.create_user("ann", "h1", now))
            self.assertFalse(st.create_user("ann", "h2", now))
            self.assertEqual(st.get_user("ann")["pw_hash"], "h1")
            st.create_user("ben", "h3", now)
            st.create_session("tok", "ann", now + 60)
            self.assertEqual(st.get_session("tok", now), "ann")
            st.delete_session("tok")
            self.assertIsNone(st.get_session("tok", now))
            self.assertEqual(st.get_history("ann"), ({}, 0, None))
            self.assertEqual(st.put_history("ann", {"boardle:k": [1, 2]}, 0, now), 1)
            self.assertEqual(st.put_history("ann", {"boardle:k": [1, 2, 3]}, 1, now), 2)
            with self.assertRaises(Conflict) as cm:
                st.put_history("ann", {"boardle:k": []}, 1, now)
            self.assertEqual(cm.exception.rev, 2)
            self.assertEqual(st.get_history("ann")[0], {"boardle:k": [1, 2, 3]})
            self.assertEqual(st.get_history("ben")[0], {})


if __name__ == "__main__":
    unittest.main()
