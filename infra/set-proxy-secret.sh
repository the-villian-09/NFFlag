#!/usr/bin/env bash
# NFFL — make the API accept requests only from the website (security audit H3/M2).
#
# Run in Google Cloud Shell, from the infra folder:
#
#   bash set-proxy-secret.sh staging nffl-staging-513215
#   bash set-proxy-secret.sh prod    <prod project id>
#
# What it does, in the only safe order:
#   1. Makes a random secret, stores it in Secret Manager (nffl-proxy-secret) and
#      shows it ONCE so you can paste it into Vercel.
#   2. Waits while you add it in Vercel and redeploy the website.
#   3. Attaches it to the API. From then on the API refuses requests that didn't
#      come through the website, and trusts only the visitor IP the website sends.
#   4. Checks the website still works; if not, it detaches the secret again.
#
# Re-running offers to keep the stored secret (no Vercel change needed) or make
# a new one (repeat the Vercel step). Safe to re-run.

set -euo pipefail

ENV_NAME="${1:-}"
PROJECT="${2:-}"
if [[ "$ENV_NAME" != "staging" && "$ENV_NAME" != "prod" ]] || [[ -z "$PROJECT" ]]; then
  echo "Usage: bash set-proxy-secret.sh <staging|prod> <project-id>" >&2
  exit 1
fi
REGION="${REGION:-us-east1}"
SERVICE="nffl-api-$ENV_NAME"
RUNTIME_SA="nffl-api@$PROJECT.iam.gserviceaccount.com"
if [[ "$ENV_NAME" == "prod" ]]; then SITE="https://nfflag.com"; else SITE="https://staging.nfflag.com"; fi

ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
note() { printf '    \033[33m!\033[0m %s\n' "$*"; }

gcloud config set project "$PROJECT" >/dev/null
API_URL=$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')

REUSE=false
if gcloud secrets describe nffl-proxy-secret >/dev/null 2>&1; then
  read -rp "A secret is already stored (and probably already in Vercel). Keep using it? [Y/n] " a
  [[ ! "$a" =~ ^[Nn] ]] && REUSE=true
fi

if $REUSE; then
  ok "keeping the stored secret; it's not shown again"
  echo
  echo "Step 2 — make sure the website is using it:"
else
  SECRET=$(openssl rand -hex 32)
  if gcloud secrets describe nffl-proxy-secret >/dev/null 2>&1; then
    printf '%s' "$SECRET" | gcloud secrets versions add nffl-proxy-secret --data-file=- >/dev/null
  else
    printf '%s' "$SECRET" | gcloud secrets create nffl-proxy-secret --replication-policy=automatic --data-file=- >/dev/null
  fi
  gcloud secrets add-iam-policy-binding nffl-proxy-secret --member="serviceAccount:$RUNTIME_SA" \
    --role=roles/secretmanager.secretAccessor >/dev/null
  ok "secret stored in Secret Manager (nffl-proxy-secret)"
  echo
  echo "Step 2 — add it to Vercel (project nffl-web → Settings → Environment Variables → Add)."
  echo "Copy it straight into Vercel; don't paste it anywhere else."
  echo "    Type:  Secret"
  echo "    Key:   API_PROXY_SECRET"
  echo "    Value: $SECRET"
  unset SECRET
  if [[ "$ENV_NAME" == "prod" ]]; then
    echo "    Environments: untick Production; Preview Branches → production"
  else
    echo "    Environments: Production and Preview (Vercel's 'Production' is staging here)"
  fi
fi
if [[ "$ENV_NAME" == "prod" ]]; then
  echo "    Redeploy nfflag.com: Deployments → filter Branch = production → the newest row"
  echo "    (its branch says 'production', NOT main) → ⋯ → Redeploy. Wait for Ready."
else
  echo "    Redeploy staging: Deployments → the newest row from branch main → ⋯ → Redeploy. Wait for Ready."
fi
echo
read -rp "Press Enter once the website has finished redeploying with the new variable... "
clear 2>/dev/null || true

gcloud run services update "$SERVICE" --region="$REGION" \
  --update-secrets="API_PROXY_SECRET=nffl-proxy-secret:latest" --quiet >/dev/null
ok "attached to $SERVICE"

echo "Checking..."
sleep 10
site=$(curl -s -o /dev/null -w '%{http_code}' "$SITE/api/v1/site" || true)
direct=$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/api/v1/site" || true)
health=$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/api/v1/health" || true)
if [[ "$site" == "200" && "$direct" == "404" && "$health" == "200" ]]; then
  ok "website → API works ($site); direct calls refused ($direct); health check open ($health)"
  echo "Done. The API only answers the website now."
else
  note "website returned $site (expected 200), direct call $direct (expected 404), health $health (expected 200)"
  note "Undoing: detaching the secret from the API so the site keeps working."
  gcloud run services update "$SERVICE" --region="$REGION" --remove-secrets=API_PROXY_SECRET --quiet >/dev/null
  ok "detached. Check the Vercel variable (name, value, environment) and the redeploy, then run this again."
  exit 1
fi
