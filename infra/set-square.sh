#!/usr/bin/env bash
# NFFL — store Square settings for an environment and attach them to the API.
#
# Run in Google Cloud Shell after setup-gcp.sh, from the infra folder:
#
#   bash set-square.sh staging nffl-staging-513215     # Square Sandbox (test payments)
#   bash set-square.sh prod    nffl-production         # Square production (real payments)
#
# Secrets are typed at hidden prompts and go straight into Secret Manager;
# they are never shown or written to disk. Press Enter at a prompt to keep
# the value already stored. Safe to re-run (for example to add the webhook
# signature key once the webhook subscription exists).
#
# Where each value comes from (developer.squareup.com → your app):
#   Application ID      Credentials page (Sandbox or Production toggle)
#   Application secret  OAuth page (Sandbox or Production toggle) → "Application secret"
#   Access token        Sandbox only: Credentials page → Sandbox access token
#   Location ID         Sandbox only: Locations page → the Sandbox location id
#   Webhook key         Webhooks → Subscriptions → your subscription → "Signature key"

set -euo pipefail

ENV_NAME="${1:-}"
PROJECT="${2:-}"
if [[ "$ENV_NAME" != "staging" && "$ENV_NAME" != "prod" ]] || [[ -z "$PROJECT" ]]; then
  echo "Usage: bash set-square.sh <staging|prod> <project-id>" >&2
  exit 1
fi
REGION="${REGION:-us-east1}"
RUNTIME_SA="nffl-api@$PROJECT.iam.gserviceaccount.com"
if [[ "$ENV_NAME" == "prod" ]]; then SQ_ENV="production"; else SQ_ENV="sandbox"; fi

ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
note() { printf '    \033[33m!\033[0m %s\n' "$*"; }

gcloud config set project "$PROJECT" >/dev/null

# Stores a secret version if a value was typed; prints nothing secret.
put_secret() {
  local name=$1 value=$2
  [[ -z "$value" ]] && return 0
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
  else
    printf '%s' "$value" | gcloud secrets create "$name" --replication-policy=automatic --data-file=- >/dev/null
  fi
  gcloud secrets add-iam-policy-binding "$name" --member="serviceAccount:$RUNTIME_SA" \
    --role=roles/secretmanager.secretAccessor >/dev/null
  ok "$name saved"
}
have() { gcloud secrets describe "$1" >/dev/null 2>&1; }

echo "Square $SQ_ENV settings for $ENV_NAME ($PROJECT). Press Enter to keep a stored value."
current_env() {
  gcloud run services describe "nffl-api-$ENV_NAME" --region="$REGION" --format=json 2>/dev/null |
    jq -r --arg n "$1" '.spec.template.spec.containers[0].env[]? | select(.name == $n) | .value // empty' || true
}
CURRENT_APP_ID=$(current_env SQUARE_APPLICATION_ID)
CURRENT_LOCATION_ID=$(current_env SQUARE_LOCATION_ID)

read -rp "Application ID [${CURRENT_APP_ID:-none}]: " APP_ID
APP_ID="${APP_ID:-$CURRENT_APP_ID}"
APP_ID="$(echo -n "$APP_ID" | tr -d '[:space:]')"
if [[ -z "$APP_ID" ]]; then echo "An Application ID is required." >&2; exit 1; fi
if [[ "$SQ_ENV" == "sandbox" && "$APP_ID" != sandbox-* ]]; then note "Sandbox Application IDs start with sandbox-; double-check you copied the Sandbox one."; fi
if [[ "$SQ_ENV" == "production" && "$APP_ID" == sandbox-* ]]; then echo "That's a Sandbox Application ID; production needs the Production one." >&2; exit 1; fi

read -rsp "Application secret (hidden): " APP_SECRET; echo
put_secret nffl-square-app-secret "$(echo -n "$APP_SECRET" | tr -d '[:space:]')"
unset APP_SECRET

LOCATION_ID=""
if [[ "$SQ_ENV" == "sandbox" ]]; then
  read -rsp "Sandbox access token (hidden): " TOKEN; echo
  put_secret nffl-square-access-token "$(echo -n "$TOKEN" | tr -d '[:space:]')"
  unset TOKEN
  read -rp "Sandbox location ID [${CURRENT_LOCATION_ID:-none}]: " LOCATION_ID
  LOCATION_ID="${LOCATION_ID:-$CURRENT_LOCATION_ID}"
  LOCATION_ID="$(echo -n "$LOCATION_ID" | tr -d '[:space:]')"
fi

read -rsp "Webhook signature key (hidden, Enter to skip for now): " WH; echo
put_secret nffl-square-webhook-key "$(echo -n "$WH" | tr -d '[:space:]')"
unset WH

SECRETS=""
add_secret() { have "$2" && SECRETS="${SECRETS:+$SECRETS,}$1=$2:latest" || true; }
add_secret SQUARE_APPLICATION_SECRET nffl-square-app-secret
add_secret SQUARE_WEBHOOK_SIGNATURE_KEY nffl-square-webhook-key
[[ "$SQ_ENV" == "sandbox" ]] && add_secret SQUARE_ACCESS_TOKEN nffl-square-access-token

ENVVARS="^|^SQUARE_ENVIRONMENT=$SQ_ENV|SQUARE_APPLICATION_ID=$APP_ID"
[[ -n "$LOCATION_ID" ]] && ENVVARS="$ENVVARS|SQUARE_LOCATION_ID=$LOCATION_ID"

ARGS=(--region="$REGION" --update-env-vars="$ENVVARS" --quiet)
[[ -n "$SECRETS" ]] && ARGS+=(--update-secrets="$SECRETS")

gcloud run services update "nffl-api-$ENV_NAME" "${ARGS[@]}" >/dev/null
ok "API updated (restarts with the new settings)"
for job in "nffl-migrate-$ENV_NAME" "nffl-worker-$ENV_NAME"; do
  gcloud run jobs update "$job" "${ARGS[@]}" >/dev/null
  ok "job $job updated"
done

have nffl-square-webhook-key || note "No webhook key yet: create the webhook subscription in Square, then re-run this script."
if [[ "$ENV_NAME" == "prod" ]]; then SITE="https://nfflag.com"; else SITE="https://staging.nfflag.com"; fi
echo
echo "In the Square Developer Dashboard ($SQ_ENV), make sure:"
echo "  OAuth redirect URL:  $SITE/api/v1/square/oauth/callback"
echo "  Webhook URL:         $SITE/api/v1/webhooks/square"
echo "  Webhook events:      payment.created payment.updated refund.created refund.updated oauth.authorization.revoked"
