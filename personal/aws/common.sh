# shellcheck shell=bash
# shellcheck disable=SC2034  # variables are used by the scripts that source this file
# Shared settings + helpers for deploy.sh and destroy.sh. Not meant to be run directly.
# Works with macOS's stock bash 3.2 (no associative arrays, no ${x,,}, no mapfile).

: "${DOMAIN:?Set DOMAIN, e.g.  DOMAIN=ch35s.com ./aws/deploy.sh}"
REGION="${REGION:-us-east-1}"          # where Lambda, DynamoDB and the S3 bucket live
CERT_REGION="us-east-1"                # CloudFront only accepts ACM certificates from us-east-1
WWW="www.${DOMAIN}"
NAME="${NAME:-boardle-$(printf '%s' "$DOMAIN" | tr '.' '-')}"   # prefix for every resource
TABLE="${TABLE:-$NAME}"
ROLE="${NAME}-lambda"
FUNC="${NAME}-api"
OAC_NAME="${NAME}-oac"
LOG_GROUP="/aws/lambda/${FUNC}"
CF_ZONE_ID="Z2FDTNDATAQYW2"           # fixed Route 53 zone id for every CloudFront alias target

export AWS_PAGER=""                    # never open `less` for CLI output
if [ -n "${PROFILE:-}" ]; then export AWS_PROFILE="$PROFILE"; fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"   # the personal/ folder

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m    WARNING: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# Run an aws query that may legitimately find nothing; prints "" instead of "None"/errors.
q() {
  local out
  out="$(aws "$@" --output text 2>/dev/null)" || out=""
  if [ "$out" = "None" ]; then out=""; fi
  printf '%s' "$out"
}

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is not installed. $2"; }

preflight() {
  need aws "Install it with:  brew install awscli   (or the .pkg from https://aws.amazon.com/cli/)"
  need python3 "Install Xcode command line tools:  xcode-select --install"
  need zip "Install Xcode command line tools:  xcode-select --install"
  case "$(aws --version 2>&1)" in
    aws-cli/2.*) ;;
    *) die "AWS CLI v2 is required (found: $(aws --version 2>&1))." ;;
  esac
  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
    || die "AWS CLI is not signed in. Run:  aws login   (then: aws sts get-caller-identity)"
  BUCKET="${BUCKET:-${NAME}-site-${ACCOUNT_ID}}"
  info "AWS account $ACCOUNT_ID, region $REGION, profile ${AWS_PROFILE:-default}"
  info "Domain $DOMAIN + $WWW, resource prefix $NAME"
}

hosted_zone_id() {
  local id
  id="$(q route53 list-hosted-zones-by-name --dns-name "${DOMAIN}." \
        --query "HostedZones[?Name=='${DOMAIN}.' && Config.PrivateZone==\`false\`].Id | [0]")"
  printf '%s' "${id#/hostedzone/}"
}

distribution_id() {   # the distribution that already serves $DOMAIN, if any
  q cloudfront list-distributions \
    --query "DistributionList.Items[?Aliases.Quantity > \`0\` && contains(Aliases.Items, '${DOMAIN}')].Id | [0]"
}
