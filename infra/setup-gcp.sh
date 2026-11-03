#!/usr/bin/env bash
# NFFL — one-time Google Cloud setup for an environment (runbook sections 1–6).
#
# Run in Google Cloud Shell (shell.cloud.google.com), signed in as the project owner:
#
#   curl -fsSLO https://raw.githubusercontent.com/the-villian-09/NFFlag/main/infra/setup-gcp.sh
#   bash setup-gcp.sh staging nffl-staging-513215
#
# Safe to re-run: every step checks what already exists and skips it, so if
# something fails partway, fix it and run the same command again.
#
# Optional settings (put them before `bash`):
#   REGION=us-east1                       Google Cloud region
#   APP_BASE_URL=https://...               Site address (default staging.nfflag.com / nfflag.com)
#   EMAIL_FROM="NFFL <no-reply@nfflag.com>"  Sender for account emails
#   RESEND_API_KEY=re_...                 Turns on real email sending (re-run to add later)
#   DB_TIER=db-f1-micro                   Cloud SQL machine size
#
# What it creates: APIs, image registry, Cloud SQL Postgres 16 + database + user,
# secrets, service accounts, the API service, the migrate and worker jobs, a
# one-minute scheduler for the worker, and keyless GitHub → Google Cloud deploy access.
# The service and jobs start on a Google placeholder image; the first GitHub
# deploy replaces it with the real API.

set -euo pipefail

ENV_NAME="${1:-}"
PROJECT="${2:-}"
if [[ "$ENV_NAME" != "staging" && "$ENV_NAME" != "prod" ]] || [[ -z "$PROJECT" ]]; then
  echo "Usage: bash setup-gcp.sh <staging|prod> <project-id>" >&2
  exit 1
fi

REGION="${REGION:-us-east1}"
GITHUB_REPO="the-villian-09/NFFlag"
GITHUB_REPO_ID="1439832091"   # permanent numeric id; survives renames
INSTANCE="nffl-$ENV_NAME"
DB_NAME="nffl"
DB_USER="nffl_app"
if [[ "$ENV_NAME" == "prod" ]]; then DEFAULT_SITE="https://nfflag.com"; else DEFAULT_SITE="https://staging.nfflag.com"; fi
APP_BASE_URL="${APP_BASE_URL:-$DEFAULT_SITE}"
EMAIL_FROM="${EMAIL_FROM:-NFFL <no-reply@nfflag.com>}"
RESEND_API_KEY="${RESEND_API_KEY:-}"
# Both environments start on the small shared-core tier (decided Oct 30); grow later with:
#   gcloud sql instances patch nffl-<env> --tier=db-g1-small
DB_TIER="${DB_TIER:-db-f1-micro}"
PLACEHOLDER_IMAGE="us-docker.pkg.dev/cloudrun/container/hello"

RUNTIME_SA="nffl-api@$PROJECT.iam.gserviceaccount.com"
DEPLOY_SA="nffl-deployer@$PROJECT.iam.gserviceaccount.com"
SCHED_SA="nffl-scheduler@$PROJECT.iam.gserviceaccount.com"
CONN="$PROJECT:$REGION:$INSTANCE"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
note() { printf '    \033[33m!\033[0m %s\n' "$*"; }

gcloud config set project "$PROJECT" >/dev/null
gcloud config set run/region "$REGION" >/dev/null

step "Checking project and billing"
gcloud projects describe "$PROJECT" --format='value(projectId)' >/dev/null
BILLING=$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null || echo "")
if [[ "$BILLING" != "True" ]]; then
  echo "Billing isn't linked to $PROJECT. Link it in the console (☰ → Billing), then re-run." >&2
  exit 1
fi
ok "project $PROJECT, billing enabled, region $REGION"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')

step "1. Turning on services (takes a minute the first time)"
gcloud services enable \
  run.googleapis.com sqladmin.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com cloudscheduler.googleapis.com cloudbuild.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  cloudresourcemanager.googleapis.com
ok "services on"

if gcloud artifacts repositories describe nffl --location="$REGION" >/dev/null 2>&1; then
  ok "image registry exists"
else
  gcloud artifacts repositories create nffl --repository-format=docker --location="$REGION" \
    --description="NFFL container images"
  ok "image registry created"
fi

step "2. Cloud SQL Postgres 16 ($DB_TIER) — creating takes 5–10 minutes"
if gcloud sql instances describe "$INSTANCE" >/dev/null 2>&1; then
  ok "instance $INSTANCE exists"
else
  PITR_FLAG="--no-enable-point-in-time-recovery"
  [[ "$ENV_NAME" == "prod" ]] && PITR_FLAG="--enable-point-in-time-recovery"
  gcloud sql instances create "$INSTANCE" \
    --database-version=POSTGRES_16 --edition=ENTERPRISE --tier="$DB_TIER" --region="$REGION" \
    --storage-size=10 --storage-auto-increase \
    --backup-start-time=07:00 --retained-backups-count=14 "$PITR_FLAG" \
    --ssl-mode=TRUSTED_CLIENT_CERTIFICATE_REQUIRED \
    --deletion-protection
  ok "instance $INSTANCE created (encrypted connections only)"
fi

if gcloud sql databases describe "$DB_NAME" --instance="$INSTANCE" >/dev/null 2>&1; then
  ok "database $DB_NAME exists"
else
  gcloud sql databases create "$DB_NAME" --instance="$INSTANCE"
  ok "database $DB_NAME created"
fi

step "3. Secrets"
if gcloud secrets describe nffl-database-url >/dev/null 2>&1; then
  ok "database URL secret exists (password unchanged)"
else
  DB_PASS=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)
  if gcloud sql users list --instance="$INSTANCE" --format='value(name)' | grep -qx "$DB_USER"; then
    gcloud sql users set-password "$DB_USER" --instance="$INSTANCE" --password="$DB_PASS"
  else
    gcloud sql users create "$DB_USER" --instance="$INSTANCE" --password="$DB_PASS"
  fi
  printf 'postgres://%s:%s@/%s?host=/cloudsql/%s' "$DB_USER" "$DB_PASS" "$DB_NAME" "$CONN" \
    | gcloud secrets create nffl-database-url --replication-policy=automatic --data-file=-
  unset DB_PASS
  ok "database user and URL secret created"
fi

if gcloud secrets describe nffl-auth-secret >/dev/null 2>&1; then
  ok "auth secret exists"
else
  openssl rand -base64 48 | tr -d '\n' | gcloud secrets create nffl-auth-secret --replication-policy=automatic --data-file=-
  ok "auth secret created"
fi

HAVE_RESEND=false
if [[ -n "$RESEND_API_KEY" ]]; then
  if gcloud secrets describe nffl-resend-key >/dev/null 2>&1; then
    printf '%s' "$RESEND_API_KEY" | gcloud secrets versions add nffl-resend-key --data-file=- >/dev/null
    ok "Resend key updated"
  else
    printf '%s' "$RESEND_API_KEY" | gcloud secrets create nffl-resend-key --replication-policy=automatic --data-file=-
    ok "Resend key stored"
  fi
fi
gcloud secrets describe nffl-resend-key >/dev/null 2>&1 && HAVE_RESEND=true
$HAVE_RESEND || note "no Resend key yet: emails are written to the API log, not sent (re-run with RESEND_API_KEY=... later)"

step "4. Service accounts and permissions"
ensure_sa() {
  if gcloud iam service-accounts describe "$1@$PROJECT.iam.gserviceaccount.com" >/dev/null 2>&1; then
    ok "service account $1 exists"
  else
    gcloud iam service-accounts create "$1" --display-name="$2"
    ok "service account $1 created"
  fi
}
ensure_sa nffl-api "NFFL API runtime"
ensure_sa nffl-deployer "NFFL GitHub deployer"
ensure_sa nffl-scheduler "NFFL worker scheduler"
sleep 5 # new service accounts take a moment to become usable in IAM policies

bind_project() { gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$1" --role="$2" --condition=None >/dev/null; }
bind_project "$RUNTIME_SA" roles/cloudsql.client
bind_project "$DEPLOY_SA" roles/run.admin
bind_project "$DEPLOY_SA" roles/artifactregistry.writer
for s in nffl-database-url nffl-auth-secret $($HAVE_RESEND && echo nffl-resend-key); do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$RUNTIME_SA" \
    --role=roles/secretmanager.secretAccessor >/dev/null
done
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/iam.serviceAccountUser >/dev/null
ok "API can reach the database and its secrets; deployer can deploy"

step "5. API service, migrate job and worker job (placeholder image until the first deploy)"
SECRETS="DATABASE_URL=nffl-database-url:latest,BETTER_AUTH_SECRET=nffl-auth-secret:latest"
$HAVE_RESEND && SECRETS="$SECRETS,RESEND_API_KEY=nffl-resend-key:latest"
# The API and worker use the row-access-only login once harden-gcp.sh has made it
# (security audit M10); migrations always use the owner login.
APP_SECRETS="$SECRETS"
if gcloud secrets describe nffl-database-url-runtime >/dev/null 2>&1; then
  APP_SECRETS="${SECRETS/DATABASE_URL=nffl-database-url:latest/DATABASE_URL=nffl-database-url-runtime:latest}"
fi
ENVVARS="^|^APP_ENV=$ENV_NAME|APP_BASE_URL=$APP_BASE_URL|EMAIL_FROM=$EMAIL_FROM|NODE_ENV=production"

if gcloud run services describe "nffl-api-$ENV_NAME" >/dev/null 2>&1; then
  gcloud run services update "nffl-api-$ENV_NAME" --region="$REGION" \
    --update-secrets="$APP_SECRETS" --update-env-vars="$ENVVARS" --set-cloudsql-instances="$CONN" --quiet >/dev/null
  ok "API service updated"
else
  gcloud run deploy "nffl-api-$ENV_NAME" --image="$PLACEHOLDER_IMAGE" --region="$REGION" \
    --service-account="$RUNTIME_SA" --set-secrets="$SECRETS" --set-env-vars="$ENVVARS" \
    --set-cloudsql-instances="$CONN" --no-invoker-iam-check \
    --min-instances=0 --max-instances=5 --cpu=1 --memory=512Mi --quiet >/dev/null
  ok "API service created"
fi

ensure_job() {
  local name=$1 cmd=$2 args=$3 secrets=${4:-$SECRETS}
  if gcloud run jobs describe "$name" --region="$REGION" >/dev/null 2>&1; then
    gcloud run jobs update "$name" --region="$REGION" --update-secrets="$secrets" \
      --update-env-vars="$ENVVARS" --set-cloudsql-instances="$CONN" --quiet >/dev/null
    ok "job $name updated"
  else
    gcloud run jobs create "$name" --image="$PLACEHOLDER_IMAGE" --region="$REGION" \
      --service-account="$RUNTIME_SA" --set-secrets="$secrets" --set-env-vars="$ENVVARS" \
      --set-cloudsql-instances="$CONN" --command="$cmd" --args="$args" \
      --max-retries=0 --task-timeout=10m --quiet >/dev/null
    ok "job $name created"
  fi
}
ensure_job "nffl-migrate-$ENV_NAME" sh "-c,node dist/db/migrate.js && node dist/db/seed.js"
ensure_job "nffl-worker-$ENV_NAME" node "dist/worker.js" "$APP_SECRETS"

gcloud run jobs add-iam-policy-binding "nffl-worker-$ENV_NAME" --region="$REGION" \
  --member="serviceAccount:$SCHED_SA" --role=roles/run.invoker >/dev/null
if gcloud scheduler jobs describe "nffl-worker-$ENV_NAME-tick" --location="$REGION" >/dev/null 2>&1; then
  ok "worker schedule exists"
else
  gcloud scheduler jobs create http "nffl-worker-$ENV_NAME-tick" --location="$REGION" \
    --schedule="* * * * *" --time-zone="America/New_York" \
    --uri="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/nffl-worker-$ENV_NAME:run" \
    --http-method=POST --oauth-service-account-email="$SCHED_SA"
  # Paused until the first real deploy replaces the placeholder image.
  gcloud scheduler jobs pause "nffl-worker-$ENV_NAME-tick" --location="$REGION" >/dev/null
  ok "worker schedule created (paused until the first deploy)"
fi

step "6. Keyless GitHub → Google Cloud deploy access"
if gcloud iam workload-identity-pools describe github --location=global >/dev/null 2>&1; then
  ok "identity pool exists"
else
  gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
  ok "identity pool created"
fi
# Only this repo's deploy job, in this environment's GitHub environment and from
# this environment's branch, can act as the deployer (security audit H2).
if [[ "$ENV_NAME" == "prod" ]]; then GH_REF="refs/heads/production"; else GH_REF="refs/heads/main"; fi
WIF_MAPPING="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository=assertion.repository,attribute.environment=assertion.environment,attribute.ref=assertion.ref"
WIF_CONDITION="assertion.repository_id=='$GITHUB_REPO_ID' && assertion.environment=='$ENV_NAME' && assertion.ref=='$GH_REF'"
if gcloud iam workload-identity-pools providers describe github --location=global --workload-identity-pool=github >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc github --location=global --workload-identity-pool=github \
    --attribute-mapping="$WIF_MAPPING" --attribute-condition="$WIF_CONDITION" >/dev/null
  ok "GitHub provider limited to the $ENV_NAME environment on ${GH_REF#refs/heads/}"
else
  gcloud iam workload-identity-pools providers create-oidc github --location=global \
    --workload-identity-pool=github --display-name="GitHub" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="$WIF_MAPPING" --attribute-condition="$WIF_CONDITION"
  ok "GitHub provider created (only $GITHUB_REPO's $ENV_NAME deploys from ${GH_REF#refs/heads/})"
fi
POOL="projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/$POOL/attribute.repository_id/$GITHUB_REPO_ID" >/dev/null
ok "GitHub deploys from $GITHUB_REPO may act as the deployer"

API_URL=$(gcloud run services describe "nffl-api-$ENV_NAME" --region="$REGION" --format='value(status.url)')

cat <<EOF

$(printf '\033[1;32m')Done.$(printf '\033[0m')

In GitHub → the-villian-09/NFFlag → Settings → Environments → "$ENV_NAME"
(create it if missing) → Environment variables, add these four:

  GCP_PROJECT_ID    $PROJECT
  GCP_REGION        $REGION
  GCP_WIF_PROVIDER  $POOL/providers/github
  GCP_DEPLOY_SA     $DEPLOY_SA

Then re-run the latest "Deploy API" workflow (Actions tab), or push to main.
After that first deploy succeeds, turn on the worker schedule:

  gcloud scheduler jobs resume nffl-worker-$ENV_NAME-tick --location=$REGION --project=$PROJECT

For Vercel later, API_ORIGIN = $API_URL
Site address the API expects (APP_BASE_URL): $APP_BASE_URL
EOF
[[ "$APP_BASE_URL" == *example.com ]] && note "APP_BASE_URL is a placeholder. Once the Vercel domain exists, re-run with APP_BASE_URL=https://... so sign-in works."
exit 0
