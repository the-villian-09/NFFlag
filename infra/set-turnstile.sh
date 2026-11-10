#!/usr/bin/env bash
# NFFL — turn on the invisible "are you human" check (Cloudflare Turnstile) for
# sign-up, password reset, resend-confirmation and the contact form.
#
# Before running:
#   1. Cloudflare dashboard → Turnstile → Add widget: name "NFFL", hostnames
#      nfflag.com and staging.nfflag.com, Widget mode "Invisible". It shows a
#      Site Key (public) and a Secret Key (private).
#   2. Vercel → nffl-web → Settings → Environment Variables: add
#      NEXT_PUBLIC_TURNSTILE_SITE_KEY = the Site Key, for Production AND Preview,
#      then redeploy staging (main) and nfflag.com (branch production).
#
# Then, in Google Cloud Shell from the infra folder:
#
#   bash set-turnstile.sh staging nffl-staging-513215
#   bash set-turnstile.sh prod    nffl-production
#
# It asks for the Secret Key (hidden as you paste), stores it in Secret
# Manager (nffl-turnstile-secret), attaches it to the API, and checks that a
# sign-up without the check is refused while the site still works. If the
# check fails, it detaches the key again. Safe to re-run.

set -euo pipefail

ENV_NAME="${1:-}"
PROJECT="${2:-}"
if [[ "$ENV_NAME" != "staging" && "$ENV_NAME" != "prod" ]] || [[ -z "$PROJECT" ]]; then
  echo "Usage: bash set-turnstile.sh <staging|prod> <project-id>" >&2
  exit 1
fi
REGION="${REGION:-us-east1}"
SERVICE="nffl-api-$ENV_NAME"
RUNTIME_SA="nffl-api@$PROJECT.iam.gserviceaccount.com"
if [[ "$ENV_NAME" == "prod" ]]; then SITE="https://nfflag.com"; else SITE="https://staging.nfflag.com"; fi

ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
note() { printf '    \033[33m!\033[0m %s\n' "$*"; }

gcloud config set project "$PROJECT" >/dev/null

# The website must already send the check, or every sign-up would be refused.
# (Site keys start with 0x4AAAA and are built into the page's scripts.)
found=false
for f in $(curl -s "$SITE/sign-up" | grep -o '/_next/static/[^"]*\.js' | sort -u); do
  if curl -s "$SITE$f" | grep -q '0x4AAAA'; then found=true; break; fi
done
if ! $found; then
  note "$SITE doesn't have the site key yet. Add NEXT_PUBLIC_TURNSTILE_SITE_KEY in Vercel and redeploy first."
  exit 1
fi
ok "the website has the Turnstile site key"

USE_STORED=false
if gcloud secrets describe nffl-turnstile-secret >/dev/null 2>&1; then
  read -rp "A Turnstile secret is already stored. Keep using it? [Y/n] " a
  [[ ! "$a" =~ ^[Nn] ]] && USE_STORED=true
fi
if ! $USE_STORED; then
  read -rsp "Paste the Turnstile Secret Key (hidden), then Enter: " KEY; echo
  KEY=$(printf '%s' "$KEY" | tr -d '[:space:]')
  if [[ ${#KEY} -lt 20 ]]; then note "that doesn't look like a secret key"; exit 1; fi
  if gcloud secrets describe nffl-turnstile-secret >/dev/null 2>&1; then
    printf '%s' "$KEY" | gcloud secrets versions add nffl-turnstile-secret --data-file=- >/dev/null
  else
    printf '%s' "$KEY" | gcloud secrets create nffl-turnstile-secret --replication-policy=automatic --data-file=- >/dev/null
  fi
  unset KEY
  ok "stored in Secret Manager (nffl-turnstile-secret)"
fi
gcloud secrets add-iam-policy-binding nffl-turnstile-secret --member="serviceAccount:$RUNTIME_SA" \
  --role=roles/secretmanager.secretAccessor >/dev/null

gcloud run services update "$SERVICE" --region="$REGION" \
  --update-secrets="TURNSTILE_SECRET_KEY=nffl-turnstile-secret:latest" --quiet >/dev/null
ok "attached to $SERVICE"

echo "Checking..."
sleep 10
site=$(curl -s -o /dev/null -w '%{http_code}' "$SITE/api/v1/site" || true)
# A sign-up with no check must be refused (400), before any account is made.
bot=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$SITE/api/auth/sign-up/email" \
  -H 'content-type: application/json' -H "origin: $SITE" \
  -d '{"email":"turnstile-check@example.com","password":"not-a-real-account-123","name":"Check"}' || true)
if [[ "$site" == "200" && "$bot" == "400" ]]; then
  ok "site works ($site); sign-up without the check is refused ($bot)"
  echo "Done. Try signing up on $SITE in a private window to see it pass for a real person."
else
  note "site returned $site (expected 200), sign-up without the check $bot (expected 400)"
  note "Undoing: detaching the key so sign-ups keep working."
  gcloud run services update "$SERVICE" --region="$REGION" --remove-secrets=TURNSTILE_SECRET_KEY --quiet >/dev/null
  ok "detached. Send me the lines above."
  exit 1
fi
