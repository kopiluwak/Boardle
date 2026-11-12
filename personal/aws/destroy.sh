#!/usr/bin/env bash
# Boardle on AWS -- TEARDOWN.  Removes what deploy.sh created for $DOMAIN.
#
#   DOMAIN=ch35s.com ./aws/destroy.sh                 # site offline, player data KEPT
#   DOMAIN=ch35s.com DELETE_DATA=1 ./aws/destroy.sh   # ALSO deletes every account + history
#
# !!! WARNING !!!
#   * ch35s.com and www.ch35s.com stop working as soon as this starts.
#   * Only the A/AAAA records that point at THIS CloudFront distribution are deleted; other
#     DNS records and the hosted zone itself are never touched.
#   * Player accounts/history (DynamoDB table) are kept unless DELETE_DATA=1. With
#     DELETE_DATA=1 an on-demand backup is taken first (it keeps costing ~$0.10/GB-month
#     until you delete it under DynamoDB > Backups), then the table is deleted for good.
#   * Disabling a CloudFront distribution takes 5-15 minutes before it can be deleted;
#     the script waits.
#   * You must type the domain name to confirm (or set CONFIRM=<domain>).
set -euo pipefail
# shellcheck source=common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/boardle-destroy.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

preflight
printf '\nThis takes https://%s offline%s.\n' "$DOMAIN" \
  "$([ "${DELETE_DATA:-0}" = 1 ] && echo ' AND DELETES ALL PLAYER DATA' || echo ' (player data is kept)')"
if [ "${CONFIRM:-}" != "$DOMAIN" ]; then
  printf 'Type the domain name to continue: '
  read -r CONFIRM
  [ "$CONFIRM" = "$DOMAIN" ] || die "Not confirmed; nothing changed."
fi

DIST_ID="$(distribution_id)"
ZONE_ID="$(hosted_zone_id)"

# 1. DNS aliases that point at our distribution
if [ -n "$DIST_ID" ] && [ -n "$ZONE_ID" ]; then
  say "Removing Route 53 alias records"
  DIST_DOMAIN="$(aws cloudfront get-distribution --id "$DIST_ID" --query Distribution.DomainName --output text)"
  aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" --output json \
    --query "ResourceRecordSets[?(Name=='${DOMAIN}.' || Name=='${WWW}.') && (Type=='A' || Type=='AAAA') && AliasTarget.DNSName=='${DIST_DOMAIN}.']" \
    > "$WORK/recs.json"
  python3 - "$WORK/recs.json" "$WORK/del.json" <<'PY'
import json, sys
recs = json.load(open(sys.argv[1]))
json.dump({"Changes": [{"Action": "DELETE", "ResourceRecordSet": r} for r in recs]}, open(sys.argv[2], "w"))
print("    %d record(s)" % len(recs))
PY
  if python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["Changes"] else 1)' "$WORK/del.json"; then
    aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch "file://$WORK/del.json" >/dev/null
  fi
fi

# 2. CloudFront: disable -> wait -> delete; then the OAC
if [ -n "$DIST_ID" ]; then
  say "Disabling CloudFront distribution $DIST_ID"
  aws cloudfront get-distribution-config --id "$DIST_ID" --output json > "$WORK/cfg.json"
  ETAG="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ETag"])' "$WORK/cfg.json")"
  python3 - "$WORK/cfg.json" "$WORK/disabled.json" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))["DistributionConfig"]
c["Enabled"] = False
json.dump(c, open(sys.argv[2], "w"))
PY
  ETAG="$(aws cloudfront update-distribution --id "$DIST_ID" --if-match "$ETAG" \
    --distribution-config "file://$WORK/disabled.json" --query ETag --output text)"
  info "waiting until disabled everywhere (5-15 minutes)..."
  aws cloudfront wait distribution-deployed --id "$DIST_ID"
  ETAG="$(aws cloudfront get-distribution --id "$DIST_ID" --query ETag --output text)"
  aws cloudfront delete-distribution --id "$DIST_ID" --if-match "$ETAG"
  info "deleted"
fi
OAC_ID="$(q cloudfront list-origin-access-controls --query "OriginAccessControlList.Items[?Name=='${OAC_NAME}'].Id | [0]")"
if [ -n "$OAC_ID" ]; then
  ETAG="$(aws cloudfront get-origin-access-control --id "$OAC_ID" --query ETag --output text)"
  aws cloudfront delete-origin-access-control --id "$OAC_ID" --if-match "$ETAG" && info "OAC $OAC_ID deleted"
fi

# 3. Certificate (only once no distribution uses it). Validation CNAMEs are left in DNS (harmless).
for arn in $(q acm list-certificates --region "$CERT_REGION" \
               --query "CertificateSummaryList[?DomainName=='${DOMAIN}'].CertificateArn"); do
  if [ "$(q acm describe-certificate --region "$CERT_REGION" --certificate-arn "$arn" --query 'length(Certificate.InUseBy)')" = "0" ]; then
    aws acm delete-certificate --region "$CERT_REGION" --certificate-arn "$arn" && info "certificate $arn deleted"
  else
    warn "certificate $arn is still in use; left in place"
  fi
done

# 4. S3 bucket (static files only; they are re-uploaded by deploy.sh)
if aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  say "Deleting bucket $BUCKET"
  aws s3 rm "s3://$BUCKET" --recursive --only-show-errors
  aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION"
fi

# 5. Lambda, its URL and logs, and the IAM role
if [ -n "$(q lambda get-function-configuration --region "$REGION" --function-name "$FUNC" --query FunctionName)" ]; then
  say "Deleting Lambda $FUNC"
  aws lambda delete-function-url-config --region "$REGION" --function-name "$FUNC" 2>/dev/null || true
  aws lambda delete-function --region "$REGION" --function-name "$FUNC"
fi
aws logs delete-log-group --region "$REGION" --log-group-name "$LOG_GROUP" 2>/dev/null || true
if [ -n "$(q iam get-role --role-name "$ROLE" --query Role.RoleName)" ]; then
  say "Deleting IAM role $ROLE"
  aws iam delete-role-policy --role-name "$ROLE" --policy-name boardle-least-privilege 2>/dev/null || true
  aws iam delete-role --role-name "$ROLE"
fi

# 6. Player data
if [ "${DELETE_DATA:-0}" = 1 ]; then
  if [ -n "$(q dynamodb describe-table --region "$REGION" --table-name "$TABLE" --query Table.TableName)" ]; then
    say "Backing up, then deleting DynamoDB table $TABLE"
    aws dynamodb create-backup --region "$REGION" --table-name "$TABLE" \
      --backup-name "${TABLE}-final-$(date +%Y%m%d-%H%M%S)" --query BackupDetails.BackupArn --output text
    aws dynamodb update-table --region "$REGION" --table-name "$TABLE" --no-deletion-protection-enabled >/dev/null
    aws dynamodb wait table-exists --region "$REGION" --table-name "$TABLE"
    aws dynamodb delete-table --region "$REGION" --table-name "$TABLE" >/dev/null
    info "deleted (backup kept; remove it in the DynamoDB console > Backups when you no longer need it)"
  fi
else
  info "DynamoDB table $TABLE kept (player accounts + history). Re-running deploy.sh reuses it."
fi
say "Teardown finished."
