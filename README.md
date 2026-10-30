# NFFL — North Florida Flag League

League platform: public site, family accounts, registration and Square payments, admin portal,
and later teams, draft, schedules, standings and playoffs.

| Part | Where it runs | Code |
| --- | --- | --- |
| Front end (public site, parent dashboard, admin portal) | Vercel | `apps/web` (Next.js) |
| API | Google Cloud Run | `apps/api` (Express + TypeScript) |
| Database | Google Cloud SQL, Postgres 16 | `apps/api/src/db`, migrations in `apps/api/drizzle` |
| Shared contracts and permission catalog | both | `packages/shared` |

Release plan and decisions: the "NFFL Release Plan v1.1" doc. Infrastructure setup: [`infra/README.md`](infra/README.md).

## Status

**R0 Foundation** is in place: email + password accounts with email confirmation (the link is re-sent if
someone tries to sign in before confirming) and password reset; optional two-step sign-in, by emailed code or authenticator app, with 30-day trusted
devices, backup codes and admin reset; a per-role switch admins can use to require an authenticator app;
permission-based access with season/team scopes; append-only audit log; transactional outbox with a worker;
feature flags for every release; admin idle timeout.

## Run it locally

Requires Node 22, pnpm 10 and Docker (for Postgres).

```bash
pnpm install
docker compose up -d                      # Postgres on :5432 with nffl_dev and nffl_test
cp apps/api/.env.example apps/api/.env    # then set BETTER_AUTH_SECRET
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @nffl/shared build
pnpm db:migrate && pnpm --filter @nffl/api db:seed -- --sample
pnpm dev                                  # web on :3000, API on :8080
```

Emails aren't sent locally: confirmation links, password-reset links and sign-in codes are printed in the API log.

Make yourself an admin after signing up:

```bash
pnpm --filter @nffl/api exec tsx src/scripts/grant-role.ts you@example.com super_admin
```

## Tests

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/nffl_test pnpm --filter @nffl/api test
```

The suite runs against a real Postgres and covers sign-up, email confirmation, sign-in, both optional two-step methods,
trusted devices, turning two-step off, per-role authenticator requirement, permissions, cross-family
isolation, MFA reset, idle timeout, audit immutability and outbox retries.

## How to add a release

Each release plugs into the same extension points instead of changing existing code:

1. **Schema:** add tables in `apps/api/src/db/schema/<module>.ts`, then `pnpm --filter @nffl/api db:generate --name <change>`.
2. **Module:** add `apps/api/src/modules/<module>/` with its routes and services; mount the router in `src/app.ts`.
3. **Permissions:** add keys to `packages/shared/src/permissions.ts` and default grants; the seed applies them on deploy.
4. **Guards:** `requireAuth → requireMfa → requirePermission("…", scopeOf)` on every route.
5. **Audit and events:** `writeAudit(tx, …)` and `publish(tx, …)` inside the same transaction as the change.
   Side effects (emails, SMS, TixFlo) are outbox subscribers in `src/modules/subscribers.ts`.
6. **Feature flag:** gate UI and routes on the release's flag (`isEnabled("r2.refunds")`); turn it on in the admin portal when accepted.
7. **Google / Microsoft sign-in (backlog):** add `socialProviders` in `src/modules/auth/auth.ts`; accounts link through the
   existing `account` table, so users, roles and MFA are unchanged.

Open questions that block later work live in [`docs/decisions/open-questions.md`](docs/decisions/open-questions.md).
Don't invent policy values; add them there.
