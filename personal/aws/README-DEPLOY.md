# Put Boardle on https://ch35s.com (AWS, serverless)

```
browser ──HTTPS──► CloudFront (ch35s.com, www.ch35s.com; ACM certificate)
                     ├── /*                ──► S3 bucket (private, read only via Origin Access Control)
                     └── /api/*, /healthz  ──► Lambda Function URL ──► DynamoDB table (accounts + history)
```

Everything is created by one script, `aws/deploy.sh`, which you run on your Mac. It only uses the
AWS CLI, `zip` and `python3`, and it is safe to re-run: anything that already exists is reused.
The frontend already calls the API with relative paths (`/api/me`, `/api/history`, ...), so the
same files work locally and behind CloudFront with no changes.

## 1. One-time setup on the Mac
```bash
brew install awscli            # or the installer: https://awscli.amazonaws.com/AWSCLIV2.pkg
aws --version                  # needs aws-cli/2.x (2.32 or newer has `aws login`)
aws login                      # opens the browser; sign in to your AWS account
aws sts get-caller-identity    # should print your account number
```
If `aws login` isn't available, run `brew upgrade awscli`, or use `aws configure sso`
(IAM Identity Center) or `aws configure` (access keys). If you sign in to a named profile,
add `PROFILE=<name>` in front of each command below.

The account you sign in with needs permission for DynamoDB, IAM (create one role), Lambda,
S3, ACM, CloudFront, Route 53 and CloudWatch Logs. An administrator login works.

## 2. Deploy (first time, about 15-25 minutes, mostly waiting)
```bash
cd /Volumes/Internal_2T/Software/boardle/personal
chmod +x aws/deploy.sh aws/destroy.sh
DOMAIN=ch35s.com REGION=us-east-1 ./aws/deploy.sh
```
What happens, in order:

| Step | Creates | Wait |
|---|---|---|
| Hosted zone | finds the existing ch35s.com zone (nothing created) | – |
| DynamoDB | table `boardle-ch35s-com` (on-demand, point-in-time recovery, TTL, deletion protection) | ~10 s |
| IAM | role `boardle-ch35s-com-lambda` (only that table + its own logs) | ~10 s |
| Lambda | `boardle-ch35s-com-api` (Python 3.12) + Function URL; a random secret header is generated so only CloudFront can call it | ~10 s |
| S3 | private bucket `boardle-ch35s-com-site-<account>` + static files | ~10 s |
| ACM | certificate for ch35s.com + www.ch35s.com; the DNS validation records are added to Route 53 for you | **2-5 min** (up to 30) |
| CloudFront | distribution with both names, HTTPS, OAC to S3, `/api/*` + `/healthz` to Lambda (not cached) | **5-15 min** |
| Route 53 | A + AAAA alias records for ch35s.com and www.ch35s.com | ~1 min |

If ch35s.com or www already has A/AAAA records pointing somewhere else, the script shows them and
asks before replacing them (`YES=1` skips the question). It stops if www is a CNAME (see below).

Optional settings: `INVITE_CODE=chess2026` (people need this code to sign up),
`ALLOW_REGISTER=0` (no new accounts).

## 3. Check it
```bash
curl https://ch35s.com/healthz          # {"ok": true}
DOMAIN=ch35s.com ./aws/deploy.sh status
```
Then open https://ch35s.com, click 👤 and create an account. Play a puzzle, then sign in from
another browser or your phone: your history should be there. DNS can take a few minutes to
reach your Mac after the first deploy; if `curl` can't resolve the name yet, wait and retry.

## 4. Update later
After changing files in `personal/` (or installing a new ZIP):
```bash
cd /Volumes/Internal_2T/Software/boardle/personal
DOMAIN=ch35s.com ./aws/deploy.sh update
```
That uploads the static files again, updates the Lambda code and flushes the CloudFront cache
(about 1 minute). Press Cmd+Shift+R once in the browser. Player data is not touched. To change
settings like `INVITE_CODE`, run the full `./aws/deploy.sh` again with the new value.

## 5. Costs (low traffic)
- Route 53 hosted zone: **$0.50/month** (you already pay this). Alias lookups to CloudFront are free.
- CloudFront: always-free tier covers 1 TB transfer + 10 million requests a month.
- Lambda: always-free tier covers 1 million requests + 400,000 GB-seconds a month.
- DynamoDB: 25 GB storage free; on-demand reads/writes cost cents per million, so a few
  players cost well under $0.01/month. Point-in-time recovery is about $0.20 per GB-month
  (this table will be kilobytes).
- S3 (≈1.5 MB of files), CloudWatch Logs (30-day retention), ACM certificate: free or fractions of a cent.

Check AWS's current free-tier page for your account type; newer accounts get credits instead of the
12-month free tier, but the always-free limits above still apply. A Billing budget alert
(Billing > Budgets > "Zero spend budget") is a good idea.

## 6. Troubleshooting
- **`CNAMEAlreadyExists` when creating the distribution**: ch35s.com or www.ch35s.com is already
  attached to another CloudFront distribution (maybe an old test). Remove that alias from the other
  distribution in the CloudFront console, then re-run `./aws/deploy.sh`.
- **"www.ch35s.com has a CNAME record"**: delete that CNAME in the Route 53 console (an A alias can't
  sit next to it) and re-run.
- **Stuck at "waiting for ACM to validate"**: in the ACM console (region N. Virginia / us-east-1)
  the certificate should show "Pending validation" with two CNAME records that also appear in your
  Route 53 zone. If the domain's registrar points at different name servers than the hosted zone's
  NS record, validation never completes; fix the name servers at the registrar. Ctrl+C and
  re-running is safe.
- **Your account must be verified before you can add new CloudFront resources**: new AWS accounts
  sometimes need a quick AWS Support case to enable CloudFront; open it, then re-run.
- **403 / AccessDenied XML from the site**: the bucket policy doesn't match the distribution or the
  file is missing. Re-run `./aws/deploy.sh` (it rewrites the policy), then check the file exists with
  `aws s3 ls s3://boardle-ch35s-com-site-<account>/`. A wrong URL like `/nope.html` also shows 403,
  because a private bucket doesn't reveal which files exist.
- **`{"error": "Forbidden"}` from /api or /healthz**: the request didn't come through CloudFront with
  the secret header. Calling the raw `*.lambda-url.*` address is supposed to fail. Through ch35s.com
  it means the distribution and Lambda secrets differ; compare the `X-Origin-Verify` origin header in
  CloudFront with the Lambda's `BOARDLE_ORIGIN_VERIFY` environment variable.
- **Sign-in seems to work but you're signed out on reload (cookie not set)**: use `https://`
  (cookies are `Secure`), and make sure the `/api/*` behavior uses origin request policy
  AllViewerExceptHostHeader (cookies forwarded) and cache policy CachingDisabled. "Cross-origin
  request refused" means the page's address isn't in the Lambda's `BOARDLE_ALLOWED_ORIGINS`.
- **Old version still showing**: `./aws/deploy.sh update` flushes the cache; then Cmd+Shift+R.
- **Logs**: `aws logs tail /aws/lambda/boardle-ch35s-com-api --follow --region us-east-1`

## 7. Removing it
```bash
DOMAIN=ch35s.com ./aws/destroy.sh                  # site offline, accounts + history kept
DOMAIN=ch35s.com DELETE_DATA=1 ./aws/destroy.sh    # also deletes the table (a final backup is kept)
```
It asks you to type the domain first. Only DNS records that point at this distribution are removed;
the hosted zone and other records stay.

## How it's built (for later)
- `aws/lambda_handler.py` turns Function URL events into calls to `boardle_backend/api.py`, the same
  code `python3 serve.py` runs locally. Cookies are `HttpOnly; Secure; SameSite=Lax; Path=/`.
- Write requests must come from `https://ch35s.com` or `https://www.ch35s.com`
  (`BOARDLE_ALLOWED_ORIGINS`), plus the JSON content type, as protection against cross-site requests.
- Failed-login limiting (10 tries / 15 minutes per IP + username) is stored in DynamoDB, so it holds
  across every Lambda instance. Its entries expire through TTL.
- Tests: `python3 -m unittest discover -s tests` (the DynamoDB parts run when `boto3` + `moto` are
  installed). `tests/test_deploy_script.py` runs deploy.sh/destroy.sh against a fake AWS CLI.
