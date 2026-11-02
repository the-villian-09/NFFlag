/**
 * Referees: sign-up rules, approval checks, Stripe payout accounts, claiming and
 * assigning games, pay (transfers, waiting payouts, retries), emails.
 * Stripe's API is faked.
 */
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/client.js";
import { featureFlags, gameOfficials, games, outboxEvents, refereeAccounts, refereePayouts, seasons, teams, user, userRoleAssignments } from "../src/db/schema/index.js";
import { clearSubscribers, processOutbox } from "../src/modules/platform/outbox.js";
import { resetFlagCache } from "../src/modules/platform/flags.js";
import { ageOn, processRefereePayouts } from "../src/modules/referees/service.js";
import { registerSubscribers } from "../src/modules/subscribers.js";
import { agent, mail, signUp, uniqueEmail, useProvider, type Agent } from "./helpers.js";

/* ---------------- fake Stripe ---------------- */

const stripe = {
  calls: [] as { method: string; path: string; body: URLSearchParams; key: string | null }[],
  accounts: new Map<string, { id: string; details_submitted: boolean; payouts_enabled: boolean; capabilities: { transfers: string }; requirements: { currently_due: string[]; past_due: string[] } }>(),
  transfers: [] as { id: string; amount: number; destination: string; transfer_group: string | null }[],
  replies: new Map<string, [number, unknown]>(),
  available: 1_000_00,
  seq: 0,
  /** Make the next transfer's response get lost (it still happens). */
  loseNext: false,
};
const realFetch = globalThis.fetch;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.host !== "api.stripe.com") return realFetch(input, init);
    const method = init?.method ?? "GET";
    const body = new URLSearchParams(method === "POST" ? String(init?.body ?? "") : url.search);
    const key = new Headers(init?.headers).get("idempotency-key");
    stripe.calls.push({ method, path: url.pathname, body, key });
    if (method === "POST" && url.pathname === "/v1/accounts") {
      const id = `acct_${++stripe.seq}`;
      const a = { id, details_submitted: false, payouts_enabled: false, capabilities: { transfers: "inactive" }, requirements: { currently_due: ["individual.ssn_last_4", "external_account"], past_due: [] } };
      stripe.accounts.set(id, a);
      return json(200, a);
    }
    const acct = url.pathname.match(/^\/v1\/accounts\/(acct_\d+)$/);
    if (acct) return json(200, stripe.accounts.get(acct[1]!));
    if (url.pathname === "/v1/account_sessions") return json(200, { client_secret: `accs_secret_${body.get("account")}` });
    if (url.pathname === "/v1/balance") return json(200, { available: [{ amount: stripe.available, currency: "usd", source_types: { card: stripe.available } }], pending: [{ amount: 500, currency: "usd" }] });
    if (url.pathname === "/v1/topups") return json(200, { id: `tu_${++stripe.seq}`, status: "pending", amount: Number(body.get("amount")), expected_availability_date: 1893456000 });
    if (url.pathname === "/v1/transfers" && method === "GET") {
      const group = body.get("transfer_group");
      return json(200, { data: stripe.transfers.filter((t) => t.transfer_group === group) });
    }
    if (url.pathname === "/v1/transfers") {
      // Like Stripe: a key's first response (success or refusal) is replayed for 24 hours.
      if (key && stripe.replies.has(key)) {
        const [st, b] = stripe.replies.get(key)!;
        return json(st, b, { "idempotent-replayed": "true" });
      }
      const amount = Number(body.get("amount"));
      if (amount > stripe.available) {
        const refusal = { error: { type: "invalid_request_error", code: "balance_insufficient", message: "You have insufficient available funds in your Stripe account." } };
        stripe.replies.set(key!, [400, refusal]);
        return json(400, refusal);
      }
      stripe.available -= amount;
      const t = { id: `tr_${++stripe.seq}`, amount, destination: body.get("destination")!, transfer_group: body.get("transfer_group") };
      stripe.transfers.push(t);
      stripe.replies.set(key!, [200, t]);
      if (stripe.loseNext) {
        stripe.loseNext = false;
        return json(500, { error: { type: "api_error", message: "lost" } });
      }
      return json(200, t);
    }
    return json(404, { error: { type: "invalid_request_error", message: `no route ${url.pathname}` } });
  });
  clearSubscribers();
  registerSubscribers();
});

/** The referee finishes Stripe's onboarding. */
function finishOnboarding(accountId: string) {
  const a = stripe.accounts.get(accountId)!;
  Object.assign(a, { details_submitted: true, payouts_enabled: true, capabilities: { transfers: "active" }, requirements: { currently_due: [], past_due: [] } });
}

async function drain() {
  for (;;) {
    const r = await processOutbox(200);
    if (r.processed + r.failed === 0) return;
  }
}

/* ---------------- fixtures ---------------- */

let admin: Agent;
let adminId: string;
let seasonId: string;
let divisionId: string;
let homeId: string;
let awayId: string;
let previousCurrent: string | null = null;
const inDays = (d: number, hour = 10) => new Date(Date.now() + d * 86400_000 + hour * 60_000);

const form = { phone: "904-555-0123", birthDate: "1990-04-02", experience: "5 seasons", certification: "NFL FLAG Official", certificationExpiresOn: "2030-01-01" };

async function referee(prefix: string) {
  const a = agent();
  const email = uniqueEmail(prefix.toLowerCase());
  await signUp(a, email, `${prefix} Ref`);
  const [u] = await db.select().from(user).where(eq(user.email, email));
  return { a, email, userId: u!.id };
}

/** Signs up, clears the check, verifies the certification and approves. */
async function approvedReferee(prefix: string) {
  const r = await referee(prefix);
  const app = (await r.a.post("/api/v1/referees/applications").send(form)).body.application;
  await admin.put(`/api/v1/admin/referees/applications/${app.id}/screening`).send({ status: "cleared", completedOn: "2026-10-01" });
  await admin.put(`/api/v1/admin/referees/applications/${app.id}/certification`).send({ verified: true });
  const d = await admin.post(`/api/v1/admin/referees/applications/${app.id}/decision`).send({ decision: "approved" });
  expect(d.body.application.status).toBe("approved");
  return { ...r, appId: app.id as string };
}

/** Approved, with payouts set up. */
async function payableReferee(prefix: string) {
  const r = await approvedReferee(prefix);
  const s = await r.a.post("/api/v1/referees/payouts/session");
  expect(s.status).toBe(200);
  const accountId = s.body.clientSecret.replace("accs_secret_", "");
  finishOnboarding(accountId);
  expect((await r.a.post("/api/v1/referees/payouts/refresh")).body.setup).toBe("ready");
  return { ...r, accountId };
}

async function newGame(startsAt: Date, status: "scheduled" | "final" = "scheduled") {
  const [g] = await db
    .insert(games)
    .values({ seasonId, divisionId, homeTeamId: homeId, awayTeamId: awayId, startsAt, location: "Field 1", status, homeScore: status === "final" ? 14 : null, awayScore: status === "final" ? 7 : null })
    .returning();
  return g!.id;
}

beforeAll(async () => {
  await useProvider("stripe");
  admin = agent();
  const email = uniqueEmail("ref-admin");
  await signUp(admin, email, "Ref Admin");
  const [u] = await db.select().from(user).where(eq(user.email, email));
  adminId = u!.id;
  await db.insert(userRoleAssignments).values({ userId: adminId, roleKey: "super_admin" });
  const [cur] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.isCurrent, "current"));
  previousCurrent = cur?.id ?? null;
  const s = await admin.post("/api/v1/admin/league/seasons").send({
    name: "Referee Season",
    year: 2027,
    status: "registration_open",
    registrationOpensAt: new Date(Date.now() - 86400_000).toISOString(),
    registrationClosesAt: "",
    ageCutoffDate: "",
    isCurrent: true,
  });
  seasonId = s.body.season.id;
  const d = await admin.post(`/api/v1/admin/league/seasons/${seasonId}/divisions`).send({ name: "Ref 12U", genderPolicy: "coed", capacity: 50, priceCents: 10000, refereeRateCents: 3500, status: "open" });
  expect(d.body.division.refereeRateCents).toBe(3500);
  divisionId = d.body.division.id;
  const [h] = await db.insert(teams).values({ seasonId, divisionId, name: "Sharks" }).returning();
  const [w] = await db.insert(teams).values({ seasonId, divisionId, name: "Jets" }).returning();
  homeId = h!.id;
  awayId = w!.id;
});

afterAll(async () => {
  await drain();
  clearSubscribers();
  vi.restoreAllMocks();
  await db.update(seasons).set({ isCurrent: null });
  if (previousCurrent) await db.update(seasons).set({ isCurrent: "current" }).where(eq(seasons.id, previousCurrent));
  else await db.update(seasons).set({ isCurrent: "current" }).where(like(seasons.name, "%(sample)"));
  await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, "r5.referees"));
  await db.update(userRoleAssignments).set({ revokedAt: new Date() }).where(eq(userRoleAssignments.userId, adminId));
  await useProvider("square");
  resetFlagCache();
});

/* ---------------- tests ---------------- */

describe("referee sign-up and approval", () => {
  it("is closed to referees until the release switch is on", async () => {
    const r = await referee("early");
    const res = await r.a.get("/api/v1/referees/me");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FEATURE_DISABLED");
    expect((await admin.put("/api/v1/admin/flags/r5.referees").send({ enabled: true })).status).toBe(200);
    resetFlagCache();
    expect((await r.a.get("/api/v1/referees/me")).body).toMatchObject({ season: { id: seasonId }, minAge: 16, application: null });
  });

  it("checks age and certification at sign-up, and allows one active sign-up per season", async () => {
    const r = await referee("young");
    const young = await r.a.post("/api/v1/referees/applications").send({ ...form, birthDate: new Date(Date.now() - 15 * 365.25 * 86400_000).toISOString().slice(0, 10) });
    expect(young.status).toBe(400);
    expect(young.body.error.message).toBe("Referees must be at least 16 years old.");
    expect((await r.a.post("/api/v1/referees/applications").send({ ...form, certificationExpiresOn: "2020-01-01" })).status).toBe(400);
    const ok = await r.a.post("/api/v1/referees/applications").send(form);
    expect(ok.status).toBe(201);
    expect((await r.a.post("/api/v1/referees/applications").send(form)).status).toBe(409);
    expect(ageOn("2010-11-02", "2026-11-01")).toBe(15);
    expect(ageOn("2010-11-01", "2026-11-01")).toBe(16);
  });

  it("approval needs a cleared check, a verified certification and the minimum age; the league is emailed", async () => {
    const r = await referee("strict");
    const app = (await r.a.post("/api/v1/referees/applications").send({ ...form, birthDate: "2005-01-01" })).body.application;
    await drain();
    const decide = () => admin.post(`/api/v1/admin/referees/applications/${app.id}/decision`).send({ decision: "approved" });
    expect((await decide()).body.error.message).toMatch(/background check/);
    await admin.put(`/api/v1/admin/referees/applications/${app.id}/screening`).send({ status: "cleared", completedOn: "2026-10-01" });
    expect((await decide()).body.error.message).toMatch(/certification/);
    const v = await admin.put(`/api/v1/admin/referees/applications/${app.id}/certification`).send({ verified: true });
    expect(v.body.application).toMatchObject({ certificationVerified: true, meetsMinAge: true });
    // Raising the minimum age above theirs blocks approval.
    await admin.put("/api/v1/admin/referees/settings").send({ minAge: 30 });
    expect((await decide()).body.error.message).toBe("Referees must be at least 30 years old.");
    await admin.put("/api/v1/admin/referees/settings").send({ minAge: 16 });
    expect((await decide()).body.application.status).toBe("approved");
    await drain();
    expect(mail.sent.some((m) => m.to === r.email && m.template === "referee.approved")).toBe(true);
    // Can't un-clear the check while approved.
    expect((await admin.put(`/api/v1/admin/referees/applications/${app.id}/screening`).send({ status: "pending" })).status).toBe(409);
    // An admin can't decide their own.
    const own = (await admin.post("/api/v1/referees/applications").send(form)).body.application;
    expect((await admin.post(`/api/v1/admin/referees/applications/${own.id}/decision`).send({ decision: "rejected" })).status).toBe(403);
  });
});

describe("payout setup", () => {
  it("only approved referees get a Stripe account; it's created once and its status is tracked", async () => {
    const r = await referee("noapp");
    expect((await r.a.post("/api/v1/referees/payouts/session")).status).toBe(403);

    const ok = await approvedReferee("payouts");
    const s1 = await ok.a.post("/api/v1/referees/payouts/session");
    expect(s1.body).toMatchObject({ publishableKey: "pk_test_fake", environment: "test" });
    const create = [...stripe.calls].reverse().find((c) => c.path === "/v1/accounts")!;
    expect(create.body.get("controller[stripe_dashboard][type]")).toBe("none");
    expect(create.body.get("controller[losses][payments]")).toBe("application");
    expect(create.body.get("capabilities[transfers][requested]")).toBe("true");
    const session = [...stripe.calls].reverse().find((c) => c.path === "/v1/account_sessions")!;
    expect(session.body.get("components[payouts][features][instant_payouts]")).toBe("true");
    expect(session.body.get("components[account_onboarding][enabled]")).toBe("true");
    const accounts = stripe.calls.filter((c) => c.path === "/v1/accounts").length;
    await ok.a.post("/api/v1/referees/payouts/session");
    expect(stripe.calls.filter((c) => c.path === "/v1/accounts").length).toBe(accounts);
    expect((await ok.a.post("/api/v1/referees/payouts/refresh")).body.setup).toBe("needs_info");
    finishOnboarding(s1.body.clientSecret.replace("accs_secret_", ""));
    expect((await ok.a.post("/api/v1/referees/payouts/refresh")).body).toEqual({ setup: "ready", payoutsEnabled: true });
    expect((await ok.a.get("/api/v1/referees/me")).body.payouts.setup).toBe("ready");
  });
});

describe("games", () => {
  it("referees claim open games at the division rate, within the spots, without clashes, and can drop them in time", async () => {
    const a = await approvedReferee("claimA");
    const b = await approvedReferee("claimB");
    const c = await approvedReferee("claimC");
    const g = await newGame(inDays(5));
    const near = await newGame(new Date(inDays(5).getTime() + 60 * 60_000)); // an hour later

    const open = (await a.a.get("/api/v1/referees/games")).body.open;
    expect(open.find((x: { gameId: string }) => x.gameId === g)).toMatchObject({ rateCents: 3500, slots: 2, filled: 0, home: "Sharks", away: "Jets" });
    expect((await a.a.post(`/api/v1/referees/games/${g}/claim`)).status).toBe(201);
    expect((await a.a.post(`/api/v1/referees/games/${g}/claim`)).status).toBe(409); // already on it
    expect((await a.a.post(`/api/v1/referees/games/${near}/claim`)).body.error.message).toMatch(/within 90 minutes/);
    expect((await b.a.post(`/api/v1/referees/games/${g}/claim`)).status).toBe(201);
    expect((await c.a.post(`/api/v1/referees/games/${g}/claim`)).body.error.message).toBe("This game already has all the referees it needs.");
    const mine = (await a.a.get("/api/v1/referees/games")).body.mine;
    expect(mine.find((x: { gameId: string }) => x.gameId === g)).toMatchObject({ status: "assigned", source: "claimed", rateCents: 3500 });

    expect((await a.a.delete(`/api/v1/referees/games/${g}/claim`)).status).toBe(200);
    expect((await c.a.post(`/api/v1/referees/games/${g}/claim`)).status).toBe(201);
    // Too close to the game to drop.
    const soon = await newGame(inDays(0.5));
    await c.a.post(`/api/v1/referees/games/${soon}/claim`);
    expect((await c.a.delete(`/api/v1/referees/games/${soon}/claim`)).body.error.message).toMatch(/24 hours before/);
    // Not approved: can't claim.
    const stranger = await referee("stranger");
    expect((await stranger.a.post(`/api/v1/referees/games/${soon}/claim`)).status).toBe(409);
  });

  it("admins assign and remove referees (with emails), change spots, and can't delete a paid game", async () => {
    const r = await approvedReferee("assigned");
    const g = await newGame(inDays(8));
    const listed = await admin.get("/api/v1/admin/referees/games");
    expect(listed.body.referees.some((x: { userId: string }) => x.userId === r.userId)).toBe(true);
    await admin.put(`/api/v1/admin/referees/games/${g}/slots`).send({ slots: 1 });
    const o = await admin.post(`/api/v1/admin/referees/games/${g}/officials`).send({ userId: r.userId });
    expect(o.status).toBe(201);
    const other = await approvedReferee("assigned2");
    expect((await admin.post(`/api/v1/admin/referees/games/${g}/officials`).send({ userId: other.userId })).body.error.message).toMatch(/Add a spot first/);
    expect((await admin.put(`/api/v1/admin/referees/games/${g}/slots`).send({ slots: 0 })).status).toBe(409);
    await drain();
    expect(mail.sent.some((m) => m.to === r.email && m.template === "referee.assigned" && m.text.includes("$35.00"))).toBe(true);
    expect((await admin.delete(`/api/v1/admin/referees/officials/${o.body.official.id}`)).status).toBe(200);
    await drain();
    expect(mail.sent.some((m) => m.to === r.email && m.template === "referee.unassigned")).toBe(true);
    // A game change reaches its referees.
    await admin.post(`/api/v1/admin/referees/games/${g}/officials`).send({ userId: r.userId });
    await drain();
    const res = await admin.put(`/api/v1/admin/schedule/games/${g}`).send({
      homeTeamId: homeId,
      awayTeamId: awayId,
      startsAt: "2027-04-10T09:00",
      location: "Field 2",
      status: "postponed",
      notify: true,
    });
    expect(res.status).toBe(200);
    await drain();
    expect(mail.sent.some((m) => m.to === r.email && m.template === "referee.game_changed")).toBe(true);
  });

  it("removing an approval takes the referee off upcoming games", async () => {
    const r = await approvedReferee("revoked");
    const g = await newGame(inDays(9));
    await r.a.post(`/api/v1/referees/games/${g}/claim`);
    const res = await admin.post(`/api/v1/admin/referees/applications/${r.appId}/revoke`).send({ reason: "Check expired" });
    expect(res.body).toMatchObject({ gamesRemoved: 1, application: { status: "revoked" } });
    expect((await r.a.post(`/api/v1/referees/games/${await newGame(inDays(10))}/claim`)).status).toBe(409);
  });
});

describe("pay", () => {
  it("approves pay for final games: one Stripe transfer per referee; no-shows aren't paid; a statement is emailed", async () => {
    const r = await payableReferee("paid");
    const g1 = await newGame(inDays(3));
    const g2 = await newGame(inDays(4));
    await r.a.post(`/api/v1/referees/games/${g1}/claim`);
    await r.a.post(`/api/v1/referees/games/${g2}/claim`);
    await db.update(games).set({ status: "final", homeScore: 20, awayScore: 6, startsAt: inDays(-2) }).where(eq(games.id, g1));
    await db.update(games).set({ status: "final", homeScore: 13, awayScore: 12, startsAt: inDays(-1) }).where(eq(games.id, g2));

    const view = await admin.get("/api/v1/admin/referees/pay");
    expect(view.body.balance).toMatchObject({ availableCents: stripe.available, pendingCents: 500 });
    const mine = view.body.owed.find((o: { userId: string }) => o.userId === r.userId);
    expect(mine).toMatchObject({ totalCents: 7000, payoutSetup: "ready" });
    const [first, second] = mine.games as { officialId: string }[];
    // One game's pay is raised, the other is a no-show.
    await admin.patch(`/api/v1/admin/referees/officials/${first!.officialId}`).send({ rateCents: 4000 });
    await admin.patch(`/api/v1/admin/referees/officials/${second!.officialId}`).send({ status: "no_show" });
    expect((await admin.post("/api/v1/admin/referees/pay/approve").send({ officialIds: [first!.officialId, second!.officialId] })).status).toBe(409);
    const before = stripe.available;
    const paid = await admin.post("/api/v1/admin/referees/pay/approve").send({ officialIds: [first!.officialId] });
    expect(paid.status).toBe(200);
    expect(paid.body.payouts[0]).toMatchObject({ status: "paid", amountCents: 4000 });
    expect(before - stripe.available).toBe(4000);
    const t = [...stripe.calls].reverse().find((c) => c.path === "/v1/transfers")!;
    expect(t.body.get("destination")).toBe(r.accountId);
    expect(t.body.get("amount")).toBe("4000");
    // Can't pay the same game twice.
    expect((await admin.post("/api/v1/admin/referees/pay/approve").send({ officialIds: [first!.officialId] })).status).toBe(409);
    await drain();
    expect(mail.sent.some((m) => m.to === r.email && m.template === "referee.paid" && m.text.includes("$40.00"))).toBe(true);
    const statement = (await r.a.get("/api/v1/referees/pay")).body.payouts;
    expect(statement[0]).toMatchObject({ status: "paid", amountCents: 4000 });
    expect(statement[0].games).toHaveLength(1);
    // A paid game's referee can't be removed or changed.
    expect((await admin.delete(`/api/v1/admin/referees/officials/${first!.officialId}`)).status).toBe(409);
    expect((await admin.delete(`/api/v1/admin/schedule/games/${g1}`)).status).toBe(409);
  });

  it("waits for a referee who hasn't finished payout setup, then the worker sends it", async () => {
    const r = await approvedReferee("waiting");
    const g = await newGame(inDays(2));
    await r.a.post(`/api/v1/referees/games/${g}/claim`);
    await db.update(games).set({ status: "final", homeScore: 1, awayScore: 0 }).where(eq(games.id, g));
    const owed = (await admin.get("/api/v1/admin/referees/pay")).body.owed.find((o: { userId: string }) => o.userId === r.userId);
    expect(owed.payoutSetup).toBe("not_started");
    const res = await admin.post("/api/v1/admin/referees/pay/approve").send({ officialIds: owed.games.map((x: { officialId: string }) => x.officialId) });
    expect(res.body.payouts[0]).toMatchObject({ status: "pending", lastError: "Waiting for the referee to finish payout setup." });
    expect((await r.a.get("/api/v1/referees/pay")).body.payouts[0].lastError).toBe("Finish payout setup to receive this.");

    const s = await r.a.post("/api/v1/referees/payouts/session");
    finishOnboarding(s.body.clientSecret.replace("accs_secret_", ""));
    // The worker re-checks accounts it last looked at over 10 minutes ago, then sends what's waiting.
    await db.update(refereePayouts).set({ updatedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(refereePayouts.userId, r.userId));
    await db.update(refereeAccounts).set({ checkedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(refereeAccounts.userId, r.userId));
    expect(await processRefereePayouts()).toBeGreaterThanOrEqual(1);
    const [p] = await db.select().from(refereePayouts).where(eq(refereePayouts.userId, r.userId));
    expect(p).toMatchObject({ status: "paid", amountCents: 3500 });
  });

  it("not enough balance fails clearly; a retry after funds arrive uses a new key and pays once", async () => {
    const r = await payableReferee("broke");
    const g = await newGame(inDays(1));
    await r.a.post(`/api/v1/referees/games/${g}/claim`);
    await db.update(games).set({ status: "final", homeScore: 2, awayScore: 0 }).where(eq(games.id, g));
    const owed = (await admin.get("/api/v1/admin/referees/pay")).body.owed.find((o: { userId: string }) => o.userId === r.userId);
    const saved = stripe.available;
    stripe.available = 1000;
    const res = await admin.post("/api/v1/admin/referees/pay/approve").send({ officialIds: owed.games.map((x: { officialId: string }) => x.officialId) });
    expect(res.body.payouts[0].status).toBe("failed");
    expect(res.body.payouts[0].lastError).toMatch(/Not enough available money/);
    const payoutId = res.body.payouts[0].id;
    expect((await admin.get("/api/v1/admin/referees/pay")).body.waiting.some((w: { id: string }) => w.id === payoutId)).toBe(true);

    stripe.available = saved;
    const retried = await admin.post(`/api/v1/admin/referees/pay/payouts/${payoutId}/retry`);
    expect(retried.body.payout.status).toBe("paid");
    const sends = stripe.calls.filter((c) => c.method === "POST" && c.path === "/v1/transfers" && c.body.get("transfer_group") === payoutId);
    expect(new Set(sends.map((c) => c.key)).size).toBe(2); // the refused key isn't reused
    expect(saved - stripe.available).toBe(3500);
  });

  it("a lost response is found again by its transfer group and never paid twice, even after Stripe forgets the key", async () => {
    const r = await payableReferee("lost");
    const g = await newGame(inDays(1.5));
    await r.a.post(`/api/v1/referees/games/${g}/claim`);
    await db.update(games).set({ status: "final", homeScore: 2, awayScore: 0 }).where(eq(games.id, g));
    const owed = (await admin.get("/api/v1/admin/referees/pay")).body.owed.find((o: { userId: string }) => o.userId === r.userId);
    const before = stripe.available;
    stripe.loseNext = true;
    const res = await admin.post("/api/v1/admin/referees/pay/approve").send({ officialIds: owed.games.map((x: { officialId: string }) => x.officialId) });
    const payoutId = res.body.payouts[0].id;
    expect(res.body.payouts[0].status).toBe("pending");
    stripe.replies.clear(); // more than 24 hours later
    const again = await admin.post(`/api/v1/admin/referees/pay/payouts/${payoutId}/retry`);
    expect(again.body.payout.status).toBe("paid");
    expect(before - stripe.available).toBe(3500);
    expect(stripe.transfers.filter((t) => t.transfer_group === payoutId)).toHaveLength(1);
  });

  it("a payout that can't be sent can be voided so its games are owed again", async () => {
    const r = await payableReferee("voided");
    const g = await newGame(inDays(1.7));
    await r.a.post(`/api/v1/referees/games/${g}/claim`);
    await db.update(games).set({ status: "final", homeScore: 2, awayScore: 0 }).where(eq(games.id, g));
    const owed = (await admin.get("/api/v1/admin/referees/pay")).body.owed.find((o: { userId: string }) => o.userId === r.userId);
    const ids = owed.games.map((x: { officialId: string }) => x.officialId);
    const saved = stripe.available;
    stripe.available = 0;
    const res = await admin.post("/api/v1/admin/referees/pay/approve").send({ officialIds: ids });
    const payoutId = res.body.payouts[0].id;
    expect((await admin.post(`/api/v1/admin/referees/pay/payouts/${payoutId}/void`).send({ reason: "Wrong rate" })).body).toMatchObject({ ok: true, games: 1 });
    stripe.available = saved;
    const view = (await admin.get("/api/v1/admin/referees/pay")).body;
    expect(view.owed.find((o: { userId: string }) => o.userId === r.userId).games.map((x: { officialId: string }) => x.officialId)).toEqual(ids);
    expect(view.waiting.some((w: { id: string }) => w.id === payoutId)).toBe(false);
    expect((await admin.post(`/api/v1/admin/referees/pay/payouts/${payoutId}/void`).send({ reason: "again" })).status).toBe(409);
    expect((await r.a.get("/api/v1/referees/pay")).body.payouts.some((p: { id: string }) => p.id === payoutId)).toBe(false);
  });

  it("revoking keeps games already played (still owed); a game with owed referees can't be deleted", async () => {
    const r = await payableReferee("keepsPay".toLowerCase());
    const played = await newGame(inDays(2.5));
    await r.a.post(`/api/v1/referees/games/${played}/claim`);
    // Played yesterday, score not entered yet.
    await db.update(games).set({ startsAt: inDays(-1) }).where(eq(games.id, played));
    const res = await admin.post(`/api/v1/admin/referees/applications/${r.appId}/revoke`).send({ reason: "Season over for them" });
    expect(res.body.gamesRemoved).toBe(0);
    expect((await admin.delete(`/api/v1/admin/schedule/games/${played}`)).status).toBe(409);
    await db.update(games).set({ status: "final", homeScore: 6, awayScore: 0 }).where(eq(games.id, played));
    const owed = (await admin.get("/api/v1/admin/referees/pay")).body.owed.find((o: { userId: string }) => o.userId === r.userId);
    expect(owed.totalCents).toBe(3500);
    // A revoked referee can't sign up again this season, but can still reach payout setup while owed.
    expect((await r.a.post("/api/v1/referees/applications").send(form)).status).toBe(409);
    expect((await r.a.post("/api/v1/referees/payouts/session")).status).toBe(200);
  });

  it("an admin who also referees can't assign themselves, change their own pay or approve it", async () => {
    const appRes = await admin.get("/api/v1/admin/referees/applications");
    const own = appRes.body.items.find((i: { email: string }) => i.email.startsWith("ref-admin"));
    // Another admin approves this admin's sign-up.
    const other = agent();
    const email = uniqueEmail("ref-admin2");
    await signUp(other, email, "Second Admin");
    const [u2] = await db.select().from(user).where(eq(user.email, email));
    await db.insert(userRoleAssignments).values({ userId: u2!.id, roleKey: "league_admin" });
    await other.put(`/api/v1/admin/referees/applications/${own.id}/screening`).send({ status: "cleared", completedOn: "2026-10-01" });
    await other.put(`/api/v1/admin/referees/applications/${own.id}/certification`).send({ verified: true });
    expect((await other.post(`/api/v1/admin/referees/applications/${own.id}/decision`).send({ decision: "approved" })).status).toBe(200);
    const g = await newGame(inDays(12));
    expect((await admin.post(`/api/v1/admin/referees/games/${g}/officials`).send({ userId: adminId })).status).toBe(403);
    const o = await other.post(`/api/v1/admin/referees/games/${g}/officials`).send({ userId: adminId });
    expect(o.status).toBe(201);
    await db.update(games).set({ status: "final", homeScore: 1, awayScore: 0, startsAt: inDays(-3) }).where(eq(games.id, g));
    expect((await admin.patch(`/api/v1/admin/referees/officials/${o.body.official.id}`).send({ rateCents: 100000 })).status).toBe(403);
    expect((await admin.post("/api/v1/admin/referees/pay/approve").send({ officialIds: [o.body.official.id] })).status).toBe(403);
    await db.update(userRoleAssignments).set({ revokedAt: new Date() }).where(eq(userRoleAssignments.userId, u2!.id));
  });

  it("a referee's claims are checked one at a time, so two at once can't both pass the clash check", async () => {
    const r = await approvedReferee("racer");
    const g1 = await newGame(inDays(20));
    const g2 = await newGame(new Date(inDays(20).getTime() + 30 * 60_000));
    const [a, b] = await Promise.all([r.a.post(`/api/v1/referees/games/${g1}/claim`), r.a.post(`/api/v1/referees/games/${g2}/claim`)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it("adds funds, gives a year-end CSV, and limits pay to admins with permission", async () => {
    const t = await admin.post("/api/v1/admin/referees/pay/add-funds").send({ amountCents: 50000 });
    expect(t.body.topup).toMatchObject({ status: "pending", expectedAvailableOn: "2030-01-01" });
    const csv = await admin.get(`/api/v1/admin/referees/pay/report.csv?year=${new Date().getFullYear()}`);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.text.split("\n")[0]).toBe("Referee,Email,Payments,Total paid,Stripe account");
    expect(csv.text).toContain("paid Ref");
    const r = await referee("nosy");
    expect((await r.a.get("/api/v1/admin/referees/pay")).status).toBe(403);
    expect((await r.a.get("/api/v1/admin/referees/applications")).status).toBe(403);
    const [evt] = await db.select().from(outboxEvents).where(and(eq(outboxEvents.eventName, "referee.paid"))).limit(1);
    expect(evt).toBeTruthy();
    expect((await db.select().from(gameOfficials).where(eq(gameOfficials.status, "worked"))).length).toBeGreaterThan(0);
  });
});
