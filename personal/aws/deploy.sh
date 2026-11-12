#!/usr/bin/env bash
# Boardle -> AWS (S3 + CloudFront + Lambda Function URL + DynamoDB + ACM + Route 53).
#
#   cd /path/to/personal
#   DOMAIN=ch35s.com ./aws/deploy.sh            # first deploy (safe to re-run; skips what exists)
#   DOMAIN=ch35s.com ./aws/deploy.sh update     # later: new static files + Lambda code + cache flush
#   DOMAIN=ch35s.com ./aws/deploy.sh status     # show what exists
#
# Settings (environment variables):
#   DOMAIN   (required)  apex domain whose public hosted zone is already in Route 53
#   REGION   us-east-1   region for Lambda / DynamoDB / S3 (the certificate is always us-east-1)
#   PROFILE  (optional)  AWS CLI profile name; default is your default credentials
#   NAME     boardle-<domain-with-dashes>   prefix for every resource name
#   YES=1    don't ask before replacing existing apex/www DNS records
#   INVITE_CODE=...      require this code to create an account (empty string = no code)
#   ALLOW_REGISTER=0     close registration
#
# What it creates (first run):
#   DynamoDB table  $NAME              on-demand, point-in-time recovery, TTL on `ttl`, deletion protection
#   IAM role        $NAME-lambda       may only touch that table + write its own logs
#   Lambda          $NAME-api          Python 3.12 arm64, the API from boardle_backend/ (no static files)
#   Function URL    (auth NONE)        but every request must carry the secret X-Origin-Verify header
#                                      that only CloudFront knows -> direct calls get 403
#   S3 bucket       $NAME-site-<acct>  private (Block Public Access on), static files only
#   ACM certificate ch35s.com + www    DNS-validated; validation CNAMEs added to Route 53 for you
#   CloudFront      distribution       OAC to S3, /api/* and /healthz -> Lambda URL, HTTPS only
#   Route 53        A + AAAA aliases   ch35s.com and www.ch35s.com -> CloudFront
#
# Needs only: aws (CLI v2), python3, zip. Works with macOS bash 3.2 and from zsh.
set -euo pipefail

MODE="${1:-deploy}"
# shellcheck source=common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/boardle-deploy.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Managed CloudFront policy ids (same in every account)
CACHE_OPTIMIZED="658327ea-f89d-4fab-a63d-7e88639e58f6"     # static files from S3
CACHE_DISABLED="4135ea2d-6df8-44a3-9df3-4b5a84be39ad"      # API: never cache
ORIGIN_ALL_EXCEPT_HOST="b689b0a8-53d0-40ab-baf2-68738e2966ac"  # API: forward cookies, headers, query
SECURITY_HEADERS="67f7725c-6f97-4210-82d7-5512b31e9d03"    # HSTS, nosniff, frame-options, referrer

# ---------------------------------------------------------------- packaging
build_lambda_zip() {
  # Only backend Python modules + the handler. No static files, no tests, no __pycache__.
  local pkg="$WORK/lambda"
  rm -rf "$pkg" && mkdir -p "$pkg/boardle_backend"
  cp "$APP_DIR"/boardle_backend/*.py "$pkg/boardle_backend/"
  cp "$APP_DIR/aws/lambda_handler.py" "$pkg/"
  (cd "$pkg" && zip -qrX "$WORK/lambda.zip" .)
  info "Lambda package: $(du -h "$WORK/lambda.zip" | cut -f1) ($(cd "$pkg" && find . -name '*.py' | wc -l | tr -d ' ') files)"
}

stage_static() {
  # Copy only what the browser needs into $WORK/site.
  local site="$WORK/site"
  rm -rf "$site" && mkdir -p "$site"
  (cd "$APP_DIR" && find . \
      \( -path ./boardle_backend -o -path ./tests -o -path ./tools -o -path ./aws -o -path ./node_modules \
         -o -path ./data -o -path './.*' -o -name __pycache__ \) -prune -o \
      -type f \( -name '*.html' -o -name '*.js' -o -name '*.css' -o -name '*.json' -o -name '*.svg' \
                 -o -name '*.png' -o -name '*.ico' -o -name '*.webmanifest' -o -name '*.woff2' \) \
      ! -name package.json ! -name 'package-lock.json' -print) | while IFS= read -r f; do
    mkdir -p "$site/$(dirname "$f")"
    cp -p "$APP_DIR/$f" "$site/$f"
  done
  [ -f "$site/index.html" ] || die "index.html not found - run this from the personal/ folder copy."
  info "Static files: $(find "$site" -type f | wc -l | tr -d ' ') ($(du -sh "$site" | cut -f1))"
}

upload_static() {
  stage_static
  say "Uploading static files to s3://$BUCKET"
  local site="$WORK/site" pair ext ctype
  # One pass per file type so each gets the right Content-Type. Everything is "no-cache":
  # browsers revalidate (cheap 304s) so an update never mixes old and new modules.
  for pair in "html|text/html; charset=utf-8" "js|text/javascript; charset=utf-8" \
              "css|text/css; charset=utf-8" "json|application/json" "svg|image/svg+xml" \
              "png|image/png" "ico|image/x-icon" "webmanifest|application/manifest+json" "woff2|font/woff2"; do
    ext="${pair%%|*}"; ctype="${pair#*|}"
    if [ -n "$(find "$site" -type f -name "*.${ext}" | head -n 1)" ]; then
      aws s3 cp "$site" "s3://$BUCKET" --region "$REGION" --recursive --only-show-errors \
        --exclude '*' --include "*.${ext}" --content-type "$ctype" --cache-control "no-cache"
    fi
  done
  # Remove files that no longer exist locally (uploads nothing new: sizes already match).
  aws s3 sync "$site" "s3://$BUCKET" --region "$REGION" --delete --size-only --only-show-errors
  info "done"
}

# ---------------------------------------------------------------- DynamoDB
ensure_table() {
  say "DynamoDB table $TABLE"
  if [ -n "$(q dynamodb describe-table --region "$REGION" --table-name "$TABLE" --query Table.TableName)" ]; then
    info "exists"
  else
    # Schema expected by boardle_backend/store_dynamodb.py: pk (S) + sk (S).
    aws dynamodb create-table --region "$REGION" --table-name "$TABLE" \
      --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
      --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
      --billing-mode PAY_PER_REQUEST --deletion-protection-enabled \
      --tags Key=app,Value=boardle Key=domain,Value="$DOMAIN" >/dev/null
    info "creating (about 10 seconds)..."
    aws dynamodb wait table-exists --region "$REGION" --table-name "$TABLE"
    info "created"
  fi
  if [ "$(q dynamodb describe-time-to-live --region "$REGION" --table-name "$TABLE" \
          --query TimeToLiveDescription.TimeToLiveStatus)" != "ENABLED" ]; then
    aws dynamodb update-time-to-live --region "$REGION" --table-name "$TABLE" \
      --time-to-live-specification Enabled=true,AttributeName=ttl >/dev/null 2>&1 || true
    info "TTL on 'ttl' enabled (expired sessions + rate-limit counters clean themselves up)"
  fi
  aws dynamodb update-continuous-backups --region "$REGION" --table-name "$TABLE" \
    --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true >/dev/null
  info "point-in-time recovery on (restore to any second of the last 35 days)"
}

# ---------------------------------------------------------------- IAM
ensure_role() {
  say "IAM role $ROLE"
  cat > "$WORK/trust.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Principal": { "Service": "lambda.amazonaws.com" }, "Action": "sts:AssumeRole" }]
}
JSON
  cat > "$WORK/policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BoardleTable",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
      "Resource": "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${TABLE}"
    },
    {
      "Sid": "OwnLogs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${LOG_GROUP}:*"
    }
  ]
}
JSON
  ROLE_ARN="$(q iam get-role --role-name "$ROLE" --query Role.Arn)"
  if [ -z "$ROLE_ARN" ]; then
    ROLE_ARN="$(aws iam create-role --role-name "$ROLE" --assume-role-policy-document "file://$WORK/trust.json" \
      --description "Boardle API on $DOMAIN" --tags Key=app,Value=boardle --query Role.Arn --output text)"
    ROLE_NEW=1
    info "created $ROLE_ARN"
  else
    ROLE_NEW=0
    info "exists"
  fi
  # put-role-policy overwrites, so re-running always restores the least-privilege policy.
  aws iam put-role-policy --role-name "$ROLE" --policy-name boardle-least-privilege \
    --policy-document "file://$WORK/policy.json"
  # Log group created here (30-day retention), so the role doesn't need logs:CreateLogGroup.
  aws logs create-log-group --region "$REGION" --log-group-name "$LOG_GROUP" >/dev/null 2>&1 || true
  aws logs put-retention-policy --region "$REGION" --log-group-name "$LOG_GROUP" --retention-in-days 30
  if [ "$ROLE_NEW" = 1 ]; then info "waiting 10s for the new role to propagate..."; sleep 10; fi
}

# ---------------------------------------------------------------- Lambda
lambda_env_json() {
  # Values are [A-Za-z0-9_-:/.,] only, so plain heredoc substitution is safe JSON.
  cat > "$WORK/env.json" <<JSON
{
  "Variables": {
    "BOARDLE_STORAGE": "dynamodb",
    "BOARDLE_DDB_TABLE": "${TABLE}",
    "BOARDLE_COOKIE_SECURE": "1",
    "BOARDLE_ALLOWED_ORIGINS": "https://${DOMAIN},https://${WWW}",
    "BOARDLE_ORIGIN_VERIFY": "${ORIGIN_SECRET}",
    "BOARDLE_ALLOW_REGISTER": "${ALLOW_REGISTER_VAL}",
    "BOARDLE_INVITE_CODE": "${INVITE_VAL}"
  }
}
JSON
}

ensure_lambda() {
  say "Lambda function $FUNC"
  build_lambda_zip
  local exists
  exists="$(q lambda get-function-configuration --region "$REGION" --function-name "$FUNC" --query FunctionName)"
  # Keep the existing CloudFront<->Lambda secret and settings unless overridden.
  ORIGIN_SECRET=""
  if [ -n "$exists" ]; then
    ORIGIN_SECRET="$(q lambda get-function-configuration --region "$REGION" --function-name "$FUNC" \
      --query Environment.Variables.BOARDLE_ORIGIN_VERIFY)"
  fi
  if [ -z "$ORIGIN_SECRET" ]; then
    ORIGIN_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  fi
  if [ -n "${INVITE_CODE+set}" ]; then INVITE_VAL="$INVITE_CODE"
  elif [ -n "$exists" ]; then INVITE_VAL="$(q lambda get-function-configuration --region "$REGION" \
      --function-name "$FUNC" --query Environment.Variables.BOARDLE_INVITE_CODE)"
  else INVITE_VAL=""; fi
  case "$INVITE_VAL" in *[!A-Za-z0-9_.-]*) die "INVITE_CODE may only contain letters, digits, _ . -";; esac
  ALLOW_REGISTER_VAL="${ALLOW_REGISTER:-1}"
  lambda_env_json

  if [ -z "$exists" ]; then
    local i=0
    until aws lambda create-function --region "$REGION" --function-name "$FUNC" \
        --runtime python3.12 --architectures arm64 --handler lambda_handler.handler \
        --role "$ROLE_ARN" --zip-file "fileb://$WORK/lambda.zip" \
        --timeout 10 --memory-size 512 --environment "file://$WORK/env.json" \
        --logging-config "LogFormat=Text,LogGroup=$LOG_GROUP" \
        --description "Boardle API for $DOMAIN" --tags app=boardle >/dev/null 2>"$WORK/err"; do
      i=$((i + 1))
      # A brand-new IAM role can take a few seconds before Lambda may assume it.
      if grep -q "cannot be assumed" "$WORK/err" && [ $i -lt 12 ]; then sleep 5; continue; fi
      cat "$WORK/err" >&2; die "create-function failed"
    done
    info "created; waiting until active..."
    aws lambda wait function-active-v2 --region "$REGION" --function-name "$FUNC"
  else
    aws lambda update-function-code --region "$REGION" --function-name "$FUNC" \
      --zip-file "fileb://$WORK/lambda.zip" >/dev/null
    aws lambda wait function-updated-v2 --region "$REGION" --function-name "$FUNC"
    aws lambda update-function-configuration --region "$REGION" --function-name "$FUNC" \
      --role "$ROLE_ARN" --environment "file://$WORK/env.json" >/dev/null
    aws lambda wait function-updated-v2 --region "$REGION" --function-name "$FUNC"
    info "code + settings updated"
  fi
}

add_permission() {  # statement-id, then extra add-permission args; already-present is fine
  local sid="$1"; shift
  if aws lambda add-permission --region "$REGION" --function-name "$FUNC" --statement-id "$sid" \
       --principal '*' "$@" >/dev/null 2>"$WORK/err"; then return 0; fi
  grep -q ResourceConflictException "$WORK/err" && return 0
  return 1
}

ensure_function_url() {
  say "Lambda Function URL"
  LAMBDA_URL="$(q lambda get-function-url-config --region "$REGION" --function-name "$FUNC" --query FunctionUrl)"
  if [ -z "$LAMBDA_URL" ]; then
    LAMBDA_URL="$(aws lambda create-function-url-config --region "$REGION" --function-name "$FUNC" \
      --auth-type NONE --query FunctionUrl --output text)"
    info "created"
  else
    info "exists"
  fi
  # Public invoke permissions (both are required for URLs created since Oct 2025). The real
  # gate is the X-Origin-Verify secret checked inside the function.
  add_permission FunctionURLAllowPublicAccess --action lambda:InvokeFunctionUrl --function-url-auth-type NONE \
    || { cat "$WORK/err" >&2; die "add-permission (InvokeFunctionUrl) failed"; }
  if ! add_permission FunctionURLInvokeAllowPublicAccess --action lambda:InvokeFunction --invoked-via-function-url; then
    if grep -qi "unknown options" "$WORK/err"; then
      warn "Your AWS CLI is older than the --invoked-via-function-url flag; adding the permission without it."
      warn "(Consider: brew upgrade awscli)"
      add_permission FunctionURLInvokeAllowPublicAccess --action lambda:InvokeFunction \
        || { cat "$WORK/err" >&2; die "add-permission (InvokeFunction) failed"; }
    else
      cat "$WORK/err" >&2; die "add-permission (InvokeFunction) failed"
    fi
  fi
  LAMBDA_HOST="${LAMBDA_URL#https://}"; LAMBDA_HOST="${LAMBDA_HOST%/}"
  info "$LAMBDA_URL"
  local code
  code="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "${LAMBDA_URL%/}/healthz" || true)"
  info "direct call without the secret header -> HTTP $code (403 is correct)"
}

# ---------------------------------------------------------------- S3
ensure_bucket() {
  say "S3 bucket $BUCKET"
  if aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
    info "exists"
  else
    if [ "$REGION" = "us-east-1" ]; then
      aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
    else
      aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
        --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
    fi
    info "created"
  fi
  aws s3api put-public-access-block --bucket "$BUCKET" --region "$REGION" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-ownership-controls --bucket "$BUCKET" --region "$REGION" \
    --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
  aws s3api put-bucket-tagging --bucket "$BUCKET" --region "$REGION" \
    --tagging "TagSet=[{Key=app,Value=boardle},{Key=domain,Value=$DOMAIN}]"
  info "private: Block Public Access on; only CloudFront (OAC) will be allowed to read"
}

put_bucket_policy() {
  cat > "$WORK/bucket-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontOAC",
    "Effect": "Allow",
    "Principal": { "Service": "cloudfront.amazonaws.com" },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::${BUCKET}/*",
    "Condition": { "StringEquals": { "AWS:SourceArn": "arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DIST_ID}" } }
  }]
}
JSON
  aws s3api put-bucket-policy --bucket "$BUCKET" --region "$REGION" --policy "file://$WORK/bucket-policy.json"
  info "bucket policy: only distribution $DIST_ID may read objects"
}

# ---------------------------------------------------------------- ACM (us-east-1)
ensure_certificate() {
  say "TLS certificate for $DOMAIN + $WWW (ACM, us-east-1)"
  CERT_ARN=""
  local arn
  for arn in $(q acm list-certificates --region "$CERT_REGION" \
                 --certificate-statuses ISSUED PENDING_VALIDATION \
                 --query "CertificateSummaryList[?DomainName=='${DOMAIN}'].CertificateArn"); do
    if q acm describe-certificate --region "$CERT_REGION" --certificate-arn "$arn" \
         --query Certificate.SubjectAlternativeNames | tr '\t' '\n' | grep -qx "$WWW"; then
      CERT_ARN="$arn"; break
    fi
  done
  if [ -z "$CERT_ARN" ]; then
    CERT_ARN="$(aws acm request-certificate --region "$CERT_REGION" --domain-name "$DOMAIN" \
      --subject-alternative-names "$WWW" --validation-method DNS \
      --idempotency-token "$(printf '%s' "$NAME" | tr -cd 'a-zA-Z0-9' | cut -c1-32)" \
      --tags Key=app,Value=boardle --query CertificateArn --output text)"
    info "requested $CERT_ARN"
  else
    info "found $CERT_ARN"
  fi

  local status
  status="$(q acm describe-certificate --region "$CERT_REGION" --certificate-arn "$CERT_ARN" --query Certificate.Status)"
  if [ "$status" = "ISSUED" ]; then info "already issued"; return; fi

  # The validation CNAMEs show up a few seconds after the request.
  local tries=0 recs=""
  while [ $tries -lt 30 ]; do
    recs="$(q acm describe-certificate --region "$CERT_REGION" --certificate-arn "$CERT_ARN" \
      --query 'Certificate.DomainValidationOptions[].ResourceRecord.[Name,Value]' | sort -u)"
    if [ -n "$recs" ] && ! printf '%s' "$recs" | grep -q None; then break; fi
    tries=$((tries + 1)); sleep 4
  done
  [ -n "$recs" ] || die "ACM did not return DNS validation records yet; re-run the script in a minute."

  {
    printf '{"Comment":"ACM validation for %s","Changes":[' "$DOMAIN"
    local first=1 name value
    printf '%s\n' "$recs" | while IFS="$(printf '\t')" read -r name value; do
      [ -n "$name" ] || continue
      if [ $first = 1 ]; then first=0; else printf ','; fi
      printf '{"Action":"UPSERT","ResourceRecordSet":{"Name":"%s","Type":"CNAME","TTL":300,"ResourceRecords":[{"Value":"%s"}]}}' "$name" "$value"
    done
    printf ']}'
  } > "$WORK/acm-dns.json"
  local change
  change="$(aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" \
    --change-batch "file://$WORK/acm-dns.json" --query ChangeInfo.Id --output text)"
  info "validation CNAME(s) added to Route 53"
  aws route53 wait resource-record-sets-changed --id "$change"
  info "waiting for ACM to validate (usually 2-5 minutes, can be up to 30)..."
  aws acm wait certificate-validated --region "$CERT_REGION" --certificate-arn "$CERT_ARN"
  info "issued"
}

# ---------------------------------------------------------------- CloudFront
ensure_oac() {
  OAC_ID="$(q cloudfront list-origin-access-controls \
    --query "OriginAccessControlList.Items[?Name=='${OAC_NAME}'].Id | [0]")"
  if [ -z "$OAC_ID" ]; then
    cat > "$WORK/oac.json" <<JSON
{ "Name": "${OAC_NAME}", "Description": "Boardle ${DOMAIN} -> S3",
  "SigningProtocol": "sigv4", "SigningBehavior": "always", "OriginAccessControlOriginType": "s3" }
JSON
    OAC_ID="$(aws cloudfront create-origin-access-control --origin-access-control-config "file://$WORK/oac.json" \
      --query OriginAccessControl.Id --output text)"
    info "origin access control $OAC_ID created"
  fi
}

api_behavior() {  # $1 = path pattern, $2 = allowed-methods JSON
  cat <<JSON
      {
        "PathPattern": "$1",
        "TargetOriginId": "lambda-api",
        "ViewerProtocolPolicy": "https-only",
        "AllowedMethods": { $2, "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] } },
        "Compress": true,
        "CachePolicyId": "${CACHE_DISABLED}",
        "OriginRequestPolicyId": "${ORIGIN_ALL_EXCEPT_HOST}",
        "ResponseHeadersPolicyId": "${SECURITY_HEADERS}"
      }
JSON
}

ensure_distribution() {
  say "CloudFront distribution for $DOMAIN + $WWW"
  DIST_ID="$(distribution_id)"
  if [ -n "$DIST_ID" ]; then
    info "exists: $DIST_ID (left as is; delete it with destroy.sh to rebuild from scratch)"
  else
    ensure_oac
    local all_methods='"Quantity": 7, "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]'
    local get_head='"Quantity": 2, "Items": ["GET", "HEAD"]'
    cat > "$WORK/dist.json" <<JSON
{
  "CallerReference": "${NAME}-$(date +%s)",
  "Comment": "Boardle ${DOMAIN}",
  "Enabled": true,
  "Aliases": { "Quantity": 2, "Items": ["${DOMAIN}", "${WWW}"] },
  "DefaultRootObject": "index.html",
  "HttpVersion": "http2and3",
  "IsIPV6Enabled": true,
  "PriceClass": "PriceClass_100",
  "Origins": { "Quantity": 2, "Items": [
    {
      "Id": "s3-site",
      "DomainName": "${BUCKET}.s3.${REGION}.amazonaws.com",
      "OriginAccessControlId": "${OAC_ID}",
      "S3OriginConfig": { "OriginAccessIdentity": "" }
    },
    {
      "Id": "lambda-api",
      "DomainName": "${LAMBDA_HOST}",
      "CustomOriginConfig": {
        "HTTPPort": 80, "HTTPSPort": 443, "OriginProtocolPolicy": "https-only",
        "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] },
        "OriginReadTimeout": 30, "OriginKeepaliveTimeout": 5
      },
      "CustomHeaders": { "Quantity": 1, "Items": [ { "HeaderName": "X-Origin-Verify", "HeaderValue": "${ORIGIN_SECRET}" } ] }
    }
  ] },
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3-site",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": { ${get_head}, "CachedMethods": { ${get_head} } },
    "Compress": true,
    "CachePolicyId": "${CACHE_OPTIMIZED}",
    "ResponseHeadersPolicyId": "${SECURITY_HEADERS}"
  },
  "CacheBehaviors": { "Quantity": 2, "Items": [
$(api_behavior "/api/*" "$all_methods"),
$(api_behavior "/healthz" "$get_head")
  ] },
  "ViewerCertificate": {
    "ACMCertificateArn": "${CERT_ARN}",
    "SSLSupportMethod": "sni-only",
    "MinimumProtocolVersion": "TLSv1.2_2021"
  },
  "Restrictions": { "GeoRestriction": { "RestrictionType": "none", "Quantity": 0 } }
}
JSON
    python3 -m json.tool "$WORK/dist.json" >/dev/null || die "internal error: bad distribution JSON"
    DIST_ID="$(aws cloudfront create-distribution --distribution-config "file://$WORK/dist.json" \
      --query Distribution.Id --output text)"
    info "created $DIST_ID"
  fi
  DIST_DOMAIN="$(aws cloudfront get-distribution --id "$DIST_ID" --query Distribution.DomainName --output text)"
  info "CloudFront address: $DIST_DOMAIN"
}

# ---------------------------------------------------------------- Route 53
ensure_dns() {
  say "Route 53: $DOMAIN and $WWW -> CloudFront"
  local n existing conflict=""
  for n in "$DOMAIN" "$WWW"; do
    existing="$(q route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" \
      --query "ResourceRecordSets[?Name=='${n}.' && (Type=='A' || Type=='AAAA' || Type=='CNAME')].[Type, AliasTarget.DNSName, ResourceRecords[0].Value]")"
    if [ -n "$existing" ]; then
      if printf '%s' "$existing" | grep -q CNAME; then
        conflict="$conflict
    $n has a CNAME record; delete it in the Route 53 console first (A/AAAA aliases can't coexist with it)."
      elif ! printf '%s' "$existing" | grep -qi "$DIST_DOMAIN"; then
        warn "$n currently points somewhere else:"
        printf '%s\n' "$existing" | sed 's/^/        /' >&2
        conflict="${conflict:-ask}"
      fi
    fi
  done
  case "$conflict" in
    "") ;;
    ask)
      if [ "${YES:-0}" != 1 ]; then
        printf '    Replace those records so the site goes live on CloudFront? [y/N] '
        read -r ans
        case "$ans" in y|Y|yes|YES) ;; *) die "Stopped before changing DNS. Re-run with YES=1 to replace them.";; esac
      fi ;;
    *) die "$conflict" ;;
  esac

  {
    printf '{"Comment":"Boardle %s -> CloudFront","Changes":[' "$DOMAIN"
    local first=1 t
    for n in "$DOMAIN" "$WWW"; do
      for t in A AAAA; do
        if [ $first = 1 ]; then first=0; else printf ','; fi
        printf '{"Action":"UPSERT","ResourceRecordSet":{"Name":"%s","Type":"%s","AliasTarget":{"HostedZoneId":"%s","DNSName":"%s","EvaluateTargetHealth":false}}}' \
          "$n" "$t" "$CF_ZONE_ID" "$DIST_DOMAIN"
      done
    done
    printf ']}'
  } > "$WORK/dns.json"
  local change
  change="$(aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" \
    --change-batch "file://$WORK/dns.json" --query ChangeInfo.Id --output text)"
  aws route53 wait resource-record-sets-changed --id "$change"
  info "A + AAAA alias records in place for both names"
}

wait_deployed() {
  say "Waiting for CloudFront to finish deploying (first time: 5-15 minutes)"
  aws cloudfront wait distribution-deployed --id "$DIST_ID"
  info "deployed"
}

smoke_test() {
  say "Checking https://$DOMAIN/healthz"
  local i=0 out=""
  while [ $i -lt 10 ]; do
    out="$(curl -fsS --max-time 10 "https://$DOMAIN/healthz" 2>/dev/null || true)"
    case "$out" in *'"ok": true'*|*'"ok":true'*) info "$out"; return 0;; esac
    i=$((i + 1)); sleep 15
  done
  warn "No healthy answer yet (DNS can take a few minutes to reach your Mac). Try: curl https://$DOMAIN/healthz"
}

invalidate() {
  local id
  id="$(aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/*' \
    --query Invalidation.Id --output text)"
  info "CloudFront cache flush $id started (about 1 minute; /* counts as one of 1,000 free paths a month)"
}

# ---------------------------------------------------------------- modes
cmd_deploy() {
  preflight
  say "Route 53 hosted zone for $DOMAIN"
  ZONE_ID="$(hosted_zone_id)"
  [ -n "$ZONE_ID" ] || die "No public Route 53 hosted zone named $DOMAIN in this account."
  info "$ZONE_ID"
  ensure_table
  ensure_role
  ensure_lambda
  ensure_function_url
  ensure_bucket
  upload_static
  ensure_certificate
  ensure_distribution
  put_bucket_policy
  ensure_dns
  wait_deployed
  smoke_test
  say "Done:  https://$DOMAIN   (and https://$WWW)"
  info "Later updates:  DOMAIN=$DOMAIN ./aws/deploy.sh update"
}

cmd_update() {
  preflight
  DIST_ID="$(distribution_id)"
  [ -n "$DIST_ID" ] || die "No CloudFront distribution serves $DOMAIN yet. Run the full deploy first."
  [ -n "$(q lambda get-function-configuration --region "$REGION" --function-name "$FUNC" --query FunctionName)" ] \
    || die "Lambda $FUNC not found. Run the full deploy first."
  say "Updating Lambda code ($FUNC)"
  build_lambda_zip
  aws lambda update-function-code --region "$REGION" --function-name "$FUNC" \
    --zip-file "fileb://$WORK/lambda.zip" >/dev/null
  aws lambda wait function-updated-v2 --region "$REGION" --function-name "$FUNC"
  info "updated"
  upload_static
  say "Flushing CloudFront cache"
  invalidate
  say "Updated https://$DOMAIN  (press Cmd+Shift+R once in the browser)"
}

cmd_status() {
  preflight
  local id
  id="$(hosted_zone_id)";                info "hosted zone:   ${id:-MISSING}"
  info "dynamodb:      $(q dynamodb describe-table --region "$REGION" --table-name "$TABLE" --query Table.TableStatus || true)"
  info "lambda:        $(q lambda get-function-configuration --region "$REGION" --function-name "$FUNC" --query State)"
  info "function url:  $(q lambda get-function-url-config --region "$REGION" --function-name "$FUNC" --query FunctionUrl)"
  info "bucket:        $(aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1 && echo "$BUCKET" || echo MISSING)"
  id="$(distribution_id)"
  if [ -n "$id" ]; then
    info "cloudfront:    $id $(q cloudfront get-distribution --id "$id" --query '[Distribution.Status, Distribution.DomainName]')"
  else
    info "cloudfront:    MISSING"
  fi
  info "health:        $(curl -fsS --max-time 5 "https://$DOMAIN/healthz" 2>/dev/null || echo 'no answer')"
}

case "$MODE" in
  deploy) cmd_deploy ;;
  update) cmd_update ;;
  status) cmd_status ;;
  *) die "Unknown mode '$MODE'. Use: deploy | update | status" ;;
esac
