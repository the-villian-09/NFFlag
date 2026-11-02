#!/usr/bin/env bash
# NFFL — create the private bucket for uploads (birth certificates, insurance
# cards, headshots) and connect it to the API.
#
# Run in Google Cloud Shell, from the infra folder:
#
#   bash set-uploads.sh staging nffl-staging-513215
#   bash set-uploads.sh prod    nffl-production
#
# The bucket is private: public access is blocked, and only the API's service
# account can read or write it (the site checks who may see each file).
# Safe to re-run.

set -euo pipefail

ENV_NAME="${1:-}"
PROJECT="${2:-}"
if [[ "$ENV_NAME" != "staging" && "$ENV_NAME" != "prod" ]] || [[ -z "$PROJECT" ]]; then
  echo "Usage: bash set-uploads.sh <staging|prod> <project-id>" >&2
  exit 1
fi
REGION="${REGION:-us-east1}"
RUNTIME_SA="nffl-api@$PROJECT.iam.gserviceaccount.com"
BUCKET="${BUCKET:-$PROJECT-nffl-uploads}"

ok() { printf '    \033[32m✓\033[0m %s\n' "$*"; }

gcloud config set project "$PROJECT" >/dev/null
gcloud services enable storage.googleapis.com >/dev/null

if gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  ok "bucket gs://$BUCKET already exists"
else
  gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access --public-access-prevention >/dev/null
  ok "bucket gs://$BUCKET created"
fi
gcloud storage buckets update "gs://$BUCKET" --uniform-bucket-level-access --public-access-prevention >/dev/null
ok "public access blocked"

gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$RUNTIME_SA" --role=roles/storage.objectAdmin >/dev/null
ok "API service account can read and write files"

ARGS=(--region="$REGION" --update-env-vars="UPLOADS_BUCKET=$BUCKET" --quiet)
gcloud run services update "nffl-api-$ENV_NAME" "${ARGS[@]}" >/dev/null
ok "API updated (restarts with the bucket)"
for job in "nffl-migrate-$ENV_NAME" "nffl-worker-$ENV_NAME"; do
  gcloud run jobs update "$job" "${ARGS[@]}" >/dev/null
  ok "job $job updated"
done

echo
echo "Done. Turn on r6.documents in Admin → Release switches when you're ready to require uploads."
