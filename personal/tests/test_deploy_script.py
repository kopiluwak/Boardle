"""Dry-runs aws/deploy.sh and aws/destroy.sh against a fake AWS CLI (tests/fakes/fake_aws.py).

No AWS account is touched: `aws`, `curl`, `sleep` (and `zip` if missing) are shims on PATH.
Checks the control flow, idempotent re-runs, update mode, teardown, and that every JSON
document the script generates (IAM, bucket policy, CloudFront, Route 53) is valid and right.
"""
import glob
import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PERSONAL = os.path.dirname(HERE)
DEPLOY = os.path.join(PERSONAL, "aws", "deploy.sh")
DESTROY = os.path.join(PERSONAL, "aws", "destroy.sh")
FAKE = os.path.join(HERE, "fakes", "fake_aws.py")
BASH = shutil.which("bash")


def _load(path):
    with open(path) as f:
        return json.load(f)


def shim(path, body):
    with open(path, "w") as f:
        f.write("#!/bin/sh\n" + body + "\n")
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)


@unittest.skipUnless(BASH, "bash not available")
class DeployScriptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.bin = os.path.join(self.tmp, "bin")
        self.docs = os.path.join(self.tmp, "docs")
        os.makedirs(self.bin)
        os.makedirs(self.docs)
        shim(os.path.join(self.bin, "aws"), f'exec python3 "{FAKE}" "$@"')
        shim(os.path.join(self.bin, "curl"), 'echo "000"; exit 0')
        shim(os.path.join(self.bin, "sleep"), "exit 0")
        if not shutil.which("zip"):  # stand-in for `zip -qrX OUT .`
            shim(os.path.join(self.bin, "zip"),
                 'python3 -c "import sys,os,zipfile; z=zipfile.ZipFile(sys.argv[1],\'w\'); '
                 '[z.write(os.path.join(r,f), os.path.relpath(os.path.join(r,f), \'.\')) '
                 'for r,_,fs in os.walk(\'.\') for f in fs]; z.close()" "$2"')
        self.env = dict(os.environ, PATH=self.bin + os.pathsep + os.environ["PATH"], DOMAIN="ch35s.com",
                        FAKE_AWS_STATE=os.path.join(self.tmp, "state.json"),
                        FAKE_AWS_LOG=os.path.join(self.tmp, "calls.log"), FAKE_AWS_DOCS=self.docs,
                        TMPDIR=self.tmp)
        self.env.pop("PROFILE", None)
        self.env.pop("AWS_PROFILE", None)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_script(self, script, *args, **env):
        p = subprocess.run([BASH, script, *args], cwd=PERSONAL, env={**self.env, **env},
                           capture_output=True, text=True, timeout=120)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        return p.stdout + p.stderr

    def docs_named(self, pattern):
        return sorted(glob.glob(os.path.join(self.docs, pattern)))

    def calls(self):
        with open(self.env["FAKE_AWS_LOG"]) as f:
            return f.read().splitlines()

    def test_full_deploy_then_rerun_update_destroy(self):
        out = self.run_script(DEPLOY)
        self.assertIn("Done:  https://ch35s.com", out)

        # Lambda package: backend modules + handler only, no static files/tests
        (zpath,) = self.docs_named("*-lambda-create-function.zip")
        names = set(zipfile.ZipFile(zpath).namelist())
        self.assertIn("lambda_handler.py", names)
        self.assertIn("boardle_backend/api.py", names)
        self.assertIn("boardle_backend/store_dynamodb.py", names)
        self.assertFalse([n for n in names if not n.endswith(".py")], names)

        (envdoc,) = self.docs_named("*-lambda-create-function.json")
        env = _load(envdoc)["Variables"]
        self.assertEqual(env["BOARDLE_STORAGE"], "dynamodb")
        self.assertEqual(env["BOARDLE_DDB_TABLE"], "boardle-ch35s-com")
        self.assertEqual(env["BOARDLE_ALLOWED_ORIGINS"], "https://ch35s.com,https://www.ch35s.com")
        secret = env["BOARDLE_ORIGIN_VERIFY"]
        self.assertGreaterEqual(len(secret), 40)

        pol = _load(self.docs_named("*-iam-put-role-policy.json")[0])
        actions = sorted(a for s in pol["Statement"] for a in s["Action"])
        self.assertNotIn("dynamodb:*", actions)
        self.assertNotIn("dynamodb:Scan", actions)
        self.assertTrue(pol["Statement"][0]["Resource"].endswith(":table/boardle-ch35s-com"))

        (dist,) = [_load(p) for p in self.docs_named("*-cloudfront-create-distribution.json")]
        self.assertEqual(dist["Aliases"]["Items"], ["ch35s.com", "www.ch35s.com"])
        self.assertEqual(dist["DefaultRootObject"], "index.html")
        origins = {o["Id"]: o for o in dist["Origins"]["Items"]}
        self.assertEqual(origins["s3-site"]["OriginAccessControlId"], "OACFAKE")
        self.assertEqual(origins["lambda-api"]["DomainName"], "fakeurl123.lambda-url.us-east-1.on.invalid")
        self.assertEqual(origins["lambda-api"]["CustomHeaders"]["Items"][0],
                         {"HeaderName": "X-Origin-Verify", "HeaderValue": secret})
        beh = {b["PathPattern"]: b for b in dist["CacheBehaviors"]["Items"]}
        self.assertEqual(set(beh), {"/api/*", "/healthz"})
        self.assertEqual(beh["/api/*"]["CachePolicyId"], "4135ea2d-6df8-44a3-9df3-4b5a84be39ad")
        self.assertEqual(beh["/api/*"]["OriginRequestPolicyId"], "b689b0a8-53d0-40ab-baf2-68738e2966ac")
        self.assertIn("PUT", beh["/api/*"]["AllowedMethods"]["Items"])
        self.assertEqual(dist["ViewerCertificate"]["ACMCertificateArn"], "arn:aws:acm:us-east-1:123456789012:certificate/fake")

        bp = _load(self.docs_named("*-s3api-put-bucket-policy.json")[0])
        self.assertEqual(bp["Statement"][0]["Condition"]["StringEquals"]["AWS:SourceArn"],
                         "arn:aws:cloudfront::123456789012:distribution/EDISTFAKE")

        batches = [_load(p) for p in self.docs_named("*-route53-change-resource-record-sets.json")]
        acm_batch, dns_batch = batches
        self.assertEqual({c["ResourceRecordSet"]["Type"] for c in acm_batch["Changes"]}, {"CNAME"})
        self.assertEqual(len(acm_batch["Changes"]), 2)
        self.assertEqual(sorted((c["ResourceRecordSet"]["Name"], c["ResourceRecordSet"]["Type"]) for c in dns_batch["Changes"]),
                         [("ch35s.com", "A"), ("ch35s.com", "AAAA"), ("www.ch35s.com", "A"), ("www.ch35s.com", "AAAA")])
        self.assertEqual(dns_batch["Changes"][0]["ResourceRecordSet"]["AliasTarget"]["HostedZoneId"], "Z2FDTNDATAQYW2")

        state = _load(self.env["FAKE_AWS_STATE"])
        uploads = {u[0]: (u[1], u[2]) for u in state["uploads"]}
        self.assertEqual(uploads["*.html"], ("text/html; charset=utf-8", "no-cache"))
        self.assertEqual(uploads["*.js"][0], "text/javascript; charset=utf-8")
        staged = [c for c in self.calls() if c.startswith("s3 cp")]
        self.assertTrue(staged)

        # Re-run: nothing recreated, the CloudFront<->Lambda secret is kept
        n_calls = len(self.calls())
        self.run_script(DEPLOY)
        later = self.calls()[n_calls:]
        for creator in ("dynamodb create-table", "iam create-role", "lambda create-function ",
                        "cloudfront create-distribution", "acm request-certificate", "s3api create-bucket"):
            self.assertFalse([c for c in later if c.startswith(creator)], creator)
        envs = self.docs_named("*-lambda-update-function-configuration.json")
        self.assertEqual(_load(envs[-1])["Variables"]["BOARDLE_ORIGIN_VERIFY"], secret)

        out = self.run_script(DEPLOY, "update")
        self.assertIn("cache flush IINVFAKE", out)
        self.assertTrue(any(c.startswith("cloudfront create-invalidation") for c in self.calls()))

        out = self.run_script(DEPLOY, "status")
        self.assertIn("EDISTFAKE", out)

        out = self.run_script(DESTROY, CONFIRM="ch35s.com")
        self.assertIn("Teardown finished", out)
        self.assertIn("kept", out)
        self.assertFalse(any(c.startswith("dynamodb delete-table") for c in self.calls()))
        out = self.run_script(DESTROY, CONFIRM="ch35s.com", DELETE_DATA="1")
        self.assertTrue(any(c.startswith("dynamodb create-backup") for c in self.calls()))
        self.assertTrue(any(c.startswith("dynamodb delete-table") for c in self.calls()))

    def test_static_staging_excludes_backend(self):
        self.run_script(DEPLOY)
        # The script logs the staged dir via s3 cp source; inspect what stage_static would copy
        p = subprocess.run([BASH, "-c", 'set -e; MODE=x; . aws/common.sh; WORK=$(mktemp -d); '
                            'eval "$(sed -n "/^stage_static()/,/^}/p" aws/deploy.sh)"; '
                            'stage_static >/dev/null; cd "$WORK/site" && find . -type f | sort'],
                           cwd=PERSONAL, env=self.env, capture_output=True, text=True)
        files = p.stdout.split()
        self.assertIn("./index.html", files, p.stderr)
        self.assertIn("./vendor/chess.js", files)
        self.assertIn("./puzzles/5.json", files)
        self.assertIn("./openings/ui.js", files)
        for bad in ("./package.json", "./serve.py", "./aws/lambda_handler.py", "./test.mjs",
                    "./boardle_backend/api.py", "./README.md", "./Dockerfile", "./requirements.txt"):
            self.assertNotIn(bad, files)

    def test_refuses_dns_overwrite_without_yes(self):
        p = subprocess.run([BASH, DEPLOY], cwd=PERSONAL, input="n\n", capture_output=True, text=True, timeout=120,
                           env={**self.env, "FAKE_EXISTING_TEXT": "A\tNone\t192.0.2.10"})
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("Stopped before changing DNS", p.stderr)
        self.run_script(DEPLOY, YES="1", FAKE_EXISTING_TEXT="A\tNone\t192.0.2.10")


if __name__ == "__main__":
    unittest.main()
