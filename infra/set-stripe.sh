#!/usr/bin/env bash
# NFFL — store Stripe keys for an environment and attach them to the API.
#
# Run in Google Cloud Shell after setup-gcp.sh, from the infra folder:
#
#   bash set-stripe.sh staging nffl-staging-513215     # Stripe test mode (no real money)
#   bash set-stripe.sh prod    nffl-production         # the league's live Stripe account
#
# The secret key and webhook secret are typed at hidden prompts and go straight
# into Secret Manager; they are never shown or written to disk. Press Enter at
# a prompt to keep the value already stored. Safe to re-run (for example to add
# the webhook secret once the webhook endpoint exists).
#
# Where each value comes from (dashboard.stripe.com; test mode or sandbox for staging):
#   Publishable key  Developers → API keys → Publishable key (pk_test_… / pk_live_…)
#   Secret key       Developers → API keys → Secret key (sk_test_… / sk_live_…)
#   Webhook secret   Developers → Webhooks → your endpoint → Signing secret (whsec_…)

set -euo pipefail

ENV_NAME="${1:-}"
PROJECT="${2:-}"
if [[ "$ENV_NAME" != "staging" && "$ENV_NAME" != "prod" ]] || [[ -z "$PROJECT" ]]; then
  echo "Usage: bash set-stripe.sh <staging|prod> <project-id>" >&2
  exit 1
fi
REGION="${REGION:-us-east1}"
RUNTIME_SA="nffl-api@$PROJECT.iam.gserviceaccount.com"
if [[ "$ENV_NAME" == "prod" ]]; then MODE="live"; else MODE="test"; fi

ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
note() { printf '    \033[33m!\033[0m %s\n' "$*"; }

gcloud config set project "$PROJECT" >/dev/null

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

echo "Stripe $MODE-mode keys for $ENV_NAME ($PROJECT). Press Enter to keep a stored value."
CURRENT_PK=$(gcloud run services describe "nffl-api-$ENV_NAME" --region="$REGION" --format=json 2>/dev/null |
  jq -r '.spec.template.spec.containers[0].env[]? | select(.name == "STRIPE_PUBLISHABLE_KEY") | .value // empty' || true)

read -rp "Publishable key [${CURRENT_PK:-none}]: " PK
PK="${PK:-$CURRENT_PK}"
PK="$(echo -n "$PK" | tr -d '[:space:]')"
if [[ "$PK" != pk_${MODE}_* ]]; then echo "That isn't a $MODE-mode publishable key (it should start with pk_${MODE}_)." >&2; exit 1; fi

read -rsp "Secret key (hidden): " SK; echo
SK="$(echo -n "$SK" | tr -d '[:space:]')"
if [[ -n "$SK" && "$SK" != sk_${MODE}_* && "$SK" != rk_${MODE}_* ]]; then
  unset SK
  echo "That isn't a $MODE-mode secret key (it should start with sk_${MODE}_). Nothing was saved." >&2
  exit 1
fi
put_secret nffl-stripe-secret-key "$SK"
unset SK
have nffl-stripe-secret-key || { echo "A secret key is required." >&2; exit 1; }

read -rsp "Webhook signing secret (hidden, Enter to skip for now): " WH; echo
WH="$(echo -n "$WH" | tr -d '[:space:]')"
if [[ -n "$WH" && "$WH" != whsec_* ]]; then unset WH; echo "Webhook signing secrets start with whsec_. Nothing was saved." >&2; exit 1; fi
put_secret nffl-stripe-webhook-secret "$WH"
unset WH

SECRETS="STRIPE_SECRET_KEY=nffl-stripe-secret-key:latest"
have nffl-stripe-webhook-secret && SECRETS="$SECRETS,STRIPE_WEBHOOK_SECRET=nffl-stripe-webhook-secret:latest"
ARGS=(--region="$REGION" --update-env-vars="STRIPE_PUBLISHABLE_KEY=$PK" --update-secrets="$SECRETS" --quiet)

gcloud run services update "nffl-api-$ENV_NAME" "${ARGS[@]}" >/dev/null
ok "API updated (restarts with the new keys)"
for job in "nffl-migrate-$ENV_NAME" "nffl-worker-$ENV_NAME"; do
  gcloud run jobs update "$job" "${ARGS[@]}" >/dev/null
  ok "job $job updated"
done

if [[ "$ENV_NAME" == "prod" ]]; then SITE="https://nfflag.com"; else SITE="https://staging.nfflag.com"; fi
have nffl-stripe-webhook-secret || note "No webhook secret yet: add the endpoint below in Stripe, then re-run this script."
echo
echo "In the Stripe dashboard ($MODE mode) → Developers → Webhooks → Add endpoint:"
echo "  Endpoint URL:  $SITE/api/v1/webhooks/stripe"
echo "  Events:        payment_intent.succeeded payment_intent.payment_failed payment_intent.canceled"
echo "                 refund.created refund.updated refund.failed"
