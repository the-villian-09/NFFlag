# Infrastructure runbook

API and database on Google Cloud; front end on Vercel.

> **Quick path:** sections 1–6 are automated by [`setup-gcp.sh`](setup-gcp.sh). In Google Cloud Shell:
>
> ```bash
> curl -fsSLO https://raw.githubusercontent.com/the-villian-09/NFFlag/main/infra/setup-gcp.sh
> bash setup-gcp.sh staging nffl-staging-513215
> ```
>
> It's safe to re-run and prints the four GitHub variables at the end. The manual steps below
> describe the same setup, for reference or troubleshooting.

```
Browser ──▶ Vercel (Next.js, apps/web)
              │  /api/* is proxied (next.config.ts rewrites)
              ▼
           Cloud Run: nffl-api-<env>  ──▶ Cloud SQL Postgres 16 (private socket)
           Cloud Run jobs: nffl-migrate-<env>, nffl-worker-<env>
           Cloud Scheduler ──▶ runs nffl-worker-<env> every minute (outbox)
           Secret Manager: database URL, auth secret, Resend key
```

Two environments, each in its **own GCP project** so data and credentials never mix:
`staging` and `prod`. Run every section below once per environment, with these
variables set (example values shown):

```bash
export ENV_NAME=staging                 # or prod
export PROJECT=nffl-staging-12345       # your GCP project id
export REGION=us-east1
export INSTANCE=nffl-$ENV_NAME
export APP_BASE_URL=https://staging.YOUR-DOMAIN   # the Vercel domain for this env (D-03)
export GITHUB_REPO=the-villian-09/NFFlag
gcloud config set project $PROJECT
```

## 1. Enable services and create the image registry

```bash
gcloud services enable run.googleapis.com sqladmin.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com cloudscheduler.googleapis.com cloudbuild.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com

gcloud artifacts repositories create nffl --repository-format=docker --location=$REGION
```

## 2. Cloud SQL (Postgres 16) with backups

```bash
# staging: shared-core tier is fine. prod: consider db-custom-1-3840 and --availability-type=REGIONAL.
gcloud sql instances create $INSTANCE --database-version=POSTGRES_16 --edition=ENTERPRISE \
  --tier=db-g1-small --region=$REGION \
  --backup-start-time=07:00 --enable-point-in-time-recovery --retained-backups-count=14 \
  --deletion-protection

gcloud sql databases create nffl --instance=$INSTANCE
DB_PASS=$(openssl rand -base64 24 | tr -d '/+=')
gcloud sql users create nffl_app --instance=$INSTANCE --password="$DB_PASS"
```

## 3. Secrets

```bash
CONN=$PROJECT:$REGION:$INSTANCE
printf 'postgres://nffl_app:%s@/nffl?host=/cloudsql/%s' "$DB_PASS" "$CONN" \
  | gcloud secrets create nffl-database-url --data-file=-
openssl rand -base64 32 | tr -d '\n' | gcloud secrets create nffl-auth-secret --data-file=-
printf '%s' "re_YOUR_RESEND_KEY" | gcloud secrets create nffl-resend-key --data-file=-
```

## 4. Runtime service account

```bash
gcloud iam service-accounts create nffl-api --display-name="NFFL API runtime"
RUNTIME_SA=nffl-api@$PROJECT.iam.gserviceaccount.com
gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$RUNTIME_SA --role=roles/cloudsql.client
for s in nffl-database-url nffl-auth-secret nffl-resend-key; do
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$RUNTIME_SA --role=roles/secretmanager.secretAccessor
done
```

## 5. First image, service and jobs

```bash
IMAGE=$REGION-docker.pkg.dev/$PROJECT/nffl/api:first
gcloud builds submit --config infra/cloudbuild.yaml --substitutions _IMAGE=$IMAGE .

COMMON=(--region=$REGION --service-account=$RUNTIME_SA
  --set-secrets=DATABASE_URL=nffl-database-url:latest,BETTER_AUTH_SECRET=nffl-auth-secret:latest,RESEND_API_KEY=nffl-resend-key:latest
  --set-env-vars=APP_ENV=$ENV_NAME,APP_BASE_URL=$APP_BASE_URL,EMAIL_FROM=NFFL\ \<no-reply@YOUR-DOMAIN\>)

# Migrations + idempotent seed (runs before every deploy)
gcloud run jobs create nffl-migrate-$ENV_NAME --image=$IMAGE "${COMMON[@]}" \
  --set-cloudsql-instances=$CONN --command=sh --args="-c,node dist/db/migrate.js && node dist/db/seed.js"
gcloud run jobs execute nffl-migrate-$ENV_NAME --region=$REGION --wait

# API service
gcloud run deploy nffl-api-$ENV_NAME --image=$IMAGE "${COMMON[@]}" \
  --add-cloudsql-instances=$CONN --no-invoker-iam-check \
  --min-instances=0 --max-instances=5 --cpu=1 --memory=512Mi

# Outbox worker, triggered every minute
gcloud run jobs create nffl-worker-$ENV_NAME --image=$IMAGE "${COMMON[@]}" \
  --set-cloudsql-instances=$CONN --command=node --args=dist/worker.js --max-retries=0

gcloud iam service-accounts create nffl-scheduler
gcloud run jobs add-iam-policy-binding nffl-worker-$ENV_NAME --region=$REGION \
  --member=serviceAccount:nffl-scheduler@$PROJECT.iam.gserviceaccount.com --role=roles/run.invoker
gcloud scheduler jobs create http nffl-worker-$ENV_NAME-tick --location=$REGION --schedule="* * * * *" \
  --uri="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/nffl-worker-$ENV_NAME:run" \
  --http-method=POST --oauth-service-account-email=nffl-scheduler@$PROJECT.iam.gserviceaccount.com
```

`--no-invoker-iam-check` makes the API publicly reachable, because Vercel's proxy calls it as an
ordinary HTTPS client. It's used instead of an `allUsers` IAM binding, which Google Cloud organizations
with domain-restricted sharing refuse. Every route still enforces its own sign-in and permission checks.

## 6. GitHub Actions deploys (Workload Identity, no keys)

```bash
gcloud iam service-accounts create nffl-deployer
DEPLOY_SA=nffl-deployer@$PROJECT.iam.gserviceaccount.com
for r in roles/run.admin roles/artifactregistry.writer; do
  gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$DEPLOY_SA --role=$r
done
gcloud iam service-accounts add-iam-policy-binding $RUNTIME_SA \
  --member=serviceAccount:$DEPLOY_SA --role=roles/iam.serviceAccountUser

gcloud iam workload-identity-pools create github --location=global
gcloud iam workload-identity-pools providers create-oidc github --location=global \
  --workload-identity-pool=github --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository \
  --attribute-condition="assertion.repository=='$GITHUB_REPO'"
POOL=$(gcloud iam workload-identity-pools describe github --location=global --format='value(name)')
gcloud iam service-accounts add-iam-policy-binding $DEPLOY_SA --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/$POOL/attribute.repository/$GITHUB_REPO"
echo "GCP_WIF_PROVIDER = $POOL/providers/github"
```

In GitHub → Settings → Environments, create `staging` and `prod` (add required
reviewers on `prod`) and set these **variables** on each:
`GCP_PROJECT_ID`, `GCP_REGION`, `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`.

## 7. Vercel (front end)

1. Vercel → Add New Project → import `the-villian-09/NFFlag`.
2. **Root Directory:** `apps/web`. Framework: Next.js (auto-detected; pnpm workspace is detected from the repo root).
3. Environment variable `API_ORIGIN`:
   - Production → the prod Cloud Run URL (`gcloud run services describe nffl-api-prod --region $REGION --format 'value(status.url)'`)
   - Preview → the staging Cloud Run URL
4. Domains: production domain → Production; `staging.YOUR-DOMAIN` → the `main` branch (or a `staging` branch).
   The API's `APP_BASE_URL` must equal the domain the browser uses, or sign-in is refused.
   Random preview URLs (`*.vercel.app`) won't be able to sign in; use the staging domain for testing sign-in.

## 8. First Super Admins

Sign up on the site as normal and confirm the email, then (repeat for a second Super Admin; the plan requires two):

```bash
gcloud run jobs execute nffl-migrate-$ENV_NAME --region=$REGION --wait \
  --args="-c,node dist/scripts/grant-role.js you@example.com super_admin"
```



## 8b. Square payments (R1b)

The developer's own Square app serves both environments. Nobody needs the league's Square password.

| | Staging (`staging.nfflag.com`) | Production (`nfflag.com`) |
| --- | --- | --- |
| Square environment | Sandbox (test cards, no money moves) | Production |
| Account charged | Developer's Sandbox account, or a Sandbox test account connected in Admin → Payments | The league's account, connected by a Super Admin in Admin → Payments |

1. In the [Square Developer Dashboard](https://developer.squareup.com/apps), open the app. For each environment (Sandbox / Production toggle):
   - **OAuth → Redirect URL:** `https://staging.nfflag.com/api/v1/square/oauth/callback` (Sandbox) or `https://nfflag.com/api/v1/square/oauth/callback` (Production).
   - **Webhooks → Add subscription:** URL `https://staging.nfflag.com/api/v1/webhooks/square` (or `https://nfflag.com/...`), API version 2026-01-22,
     events `payment.created`, `payment.updated`, `refund.created`, `refund.updated`, `oauth.authorization.revoked`. Copy its **signature key**.
2. In Cloud Shell, from the `infra` folder: `bash set-square.sh staging nffl-staging-513215` (or `prod nffl-production`). It asks for the
   Application ID, Application secret, (Sandbox only) access token and location ID, and the webhook signature key, at hidden prompts.
3. Turn on **R1b: registration and Square checkout** in Admin → Release switches, set up the season and divisions in Admin → Seasons,
   and (production) click **Connect Square** in Admin → Payments while signed in to Square as the league's account owner.

Disconnect: Admin → Payments → Disconnect Square (type DISCONNECT). Checkout stops at once and Super Admins are emailed.

## 9. Backups and restore drill (required before Dec 1)

Automated daily backups and point-in-time recovery are on (section 2). Rehearse a restore into a
scratch instance at least once before launch and record the date in `docs/decisions/`:

```bash
gcloud sql instances clone $INSTANCE $INSTANCE-restore-test --point-in-time="2026-11-20T12:00:00Z"
# verify row counts, then delete the clone
gcloud sql instances delete $INSTANCE-restore-test
```

## Rollback

```bash
gcloud run services update-traffic nffl-api-$ENV_NAME --region=$REGION --to-revisions=PREVIOUS_REVISION=100
```
Migrations are forward-only: write them so the previous app version still works with the new schema
(add columns nullable, backfill, then tighten in a later release).
