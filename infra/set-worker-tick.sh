#!/usr/bin/env bash
# NFFL — run the background worker inside the API instead of starting a Cloud
# Run job every minute (Nov 11: the job billed ~25 s of start-up per run,
# about $3/day; the API does the same work in about a second).
#
# Run in Google Cloud Shell from the infra folder, staging first:
#
#   bash set-worker-tick.sh staging nffl-staging-513215
#   bash set-worker-tick.sh prod    nffl-production
#
# What it does:
#   1. Tells the API which Google service account may call POST /internal/tick
#      (the existing nffl-scheduler account) and for which address.
#   2. Checks the API answers that address and refuses a call without a token.
#   3. Creates a Cloud Scheduler job (nffl-api-<env>-tick) that calls it with a
#      Google-signed token, runs it once, and checks it succeeded.
#   4. Only then pauses the old job trigger (nffl-worker-<env>-tick).
# If a check fails, the old trigger keeps running and nothing else changes.
#
# Switch back any time:
#   gcloud scheduler jobs pause  nffl-api-<env>-tick    --location=us-east1
#   gcloud scheduler jobs resume nffl-worker-<env>-tick --location=us-east1

set -euo pipefail

ENV_NAME="${1:-}"
PROJECT="${2:-}"
if [[ "$ENV_NAME" != "staging" && "$ENV_NAME" != "prod" ]] || [[ -z "$PROJECT" ]]; then
  echo "Usage: bash set-worker-tick.sh <staging|prod> <project-id>" >&2
  exit 1
fi
REGION="${REGION:-us-east1}"
SERVICE="nffl-api-$ENV_NAME"
SCHED_SA="nffl-scheduler@$PROJECT.iam.gserviceaccount.com"
OLD="nffl-worker-$ENV_NAME-tick"
NEW="nffl-api-$ENV_NAME-tick"

ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
note() { printf '    \033[33m!\033[0m %s\n' "$*"; }

gcloud config set project "$PROJECT" >/dev/null
API_URL=$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')
TICK_URL="$API_URL/internal/tick"

echo "How often should the worker run on $ENV_NAME?"
echo "    1) every minute (recommended for prod: receipts and waitlist offers go out right away)"
echo "    2) every 5 minutes"
echo "    3) every 15 minutes"
read -rp "Choose 1, 2 or 3 [1]: " c
case "${c:-1}" in
  2) SCHEDULE="*/5 * * * *" ;;
  3) SCHEDULE="*/15 * * * *" ;;
  *) SCHEDULE="* * * * *" ;;
esac

# 1. Who may call the tick.
gcloud run services update "$SERVICE" --region="$REGION" \
  --update-env-vars="WORKER_TICK_SA=$SCHED_SA,WORKER_TICK_AUDIENCE=$API_URL" --quiet >/dev/null
ok "the API accepts the worker tick from $SCHED_SA"

# 2. The new code is live and refuses strangers.
sleep 5
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$TICK_URL" || true)
if [[ "$code" != "401" ]]; then
  note "$TICK_URL answered $code (expected 401). Is the latest code deployed to $ENV_NAME? Nothing else was changed."
  exit 1
fi
ok "a call without the scheduler's token is refused (401)"

# 3. The new trigger.
ARGS=(--location="$REGION" --schedule="$SCHEDULE" --time-zone="America/New_York"
  --uri="$TICK_URL" --http-method=POST
  --oidc-service-account-email="$SCHED_SA" --oidc-token-audience="$API_URL"
  --attempt-deadline=300s)
if gcloud scheduler jobs describe "$NEW" --location="$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$NEW" "${ARGS[@]}" --quiet >/dev/null
  gcloud scheduler jobs resume "$NEW" --location="$REGION" >/dev/null 2>&1 || true
else
  gcloud scheduler jobs create http "$NEW" "${ARGS[@]}" --quiet >/dev/null
fi
ok "scheduler job $NEW calls the API ($SCHEDULE)"

before=$(gcloud scheduler jobs describe "$NEW" --location="$REGION" --format='value(lastAttemptTime)')
gcloud scheduler jobs run "$NEW" --location="$REGION" >/dev/null
echo "Running it once to check..."
after="$before"
for _ in $(seq 1 24); do
  sleep 5
  after=$(gcloud scheduler jobs describe "$NEW" --location="$REGION" --format='value(lastAttemptTime)')
  [[ -n "$after" && "$after" != "$before" ]] && break
done
status=$(gcloud scheduler jobs describe "$NEW" --location="$REGION" --format='value(status.code)')
if [[ -z "$after" || "$after" == "$before" || -n "$status" ]]; then
  note "the test run didn't succeed (status: ${status:-no answer yet}). Pausing $NEW; the old trigger keeps running."
  gcloud scheduler jobs pause "$NEW" --location="$REGION" >/dev/null
  echo "    Send me this, plus: gcloud logging read 'resource.labels.service_name=\"$SERVICE\" AND jsonPayload.message:\"worker tick\"' --freshness=10m --limit=5"
  exit 1
fi
ok "test run succeeded"

# 4. Retire the old trigger (the job itself stays, as a fallback).
if gcloud scheduler jobs describe "$OLD" --location="$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs pause "$OLD" --location="$REGION" >/dev/null
  ok "paused the old trigger $OLD (the Cloud Run job stays, unused)"
fi

echo
echo "Done. The API now runs the worker $([[ "$SCHEDULE" == "* * * * *" ]] && echo "every minute" || echo "on '$SCHEDULE'")."
echo "To switch back:"
echo "    gcloud scheduler jobs pause  $NEW --location=$REGION"
echo "    gcloud scheduler jobs resume $OLD --location=$REGION"
