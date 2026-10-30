# Open questions and decisions

Coding agents and developers: don't invent values for anything here. Make it configurable
and leave a pointer to the question. Update this file when a decision is made.

| ID | Question | Need by | Status |
| --- | --- | --- | --- |
| D-01 | Legal entity and merchant of record (Square account, Resend domain, waivers) | Nov 6 | Open |
| D-02 | Stack | Nov 2 | **Decided Oct 30:** API + Postgres on GCP (Cloud Run, Cloud SQL), front end on Vercel (Next.js). Auth: Better Auth inside the API. |
| D-03 | Domain, logo files, flyer color codes (brand tokens live in `apps/web/app/globals.css`) | Nov 9 | **Domain decided Oct 30:** nfflag.com (production), staging.nfflag.com (staging); DNS at GoDaddy. Logo and colors still open. |
| D-04 | Seat hold length while checkout is pending | Nov 20 | Open |
| D-05 | Payment that arrives after its hold expired: auto-refund, honor over cap, or waitlist with credit | Nov 20 | Open |
| D-06 | Who absorbs Square fees; full refund for a rejected child? | Nov 20 | Open |
| D-07 | Age cutoff date and division rules for 2027 (stored per season/division) | Nov 20 | Open |
| D-08 | Waiver, medical authorization and photo/video release text, reviewed by counsel | Nov 26 | Open |
| D-09 | Registration close date before the Jan 4 draft | Dec 1 | Open |
| D-10 | Coach background screening requirement under Florida law | Dec 1 | Open |
| D-11 | Start Twilio A2P 10DLC registration | Start by Nov 6 | Open |

## R0 implementation decisions

- **Email confirmation (decided Oct 30):** required. A link is emailed at sign-up (valid 24 hours); clicking it
  confirms the address and signs the family in. Trying to sign in before confirming is refused and re-sends the link.
- **Two-step sign-in (decided Oct 30):** optional for everyone; users choose emailed codes or an authenticator app,
  and can turn it off with their password. Trusted devices skip the code for 30 days.
  Admins can require an authenticator app for a role (`PUT /api/v1/admin/roles/:key/mfa`, stored in
  `roles.requires_totp`, off by default); email codes are then refused for that role.
  Note: PRD v1.0 section 3 required admin MFA; this decision supersedes it.
- **Admin idle timeout:** 30 minutes (`ADMIN_IDLE_MINUTES`), tracked in Postgres.
- **Audit log:** append-only, enforced by a database trigger. Retention purges (FR-039) need an approved, separate job.
- **Medical fields:** redacted from audit snapshots by key name (`modules/platform/audit.ts`); R1b stores them in a restricted table.
