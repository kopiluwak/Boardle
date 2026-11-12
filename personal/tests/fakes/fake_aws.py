#!/usr/bin/env python3
"""Minimal stand-in for the AWS CLI, used by tests/test_deploy_script.py.

Keeps state in $FAKE_AWS_STATE (JSON), logs every call to $FAKE_AWS_LOG, and copies every
file:// document it is handed to $FAKE_AWS_DOCS so the test can validate the JSON that
deploy.sh generated. It only knows the calls deploy.sh / destroy.sh make.
"""
import json
import os
import shutil
import sys

args = sys.argv[1:]
state_path = os.environ["FAKE_AWS_STATE"]
state = json.load(open(state_path)) if os.path.exists(state_path) else {}
with open(os.environ["FAKE_AWS_LOG"], "a") as log:
    log.write(" ".join(args) + "\n")


def opt(name, default=None):
    return args[args.index(name) + 1] if name in args else default


def save():
    json.dump(state, open(state_path, "w"))


def out(v):
    if v != "":
        print(v)
    save()
    sys.exit(0)


def missing():
    save()
    sys.stderr.write("An error occurred (ResourceNotFoundException)\n")
    sys.exit(254)


def doc(name):
    v = opt(name)
    if v and v.startswith(("file://", "fileb://")):
        src = v.split("://", 1)[1]
        n = len(os.listdir(os.environ["FAKE_AWS_DOCS"]))
        dst = os.path.join(os.environ["FAKE_AWS_DOCS"], f"{n:03d}-{args[0]}-{args[1]}{os.path.splitext(src)[1]}")
        shutil.copy(src, dst)
        if src.endswith(".json"):
            return json.load(open(src))
    return v


if args[:1] == ["--version"]:
    out("aws-cli/2.31.0 Python/3.13.7 Darwin/24 source/arm64")
svc, op = args[0], args[1]
query = opt("--query", "")
key = f"{svc} {op}"

if key == "sts get-caller-identity":
    out("123456789012")
if key == "route53 list-hosted-zones-by-name":
    out("/hostedzone/ZFAKE123")
if key == "dynamodb describe-table":
    if "table" not in state:
        missing()
    out("ACTIVE" if "Status" in query else state["table"])
if key == "dynamodb create-table":
    state["table"] = opt("--table-name"); out("{}")
if key == "dynamodb describe-time-to-live":
    out(state.get("ttl", "DISABLED"))
if key == "dynamodb update-time-to-live":
    state["ttl"] = "ENABLED"; out("{}")
if key == "iam get-role":
    if "role" not in state:
        missing()
    out(state["role"] if "Arn" in query else opt("--role-name"))
if key == "iam create-role":
    doc("--assume-role-policy-document")
    state["role"] = f"arn:aws:iam::123456789012:role/{opt('--role-name')}"; out(state["role"])
if key == "iam put-role-policy":
    doc("--policy-document"); out("")
if key == "lambda get-function-configuration":
    if "lambda" not in state:
        missing()
    if "BOARDLE_ORIGIN_VERIFY" in query:
        out(state["lambda"]["env"]["Variables"]["BOARDLE_ORIGIN_VERIFY"])
    if "BOARDLE_INVITE_CODE" in query:
        out(state["lambda"]["env"]["Variables"].get("BOARDLE_INVITE_CODE") or "None")
    out("Active" if query == "State" else opt("--function-name"))
if key in ("lambda create-function", "lambda update-function-configuration"):
    env = doc("--environment")
    if key == "lambda create-function":
        doc("--zip-file")
        state["lambda"] = {"env": env}
    else:
        state["lambda"]["env"] = env
    out("{}")
if key == "lambda update-function-code":
    doc("--zip-file"); out("{}")
if key == "lambda get-function-url-config":
    if "url" not in state:
        missing()
    out(state["url"])
if key == "lambda create-function-url-config":
    state["url"] = "https://fakeurl123.lambda-url.us-east-1.on.invalid/"; out(state["url"])
if key == "lambda add-permission":
    perms = state.setdefault("perms", [])
    sid = opt("--statement-id")
    if sid in perms:
        sys.stderr.write("An error occurred (ResourceConflictException)\n"); save(); sys.exit(254)
    perms.append(sid); out("{}")
if key == "s3api head-bucket":
    if "bucket" not in state:
        missing()
    out("")
if key == "s3api create-bucket":
    state["bucket"] = opt("--bucket"); out("{}")
if key == "s3api put-bucket-policy":
    doc("--policy"); out("")
if key == "acm list-certificates":
    out("\t".join(state.get("certs", [])) or "")
if key == "acm request-certificate":
    arn = "arn:aws:acm:us-east-1:123456789012:certificate/fake"
    state["certs"] = [arn]; out(arn)
if key == "acm describe-certificate":
    if "SubjectAlternativeNames" in query:
        out("ch35s.com\twww.ch35s.com")
    if "DomainValidationOptions" in query:
        out("_a.ch35s.com.\t_x.acm-validations.aws.\n_b.www.ch35s.com.\t_y.acm-validations.aws.")
    if "InUseBy" in query:
        out("0")
    out(state.get("cert_status", "PENDING_VALIDATION"))
if key == "acm wait":
    state["cert_status"] = "ISSUED"; out("")
if key == "route53 change-resource-record-sets":
    doc("--change-batch"); out("/change/C1")
if key == "route53 list-resource-record-sets":
    out(os.environ.get("FAKE_EXISTING_RECORDS", "[]") if opt("--output") == "json" else os.environ.get("FAKE_EXISTING_TEXT", ""))
if key == "cloudfront list-distributions":
    out(state.get("dist", "None"))
if key == "cloudfront list-origin-access-controls":
    out(state.get("oac", "None"))
if key == "cloudfront create-origin-access-control":
    doc("--origin-access-control-config"); state["oac"] = "OACFAKE"; out("OACFAKE")
if key == "cloudfront create-distribution":
    doc("--distribution-config"); state["dist"] = "EDISTFAKE"; out("EDISTFAKE")
if key == "cloudfront get-distribution":
    out("ETAG1" if query == "ETag" else "d111fake.cloudfront.net")
if key == "cloudfront create-invalidation":
    out("IINVFAKE")
if key == "cloudfront get-distribution-config":
    out(json.dumps({"ETag": "E1", "DistributionConfig": {"Enabled": True}}))
if key == "cloudfront update-distribution":
    doc("--distribution-config"); out("E2")
if key == "cloudfront delete-distribution":
    state.pop("dist", None); out("")
if key == "cloudfront get-origin-access-control":
    out("E3")
if key == "cloudfront delete-origin-access-control":
    state.pop("oac", None); out("")
if key in ("s3 cp", "s3 sync", "s3 rm"):
    if key == "s3 cp":
        state.setdefault("uploads", []).append([opt("--include"), opt("--content-type"), opt("--cache-control")])
    out("")
if key == "s3api delete-bucket":
    state.pop("bucket", None); out("")
if key == "lambda delete-function":
    state.pop("lambda", None); out("")
if key == "iam delete-role":
    state.pop("role", None); out("")
if key == "dynamodb create-backup":
    out("arn:backup")
if key == "dynamodb delete-table":
    state.pop("table", None); out("{}")
# waits, tags, retention, ownership, public-access-block, continuous backups, misc deletes
if op in ("wait",) or op.startswith(("put-", "update-", "delete-", "create-log-group", "tag")):
    out("")
sys.stderr.write(f"fake aws: unhandled {key} {args}\n")
sys.exit(2)
