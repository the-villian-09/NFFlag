#!/usr/bin/env bash
# NFFL — security audit fixes that live in Google Cloud (Nov 3, 2026 audit).
#
# Run in Google Cloud Shell from the infra folder, staging first:
#
#   bash harden-gcp.sh staging nffl-staging-513215
#   bash harden-gcp.sh prod    <prod project id>
#
# Each step asks before changing anything (y = do it, Enter = skip), so you can
# run it again later for a step you skipped. Steps:
#   1. H2  Only this environment's deploy job (right GitHub environment and branch) may deploy.
#   2. H1  Hide sign-in links from Cloud Run's own request log; delete the API's old logs.
#   3. H1  Sign everyone out by rotating the sign-in secret (optional; Square must be reconnected).
#   4. M13 Database accepts encrypted connections only.
#   5. M10 The app uses a database login that can read/write rows but not change tables.
#   6. M12 Narrower Cloud Run role for the deploy account (optional; try on staging first).
#   7.     List who can read this project's logs.

set -euo pipefail

ENV_NAME="${1:-}"
PROJECT="${2:-}"
if [[ "$ENV_NAME" != "staging" && "$ENV_NAME" != "prod" ]] || [[ -z "$PROJECT" ]]; then
  echo "Usage: bash harden-gcp.sh <staging|prod> <project-id>" >&2
  exit 1
fi
REGION="${REGION:-us-east1}"
SERVICE="nffl-api-$ENV_NAME"
INSTANCE="nffl-$ENV_NAME"
RUNTIME_SA="nffl-api@$PROJECT.iam.gserviceaccount.com"
DEPLOY_SA="nffl-deployer@$PROJECT.iam.gserviceaccount.com"
if [[ "$ENV_NAME" == "prod" ]]; then SITE="https://nfflag.com"; GH_REF="refs/heads/production"; else SITE="https://staging.nfflag.com"; GH_REF="refs/heads/main"; fi

ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
note() { printf '    \033[33m!\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask()  { local a; read -rp "    $1 [y/N] " a; [[ "$a" =~ ^[Yy] ]]; }
site_ok() { [[ "$(curl -s -o /dev/null -w '%{http_code}' "$SITE/api/v1/site" || true)" == "200" ]]; }

gcloud config set project "$PROJECT" >/dev/null
echo "Hardening $ENV_NAME ($PROJECT)."

# ---------------------------------------------------------------- 1
step "1. Deploy access (H2): only the $ENV_NAME deploy job from ${GH_REF#refs/heads/}"
COND=$(gcloud iam workload-identity-pools providers describe github --location=global --workload-identity-pool=github --format='value(attributeCondition)')
echo "    Now: $COND"
REPO_ID=$(sed -nE "s/.*repository_id *== *'([0-9]+)'.*/\1/p" <<<"$COND")
if [[ -z "$REPO_ID" ]]; then
  note "couldn't read the repository id from the current condition; skipping (fix by re-running setup-gcp.sh)."
elif [[ "$COND" == *"assertion.environment"* && "$COND" == *"$GH_REF"* ]]; then
  ok "already limited"
elif ask "Limit it to the GitHub '$ENV_NAME' environment on ${GH_REF#refs/heads/}?"; then
  gcloud iam workload-identity-pools providers update-oidc github --location=global --workload-identity-pool=github \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository=assertion.repository,attribute.environment=assertion.environment,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository_id=='$REPO_ID' && assertion.environment=='$ENV_NAME' && assertion.ref=='$GH_REF'" >/dev/null
  ok "limited. Also in GitHub → Settings → Environments → $ENV_NAME: Deployment branches = ${GH_REF#refs/heads/} only$([[ $ENV_NAME == prod ]] && echo ', Required reviewers = you')."
fi

# ---------------------------------------------------------------- 2
step "2. Logs (H1): hide sign-in links from request logs; delete the API's old logs"
if gcloud logging sinks describe _Default --format=json | grep -q '"name": "nffl-auth-urls"'; then
  ok "sign-in links are already excluded from request logs"
elif ask "Stop Cloud Run's request log from keeping /api/auth/ addresses (reset and confirmation links)?"; then
  gcloud logging sinks update _Default \
    --add-exclusion=name=nffl-auth-urls,filter="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\" AND httpRequest.requestUrl:\"/api/auth/\"" >/dev/null
  ok "excluded"
fi
echo "    The API's own logs from before today's fix may hold sign-in cookies and reset links."
echo "    Deleting removes ALL of this project's Cloud Run stdout/stderr logs so far (request logs stay)."
if ask "Delete them now? (Only after the logging fix is deployed here.)"; then
  for log in run.googleapis.com%2Fstdout run.googleapis.com%2Fstderr; do
    gcloud logging logs delete "$log" --quiet >/dev/null 2>&1 && ok "deleted $log" || note "$log: nothing to delete"
  done
fi

# ---------------------------------------------------------------- 3
step "3. Sign everyone out (H1, optional)"
echo "    Rotating the sign-in secret ends every session, including any copied from old logs."
echo "    Everyone signs in again, and Square must be reconnected (its tokens use this secret)."
if ask "Rotate it now?"; then
  openssl rand -base64 48 | tr -d '\n' | gcloud secrets versions add nffl-auth-secret --data-file=- >/dev/null
  # A new revision reads the new secret version (jobs read it on their next run).
  gcloud run services update "$SERVICE" --region="$REGION" --update-env-vars="AUTH_SECRET_ROTATED_AT=$(date +%s)" --quiet >/dev/null
  ok "rotated; everyone is signed out. Reconnect Square in Admin → Payments if you use it."
fi

# ---------------------------------------------------------------- 4
step "4. Database connections (M13): encrypted only"
MODE=$(gcloud sql instances describe "$INSTANCE" --format='value(settings.ipConfiguration.sslMode)')
NETS=$(gcloud sql instances describe "$INSTANCE" --format='value(settings.ipConfiguration.authorizedNetworks)')
echo "    Now: ${MODE:-default}; authorized networks: ${NETS:-none}"
if [[ "$MODE" == "TRUSTED_CLIENT_CERTIFICATE_REQUIRED" ]]; then
  ok "already encrypted-only"
elif ask "Require encrypted connections with client certificates? (The app's connection already does this.)"; then
  gcloud sql instances patch "$INSTANCE" --ssl-mode=TRUSTED_CLIENT_CERTIFICATE_REQUIRED --quiet >/dev/null
  sleep 15
  if site_ok; then ok "done; the site still works"; else note "the site isn't answering yet; check $SITE in a minute"; fi
fi
[[ -n "$NETS" ]] && note "authorized networks are set; remove any you don't need: gcloud sql instances patch $INSTANCE --clear-authorized-networks"

# ---------------------------------------------------------------- 5
step "5. Database login for the app (M10): rows only, no table changes"
CURRENT_DB=$(gcloud run services describe "$SERVICE" --region="$REGION" --format=json |
  jq -r '.spec.template.spec.containers[0].env[]? | select(.name=="DATABASE_URL") | .valueFrom.secretKeyRef.name // empty')
if [[ "$CURRENT_DB" == "nffl-database-url-runtime" ]]; then
  ok "the API already uses the row-access login"
elif ask "Create the row-access login and switch the API and worker to it?"; then
  OWNER_URL=$(gcloud secrets versions access latest --secret=nffl-database-url)
  RT_PASS=$(openssl rand -hex 24)
  RT_URL=$(sed -E "s#^(postgres(ql)?://)[^:@/]+:[^@]*@#\1nffl_runtime:$RT_PASS@#" <<<"$OWNER_URL")
  if [[ "$RT_URL" == "$OWNER_URL" || "$RT_URL" != *"nffl_runtime:"* ]]; then
    note "couldn't build the new connection string from nffl-database-url; skipping"
  else
    if gcloud secrets describe nffl-database-url-runtime >/dev/null 2>&1; then
      printf '%s' "$RT_URL" | gcloud secrets versions add nffl-database-url-runtime --data-file=- >/dev/null
    else
      printf '%s' "$RT_URL" | gcloud secrets create nffl-database-url-runtime --replication-policy=automatic --data-file=- >/dev/null
    fi
    gcloud secrets add-iam-policy-binding nffl-database-url-runtime --member="serviceAccount:$RUNTIME_SA" \
      --role=roles/secretmanager.secretAccessor >/dev/null
    unset OWNER_URL RT_URL RT_PASS
    ok "login details stored (nffl-database-url-runtime)"

    # Create the login and its grants, using the migrate job (it holds the owner login).
    gcloud run jobs update "nffl-migrate-$ENV_NAME" --region="$REGION" \
      --update-secrets="DATABASE_URL_RUNTIME=nffl-database-url-runtime:latest" --quiet >/dev/null
    # The migrate job runs `sh -c "<args>"`; this run does only the login step.
    if gcloud run jobs execute "nffl-migrate-$ENV_NAME" --region="$REGION" --wait \
         --args="-c,node dist/db/runtime-role.js" >/dev/null; then
      ok "login created with row access only"
      gcloud run services update "$SERVICE" --region="$REGION" \
        --update-secrets="DATABASE_URL=nffl-database-url-runtime:latest" --quiet >/dev/null
      gcloud run jobs update "nffl-worker-$ENV_NAME" --region="$REGION" \
        --update-secrets="DATABASE_URL=nffl-database-url-runtime:latest" --quiet >/dev/null
      sleep 10
      if site_ok; then
        ok "API and worker now use it; the site works"
      else
        note "the site isn't answering; switching back to the owner login"
        gcloud run services update "$SERVICE" --region="$REGION" --update-secrets="DATABASE_URL=nffl-database-url:latest" --quiet >/dev/null
        gcloud run jobs update "nffl-worker-$ENV_NAME" --region="$REGION" --update-secrets="DATABASE_URL=nffl-database-url:latest" --quiet >/dev/null
        ok "switched back; send me the error from the API logs"
      fi
    else
      note "creating the login failed; nothing was switched. See the migrate job's latest execution log."
    fi
  fi
fi

# ---------------------------------------------------------------- 6
step "6. Deploy account role (M12, optional)"
if gcloud projects get-iam-policy "$PROJECT" --format=json |
   jq -e --arg m "serviceAccount:$DEPLOY_SA" '.bindings[] | select(.role=="roles/run.admin") | .members[] | select(.==$m)' >/dev/null; then
  echo "    The deployer has Cloud Run Admin. Cloud Run Developer is enough for deploys."
  echo "    After switching, push something small to ${GH_REF#refs/heads/} and check the deploy passes."
  if ask "Switch to Cloud Run Developer?"; then
    gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$DEPLOY_SA" --role=roles/run.developer --condition=None >/dev/null
    gcloud projects remove-iam-policy-binding "$PROJECT" --member="serviceAccount:$DEPLOY_SA" --role=roles/run.admin --condition=None >/dev/null
    ok "switched. If a deploy then fails on permissions, undo with:"
    echo "      gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$DEPLOY_SA --role=roles/run.admin --condition=None"
  fi
else
  ok "the deployer doesn't have Cloud Run Admin"
fi

# ---------------------------------------------------------------- 7
step "7. Who can read this project's logs"
gcloud projects get-iam-policy "$PROJECT" --format=json |
  jq -r '.bindings[] | select(.role|test("roles/(owner|editor|viewer|logging\\.(viewer|privateLogViewer|admin))$")) | "    \(.role): \(.members|join(", "))"'
echo "    Remove anyone who doesn't need it in IAM & Admin → IAM."

echo
echo "Done with $ENV_NAME."
