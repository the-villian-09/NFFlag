#!/usr/bin/env bash
# NFFL — turn on phone/browser notifications for team pages (Web Push).
#
# Run in Google Cloud Shell from the infra folder:
#
#   bash set-push.sh staging nffl-staging-513215
#   bash set-push.sh prod    nffl-production
#
# Makes a VAPID key pair right here in Cloud Shell (nothing to copy or paste),
# stores the private key in Secret Manager and gives the public key to the API.
# Re-running keeps the existing keys: making new ones would silently cut off
# every phone that already turned notifications on. Pass --rotate to replace them anyway.

set -euo pipefail

ENV_NAME="${1:-}"
PROJECT="${2:-}"
ROTATE="${3:-}"
if [[ "$ENV_NAME" != "staging" && "$ENV_NAME" != "prod" ]] || [[ -z "$PROJECT" ]]; then
  echo "Usage: bash set-push.sh <staging|prod> <project-id> [--rotate]" >&2
  exit 1
fi
REGION="${REGION:-us-east1}"
RUNTIME_SA="nffl-api@$PROJECT.iam.gserviceaccount.com"
SECRET=nffl-vapid-private-key
SUBJECT="${VAPID_SUBJECT:-mailto:info@nfflag.com}"

ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }

gcloud config set project "$PROJECT" >/dev/null

CURRENT_PUB=$(gcloud run services describe "nffl-api-$ENV_NAME" --region="$REGION" --format=json 2>/dev/null |
  jq -r '.spec.template.spec.containers[0].env[]? | select(.name == "VAPID_PUBLIC_KEY") | .value // empty' || true)

if [[ -n "$CURRENT_PUB" ]] && gcloud secrets describe "$SECRET" >/dev/null 2>&1 && [[ "$ROTATE" != "--rotate" ]]; then
  PUB="$CURRENT_PUB"
  ok "Keeping the existing keys"
else
  KEYS=$(npx --yes web-push@3.6.7 generate-vapid-keys --json)
  PUB=$(jq -r .publicKey <<<"$KEYS")
  PRIV=$(jq -r .privateKey <<<"$KEYS")
  unset KEYS
  if gcloud secrets describe "$SECRET" >/dev/null 2>&1; then
    printf '%s' "$PRIV" | gcloud secrets versions add "$SECRET" --data-file=- >/dev/null
  else
    printf '%s' "$PRIV" | gcloud secrets create "$SECRET" --replication-policy=automatic --data-file=- >/dev/null
  fi
  unset PRIV
  gcloud secrets add-iam-policy-binding "$SECRET" --member="serviceAccount:$RUNTIME_SA" \
    --role=roles/secretmanager.secretAccessor >/dev/null
  ok "New key pair made; private key saved as $SECRET"
fi

ARGS=(--region="$REGION" --update-env-vars="VAPID_PUBLIC_KEY=$PUB,VAPID_SUBJECT=$SUBJECT" --update-secrets="VAPID_PRIVATE_KEY=$SECRET:latest" --quiet)
gcloud run services update "nffl-api-$ENV_NAME" "${ARGS[@]}" >/dev/null
ok "API updated (restarts with notifications on)"
for job in "nffl-migrate-$ENV_NAME" "nffl-worker-$ENV_NAME"; do
  gcloud run jobs update "$job" "${ARGS[@]}" >/dev/null
  ok "job $job updated"
done
echo
echo "Done. Families can now tap Team → Notifications → Turn on."
