import { and, eq, like } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/client.js";
import {
  auditLogs,
  featureFlags,
  outboxEvents,
  payments,
  playerMedical,
  refunds,
  registrations,
  seasons,
  squareConnection,
  user,
  userRoleAssignments,
} from "../src/db/schema/index.js";
import { clearSubscribers, processOutbox } from "../src/modules/platform/outbox.js";
import { resetFlagCache } from "../src/modules/platform/flags.js";
import { expireHolds, reconcileProcessing } from "../src/modules/registration/service.js";
import { quote } from "../src/modules/registration/settings.js";
import { registerSubscribers } from "../src/modules/subscribers.js";
import { agent, mail, signUp, uniqueEmail, type Agent, useProvider } from "./helpers.js";

/* ---------------- fake Square ---------------- */

const square = {
  calls: [] as { path: string; body: Record<string, unknown> }[],
  paymentSeq: 0,
  refundSeq: 0,
  /** Idempotency key → payment, so a re-sent request returns the original result (like Square). */
  byKey: new Map<string, unknown>(),
  /** Keys whose first attempt "timed out" (the charge still happened). */
  timedOut: new Set<string>(),
};

const realFetch = globalThis.fetch;
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.host.includes("squareup")) return realFetch(input, init);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    square.calls.push({ path: url.pathname, body });
    switch (url.pathname) {
      case "/v2/payments": {
        if (body.source_id === "cnon:card-nonce-declined") {
          return json(400, { errors: [{ code: "CARD_DECLINED", category: "PAYMENT_METHOD_ERROR", detail: "Card declined." }] });
        }
        const key = String(body.idempotency_key);
        if (square.byKey.has(key)) return json(200, { payment: square.byKey.get(key) });
        if (body.source_id === "cnon:pending") return json(200, { payment: { id: `pay_${++square.paymentSeq}`, status: "PENDING", reference_id: body.reference_id } });
        const amount = body.amount_money as { amount: number };
        const payment = {
            id: `pay_${++square.paymentSeq}`,
            status: "COMPLETED",
            amount_money: { amount: amount.amount, currency: "USD" },
            reference_id: body.reference_id,
            location_id: body.location_id,
            receipt_url: "https://squareupsandbox.com/receipt/preview/x",
            card_details: { card: { card_brand: "VISA", last_4: "1111" } },
        };
        square.byKey.set(key, payment);
        // Charged, but the response is lost on the way back.
        if (body.source_id === "cnon:network-down") return json(503, { errors: [{ code: "SERVICE_UNAVAILABLE" }] });
        return json(200, { payment });
      }
      case "/v2/refunds":
        return json(200, { refund: { id: `ref_${++square.refundSeq}`, status: "PENDING" } });
      case "/oauth2/token":
        return json(200, {
          access_token: "EAAA-oauth-access",
          refresh_token: "EQAA-oauth-refresh",
          expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
          merchant_id: "MERCHANT_NFFL",
        });
      case "/v2/merchants/me":
        return json(200, { merchant: { business_name: "North Florida Flag League" } });
      case "/v2/locations/main":
        return json(200, { location: { id: "LMAIN", name: "NFFL Main" } });
      case "/oauth2/revoke":
        return json(200, { success: true });
      default:
        return json(404, { errors: [{ code: "NOT_FOUND" }] });
    }
  });
  clearSubscribers();
  registerSubscribers();
});

afterAll(async () => {
  // Leave no queued events or subscribers behind for other test files.
  await drainOutbox();
  clearSubscribers();
  vi.restoreAllMocks();
  // Later test files expect the seeded sample season to be current and one Super Admin.
  await db.update(seasons).set({ isCurrent: null });
  await db.update(seasons).set({ isCurrent: "current" }).where(like(seasons.name, "%(sample)"));
  await db.update(userRoleAssignments).set({ revokedAt: new Date() }).where(eq(userRoleAssignments.userId, adminUserId));
  await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, "r1b.registration"));
  resetFlagCache();
});

const lastCall = (path: string) => [...square.calls].reverse().find((c) => c.path === path);

function signWebhook(body: string) {
  return createHmac("sha256", "test-signature-key")
    .update("http://localhost:3000/api/v1/webhooks/square" + body)
    .digest("base64");
}

async function drainOutbox() {
  for (;;) {
    const { processed, failed } = await processOutbox(100);
    if (processed + failed === 0) return;
  }
}

/* ---------------- fixtures ---------------- */

let admin: Agent;
let adminEmail: string;
let adminUserId: string;
let seasonId: string;
let boysId: string; // capacity 2, 2017–2018 births
let girlsId: string;

async function makeAdmin() {
  adminEmail = uniqueEmail("reg-admin");
  admin = agent();
  await signUp(admin, adminEmail, "Avery Admin");
  const [u] = await db.select().from(user).where(eq(user.email, adminEmail));
  adminUserId = u!.id;
  await db.insert(userRoleAssignments).values({ userId: u!.id, roleKey: "super_admin" });
}

async function family(name: string) {
  const a = agent();
  const email = uniqueEmail(name.toLowerCase());

  await signUp(a, email, `${name} Parent`);
  const h = await a.post("/api/v1/households").send({ displayName: `The ${name} Family`, phone: "904-555-0100" });
  expect(h.status).toBe(201);
  return { a, email };
}

const MEDICAL = {
  allergies: "Peanuts",
  emergencyContactName: "Grandma",
  emergencyContactPhone: "904-555-0199",
};

async function addPlayer(a: Agent, over: Record<string, unknown> = {}) {
  const res = await a.post("/api/v1/players").send({
    firstName: "Sam",
    lastName: "Player",
    birthDate: "2017-06-01",
    gender: "boy",
    shirtSize: "YM",
    medical: MEDICAL,
    ...over,
  });
  expect(res.status).toBe(201);
  return res.body.player.id as string;
}

const accept = { signerName: "Pat Parent", acceptedWaivers: ["waiver-liability", "waiver-medical", "waiver-media"] };

beforeAll(async () => {
  await useProvider("square");
  await makeAdmin();
  const s = await admin.post("/api/v1/admin/league/seasons").send({
    name: "2027 Spring Season",
    year: 2027,
    status: "registration_open",
    registrationOpensAt: new Date(Date.now() - 86400_000).toISOString(),
    registrationClosesAt: "",
    ageCutoffDate: "2026-09-01",
    isCurrent: true,
  });
  expect(s.status).toBe(201);
  seasonId = s.body.season.id;
  const d1 = await admin.post(`/api/v1/admin/league/seasons/${seasonId}/divisions`).send({
    name: "Boys 8U",
    genderPolicy: "boys",
    birthDateFrom: "2017-01-01",
    birthDateTo: "2018-12-31",
    capacity: 2,
    priceCents: 10000,
    status: "open",
  });
  expect(d1.status).toBe(201);
  boysId = d1.body.division.id;
  const d2 = await admin.post(`/api/v1/admin/league/seasons/${seasonId}/divisions`).send({
    name: "Girls 10U",
    genderPolicy: "girls",
    capacity: 20,
    priceCents: 10000,
    status: "open",
  });
  girlsId = d2.body.division.id;
});

/* ---------------- tests ---------------- */

describe("fee quote", () => {
  it("adds nothing when the league absorbs the fee and grosses up when the parent pays", () => {
    const s = { feeMode: "league" as const, feePercentBps: 290, feeFixedCents: 30, holdMinutes: 15, offerHours: 48 };
    expect(quote(10000, s)).toEqual({ priceCents: 10000, feeCents: 0, totalCents: 10000 });
    const p = quote(10000, { ...s, feeMode: "parent" });
    expect(p).toEqual({ priceCents: 10000, feeCents: 330, totalCents: 10330 });
    // After Square's 2.9% + 30¢ the league still nets at least the price.
    expect(p.totalCents - Math.round(p.totalCents * 0.029) - 30).toBeGreaterThanOrEqual(10000);
  });
});

describe("players", () => {
  it("keeps medical details separate and private to the family", async () => {
    const { a } = await family("Medic");
    const id = await addPlayer(a);
    const mine = await a.get(`/api/v1/players/${id}`);
    expect(mine.body.medical.allergies).toBe("Peanuts");
    const [m] = await db.select().from(playerMedical).where(eq(playerMedical.playerId, id));
    expect(m!.emergencyContactName).toBe("Grandma");
    const [log] = await db.select().from(auditLogs).where(and(eq(auditLogs.targetId, id), eq(auditLogs.action, "player.create")));
    expect(JSON.stringify(log!.after)).not.toContain("Peanuts");

    const other = await family("Snoop");
    expect((await other.a.get(`/api/v1/players/${id}`)).status).toBe(404);
  });

  it("requires an emergency contact", async () => {
    const { a } = await family("NoContact");
    const res = await a.post("/api/v1/players").send({ firstName: "A", lastName: "B", birthDate: "2017-01-01", gender: "boy", medical: {} });
    expect(res.status).toBe(400);
  });
});

describe("registration and payment", () => {
  it("is closed until the release switch is on", async () => {
    await admin.put("/api/v1/admin/flags/r1b.registration").send({ enabled: false });
    resetFlagCache();
    const { a } = await family("Early");
    const id = await addPlayer(a);
    const res = await a.post("/api/v1/registrations").send({ playerId: id, divisionId: boysId, ...accept });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FEATURE_DISABLED");

    expect((await admin.put("/api/v1/admin/flags/r1b.registration").send({ enabled: true })).status).toBe(200);
    resetFlagCache();
  });

  it("shows options with prices, waivers and the card form settings", async () => {
    const { a } = await family("Options");
    const res = await a.get("/api/v1/registration/options");
    expect(res.status).toBe(200);
    expect(res.body.window.open).toBe(true);
    expect(res.body.divisions.map((d: { name: string }) => d.name)).toEqual(expect.arrayContaining(["Boys 8U", "Girls 10U"]));
    expect(res.body.divisions[0]).toMatchObject({ priceCents: 10000, feeCents: 0, totalCents: 10000 });
    expect(res.body.waivers).toHaveLength(3);
    expect(res.body.checkout).toEqual({ provider: "square", applicationId: "sandbox-sq0idb-test", locationId: "LTEST", environment: "sandbox" });
  });

  it("enforces waivers and eligibility", async () => {
    const { a } = await family("Rules");
    const boy = await addPlayer(a);
    const tooOld = await addPlayer(a, { firstName: "Old", birthDate: "2014-01-01" });

    const noWaivers = await a.post("/api/v1/registrations").send({ playerId: boy, divisionId: boysId, signerName: "Pat Parent", acceptedWaivers: [] });
    expect(noWaivers.status).toBe(400);

    const wrongGender = await a.post("/api/v1/registrations").send({ playerId: boy, divisionId: girlsId, ...accept });
    expect(wrongGender.status).toBe(409);
    expect(wrongGender.body.error.message).toMatch(/girls/);

    const old = await a.post("/api/v1/registrations").send({ playerId: tooOld, divisionId: boysId, ...accept });
    expect(old.status).toBe(409);
    expect(old.body.error.message).toMatch(/too old/);
  });

  let paidRegId: string;
  let paidFamilyEmail: string;

  it("holds a spot, survives a declined card, then takes payment and emails a receipt", async () => {
    const { a, email } = await family("Payer");
    paidFamilyEmail = email;
    const pid = await addPlayer(a, { lastName: "=HYPERLINK(evil)" });

    const start = await a.post("/api/v1/registrations").send({ playerId: pid, divisionId: boysId, ...accept });
    expect(start.status).toBe(201);
    const reg = start.body.registration;
    expect(reg).toMatchObject({ status: "pending_payment", priceCents: 10000, feeCents: 0, totalCents: 10000 });
    expect(reg.waivers).toHaveLength(3);
    expect(reg.waivers[0]).toMatchObject({ signerName: "Pat Parent" });
    expect(reg.waivers[0].sha256).toHaveLength(64);

    const declined = await a.post(`/api/v1/registrations/${reg.id}/pay`).send({ sourceId: "cnon:card-nonce-declined" });
    expect(declined.status).toBe(402);
    expect(declined.body.error.message).toMatch(/declined/);
    const [afterDecline] = await db.select().from(registrations).where(eq(registrations.id, reg.id));
    expect(afterDecline!.status).toBe("pending_payment");

    const ok = await a.post(`/api/v1/registrations/${reg.id}/pay`).send({ sourceId: "cnon:card-nonce-ok" });
    expect(ok.status).toBe(200);
    expect(ok.body.registration.status).toBe("paid");
    const call = lastCall("/v2/payments")!;
    expect(call.body).toMatchObject({ amount_money: { amount: 10000, currency: "USD" }, location_id: "LTEST", reference_id: reg.id });
    paidRegId = reg.id;

    // Can't pay twice.
    expect((await a.post(`/api/v1/registrations/${reg.id}/pay`).send({ sourceId: "cnon:card-nonce-ok" })).status).toBe(409);

    const [p] = await db.select().from(payments).where(eq(payments.registrationId, reg.id));
    expect(p).toMatchObject({ status: "COMPLETED", amountCents: 10000, cardLast4: "1111", providerEnvironment: "sandbox" });

    await drainOutbox();
    const receipt = mail.last(email, "registration.paid");
    expect(receipt?.text).toContain("$100.00");
    expect(receipt?.text).toContain("Boys 8U");

    const mine = await a.get("/api/v1/registrations");
    expect(mine.body.items[0]).toMatchObject({ status: "paid", divisionName: "Boys 8U" });
    expect(mine.body.items[0].payment.cardLast4).toBe("1111");
  });

  it("stops at capacity, counting live holds", async () => {
    const one = await family("Second");
    const p1 = await addPlayer(one.a);
    const r1 = await one.a.post("/api/v1/registrations").send({ playerId: p1, divisionId: boysId, ...accept });
    expect(r1.status).toBe(201); // 2nd of 2 spots (held)

    const two = await family("Third");
    const p2 = await addPlayer(two.a);
    const full = await two.a.post("/api/v1/registrations").send({ playerId: p2, divisionId: boysId, ...accept });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe("DIVISION_FULL");

    // The hold runs out: the worker releases it and the spot opens up again.
    await db.update(registrations).set({ holdExpiresAt: new Date(Date.now() - 5 * 60_000) }).where(eq(registrations.id, r1.body.registration.id));
    expect(await expireHolds()).toBeGreaterThanOrEqual(1);
    const now = await two.a.post("/api/v1/registrations").send({ playerId: p2, divisionId: boysId, ...accept });
    expect(now.status).toBe(201);

    // First family comes back after their hold expired: the division is full again, so no charge.
    const late = await one.a.post(`/api/v1/registrations/${r1.body.registration.id}/pay`).send({ sourceId: "cnon:card-nonce-ok" });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("DIVISION_FULL");

    // Clean up for later tests: free the held spot.
    await two.a.post(`/api/v1/registrations/${now.body.registration.id}/cancel`).send({});
  });

  it("adds a processing fee when the league switches the fee to parents", async () => {
    const set = await admin
      .put("/api/v1/admin/league/payment-settings")
      .send({ feeMode: "parent", feePercentBps: 290, feeFixedCents: 30, holdMinutes: 15 });
    expect(set.status).toBe(200);
    const { a } = await family("FeePayer");
    const opts = await a.get("/api/v1/registration/options");
    expect(opts.body.feeMode).toBe("parent");
    const girls = opts.body.divisions.find((d: { name: string }) => d.name === "Girls 10U");
    expect(girls).toMatchObject({ priceCents: 10000, feeCents: 330, totalCents: 10330 });

    const pid = await addPlayer(a, { firstName: "Gina", gender: "girl", birthDate: "2016-03-03" });
    const r = await a.post("/api/v1/registrations").send({ playerId: pid, divisionId: girlsId, ...accept });
    expect(r.body.registration.totalCents).toBe(10330);
    await a.post(`/api/v1/registrations/${r.body.registration.id}/pay`).send({ sourceId: "cnon:card-nonce-ok" });
    expect((lastCall("/v2/payments")!.body.amount_money as { amount: number }).amount).toBe(10330);

    await admin.put("/api/v1/admin/league/payment-settings").send({ feeMode: "league", feePercentBps: 290, feeFixedCents: 30, holdMinutes: 15 });
  });

  it("leaves an unknown outcome in processing instead of reverting", async () => {
    const { a } = await family("Flaky");
    const pid = await addPlayer(a, { firstName: "Fran", gender: "girl", birthDate: "2016-01-01" });
    const r = await a.post("/api/v1/registrations").send({ playerId: pid, divisionId: girlsId, ...accept });
    const res = await a.post(`/api/v1/registrations/${r.body.registration.id}/pay`).send({ sourceId: "cnon:network-down" });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("PAYMENT_PENDING");
    const [row] = await db.select().from(registrations).where(eq(registrations.id, r.body.registration.id));
    expect(row!.status).toBe("processing");

    // Square's webhook then confirms it was charged.
    const body = JSON.stringify({
      event_id: "evt-flaky-1",
      type: "payment.updated",
      data: { object: { payment: { id: "pay_webhook_1", status: "COMPLETED", reference_id: row!.id, amount_money: { amount: 10000, currency: "USD" } } } },
    });
    const hook = await agent().post("/api/v1/webhooks/square").set("content-type", "application/json").set("x-square-hmacsha256-signature", signWebhook(body)).send(body);
    expect(hook.status).toBe(200);
    const [after] = await db.select().from(registrations).where(eq(registrations.id, row!.id));
    expect(after!.status).toBe("paid");

    // Same event again is ignored.
    const dup = await agent().post("/api/v1/webhooks/square").set("content-type", "application/json").set("x-square-hmacsha256-signature", signWebhook(body)).send(body);
    expect(dup.body.duplicate).toBe(true);
  });

  it("rejects webhooks with a bad signature", async () => {
    const body = JSON.stringify({ event_id: "evt-forged", type: "payment.updated", data: {} });
    const res = await agent().post("/api/v1/webhooks/square").set("content-type", "application/json").set("x-square-hmacsha256-signature", "forged").send(body);
    expect(res.status).toBe(403);
  });

  describe("admin", () => {
    it("forbids parents", async () => {
      const { a } = await family("Nosy");
      expect((await a.get("/api/v1/admin/league/registrations")).status).toBe(403);
      expect((await a.get("/api/v1/admin/payments")).status).toBe(403);
      expect((await a.post("/api/v1/admin/payments/square/connect")).status).toBe(403);
    });

    it("lists, searches and shows a registration with medical details (audited)", async () => {
      const list = await admin.get(
        `/api/v1/admin/league/registrations?seasonId=${seasonId}&q=Payer&status=${encodeURIComponent("paid,approved,rejected,processing,pending_payment")}`,
      );
      expect(list.status).toBe(200);
      expect(list.body.items.map((r: { id: string }) => r.id)).toContain(paidRegId);

      const detail = await admin.get(`/api/v1/admin/league/registrations/${paidRegId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.medical.allergies).toBe("Peanuts");
      expect(detail.body.guardians[0].email).toBe(paidFamilyEmail);
      expect(detail.body.payments[0].amountCents).toBe(10000);
      const views = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "medical.view"), eq(auditLogs.targetId, detail.body.player.id)));
      expect(views.length).toBeGreaterThan(0);
    });

    it("exports CSV without letting cells run as formulas", async () => {
      const res = await admin.get(`/api/v1/admin/league/registrations/export.csv?seasonId=${seasonId}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.text).toContain(`"'=HYPERLINK(evil)"`);
      expect(res.text).toContain(paidFamilyEmail);
      expect(res.text).not.toContain("Peanuts");
    });

    it("rejects with a full refund and emails the family", async () => {
      const res = await admin
        .post(`/api/v1/admin/league/registrations/${paidRegId}/decision`)
        .send({ decision: "rejected", reason: "Birth certificate shows a 2016 birth date", refund: true });
      expect(res.status).toBe(200);
      expect(res.body.registration.status).toBe("rejected");
      expect(res.body.refund).toMatchObject({ amountCents: 10000, status: "PENDING" });
      expect(lastCall("/v2/refunds")!.body).toMatchObject({ amount_money: { amount: 10000, currency: "USD" } });

      const [p] = await db.select().from(payments).where(eq(payments.registrationId, paidRegId));
      expect(p!.refundedCents).toBe(10000);
      expect((await admin.post(`/api/v1/admin/league/registrations/${paidRegId}/refund`).send({ reason: "again" })).status).toBe(409);

      await drainOutbox();
      expect(mail.last(paidFamilyEmail, "registration.rejected")?.text).toContain("2016 birth date");
      expect(mail.last(paidFamilyEmail, "registration.refunded")?.text).toContain("$100.00");

      // Square later reports the refund failed: the amount becomes refundable again.
      const [ref] = await db.select().from(refunds).where(eq(refunds.paymentId, p!.id));
      const body = JSON.stringify({
        event_id: "evt-refund-failed",
        type: "refund.updated",
        data: { object: { refund: { id: ref!.providerRefundId, status: "FAILED", payment_id: p!.providerPaymentId } } },
      });
      await agent().post("/api/v1/webhooks/square").set("content-type", "application/json").set("x-square-hmacsha256-signature", signWebhook(body)).send(body);
      const [p2] = await db.select().from(payments).where(eq(payments.id, p!.id));
      expect(p2!.refundedCents).toBe(0);
    });
  });
});

describe("Square connection", () => {
  it("connects through OAuth and stores tokens encrypted", async () => {
    const start = await admin.post("/api/v1/admin/payments/square/connect");
    expect(start.status).toBe(200);
    const url = new URL(start.body.url);
    expect(url.host).toBe("connect.squareupsandbox.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/v1/square/oauth/callback");
    const state = url.searchParams.get("state")!;

    // A different signed-in user can't complete someone else's connect.
    const { a: stranger } = await family("Stranger");
    const hijack = await stranger.get(`/api/v1/square/oauth/callback?code=abc&state=${state}`);
    expect(hijack.headers.location).toContain("square=expired");

    // The stranger used up the state; start again.
    const again = await admin.post("/api/v1/admin/payments/square/connect");
    const state2 = new URL(again.body.url).searchParams.get("state")!;
    const cb = await admin.get(`/api/v1/square/oauth/callback?code=abc&state=${state2}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe("http://localhost:3000/admin/payments?square=connected");

    const [conn] = await db.select().from(squareConnection);
    expect(conn).toMatchObject({ merchantId: "MERCHANT_NFFL", locationId: "LMAIN", merchantName: "North Florida Flag League" });
    expect(conn!.accessTokenEnc).not.toContain("EAAA-oauth-access");

    const status = await admin.get("/api/v1/admin/payments");
    expect(status.body.square.active).toEqual({ source: "oauth", locationId: "LMAIN" });
    expect(JSON.stringify(status.body)).not.toContain("EAAA");

    // Checkout now charges the connected account.
    const { a } = await family("Connected");
    const pid = await addPlayer(a, { firstName: "Cora", gender: "girl", birthDate: "2016-05-05" });
    const r = await a.post("/api/v1/registrations").send({ playerId: pid, divisionId: girlsId, ...accept });
    await a.post(`/api/v1/registrations/${r.body.registration.id}/pay`).send({ sourceId: "cnon:card-nonce-ok" });
    expect(lastCall("/v2/payments")!.body.location_id).toBe("LMAIN");
  });

  it("disconnects only with typed confirmation, revokes at Square and emails Super Admins", async () => {
    expect((await admin.post("/api/v1/admin/payments/square/disconnect").send({ confirm: "yes" })).status).toBe(400);
    const res = await admin.post("/api/v1/admin/payments/square/disconnect").send({ confirm: "DISCONNECT", reason: "Testing" });
    expect(res.status).toBe(200);
    expect(res.body.revokedAtSquare).toBe(true);
    expect(lastCall("/oauth2/revoke")!.body).toMatchObject({ merchant_id: "MERCHANT_NFFL" });
    expect(await db.select().from(squareConnection)).toHaveLength(0);

    await drainOutbox();
    expect(mail.last(adminEmail, "admin.square_disconnected")?.text).toContain("Avery Admin");
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.eventName, "square.disconnected"));
    expect(events.length).toBeGreaterThan(0);
  });

  it("forgets the account when Square reports the authorization was revoked", async () => {
    const start = await admin.post("/api/v1/admin/payments/square/connect");
    const state = new URL(start.body.url).searchParams.get("state")!;
    await admin.get(`/api/v1/square/oauth/callback?code=abc&state=${state}`);
    expect(await db.select().from(squareConnection)).toHaveLength(1);

    const body = JSON.stringify({ event_id: "evt-revoked", merchant_id: "MERCHANT_NFFL", type: "oauth.authorization.revoked", data: {} });
    const res = await agent().post("/api/v1/webhooks/square").set("content-type", "application/json").set("x-square-hmacsha256-signature", signWebhook(body)).send(body);
    expect(res.status).toBe(200);
    expect(await db.select().from(squareConnection)).toHaveLength(0);
  });
});

describe("payment recovery and refunds (review fixes)", () => {
  const send = (body: string) =>
    agent().post("/api/v1/webhooks/square").set("content-type", "application/json").set("x-square-hmacsha256-signature", signWebhook(body)).send(body);

  async function startGirl(name: string) {
    const f = await family(name);
    const pid = await addPlayer(f.a, { firstName: name, gender: "girl", birthDate: "2016-02-02" });
    const r = await f.a.post("/api/v1/registrations").send({ playerId: pid, divisionId: girlsId, ...accept });
    expect(r.status).toBe(201);
    return { ...f, regId: r.body.registration.id as string, pid };
  }

  beforeAll(async () => {
    await admin.put("/api/v1/admin/flags/r1b.registration").send({ enabled: true });
    resetFlagCache();
  });

  it("the worker settles a payment whose response was lost, using the same idempotency key", async () => {
    const { a, regId } = await startGirl("Lost");
    const res = await a.post(`/api/v1/registrations/${regId}/pay`).send({ sourceId: "cnon:network-down" });
    expect(res.body.error.code).toBe("PAYMENT_PENDING");
    const firstKey = lastCall("/v2/payments")!.body.idempotency_key;
    // Still processing; the family can't pay again.
    expect((await a.post(`/api/v1/registrations/${regId}/pay`).send({ sourceId: "cnon:card-nonce-ok" })).status).toBe(409);

    await db.update(registrations).set({ processingStartedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(registrations.id, regId));
    expect(await reconcileProcessing()).toBeGreaterThanOrEqual(1);
    expect(lastCall("/v2/payments")!.body.idempotency_key).toBe(firstKey);
    const [r] = await db.select().from(registrations).where(eq(registrations.id, regId));
    expect(r).toMatchObject({ status: "paid", paymentRequest: null });
    expect(await db.select().from(payments).where(eq(payments.registrationId, regId))).toHaveLength(1);
  });

  it("a PENDING payment stays processing; a FAILED webhook frees it", async () => {
    const { a, regId } = await startGirl("Pending");
    const res = await a.post(`/api/v1/registrations/${regId}/pay`).send({ sourceId: "cnon:pending" });
    expect(res.body.error.code).toBe("PAYMENT_PENDING");
    const [r] = await db.select().from(registrations).where(eq(registrations.id, regId));
    expect(r!.status).toBe("processing");
    const body = JSON.stringify({ event_id: `evt-fail-${regId}`, type: "payment.updated", data: { object: { payment: { id: "pay_x_failed", status: "FAILED", reference_id: regId, created_at: new Date().toISOString() } } } });
    expect((await send(body)).status).toBe(200);
    const [after] = await db.select().from(registrations).where(eq(registrations.id, regId));
    expect(after!.status).toBe("pending_payment");
  });

  it("refunds a duplicate payment once, even when Square repeats the event", async () => {
    const { a, regId } = await startGirl("Twice");
    await a.post(`/api/v1/registrations/${regId}/pay`).send({ sourceId: "cnon:card-nonce-ok" });
    const refundsBefore = square.calls.filter((c) => c.path === "/v2/refunds").length;
    const dup = { id: `pay_dup_${regId}`, status: "COMPLETED", reference_id: regId, amount_money: { amount: 10000, currency: "USD" } };
    expect((await send(JSON.stringify({ event_id: `evt-dup1-${regId}`, type: "payment.updated", data: { object: { payment: dup } } }))).status).toBe(200);
    expect((await send(JSON.stringify({ event_id: `evt-dup2-${regId}`, type: "payment.updated", data: { object: { payment: dup } } }))).status).toBe(200);
    const refundCalls = square.calls.filter((c) => c.path === "/v2/refunds").slice(refundsBefore);
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0]!.body.payment_id).toBe(dup.id);
    const [r] = await db.select().from(registrations).where(eq(registrations.id, regId));
    expect(r!.status).toBe("paid");
  });

  it("refunds a payment that lands after the family cancelled, exactly once", async () => {
    const { regId } = await startGirl("Late");
    await admin.post(`/api/v1/admin/league/registrations/${regId}/cancel`).send({ reason: "Family asked", refund: false });
    const before = square.calls.filter((c) => c.path === "/v2/refunds").length;
    const late = { id: `pay_late_${regId}`, status: "COMPLETED", reference_id: regId, amount_money: { amount: 10000, currency: "USD" } };
    for (const n of [1, 2]) {
      const res = await send(JSON.stringify({ event_id: `evt-late${n}-${regId}`, type: "payment.updated", data: { object: { payment: late } } }));
      expect(res.status).toBe(200);
    }
    expect(square.calls.filter((c) => c.path === "/v2/refunds").length - before).toBe(1);
  });

  it("two refund clicks at once can't refund more than was paid", async () => {
    const { a, regId } = await startGirl("Clicky");
    await a.post(`/api/v1/registrations/${regId}/pay`).send({ sourceId: "cnon:card-nonce-ok" });
    const [r1, r2] = await Promise.all([
      admin.post(`/api/v1/admin/league/registrations/${regId}/refund`).send({ reason: "double click" }),
      admin.post(`/api/v1/admin/league/registrations/${regId}/refund`).send({ reason: "double click" }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const [p] = await db.select().from(payments).where(eq(payments.registrationId, regId));
    expect(p!.refundedCents).toBe(10000);
  });

  it("counts a refund made in the Square Dashboard", async () => {
    const { a, regId } = await startGirl("Dash");
    await a.post(`/api/v1/registrations/${regId}/pay`).send({ sourceId: "cnon:card-nonce-ok" });
    const [p] = await db.select().from(payments).where(eq(payments.registrationId, regId));
    const body = JSON.stringify({
      event_id: `evt-dash-${regId}`,
      type: "refund.created",
      data: { object: { refund: { id: `ref_dash_${regId}`, status: "PENDING", payment_id: p!.providerPaymentId, amount_money: { amount: 2500, currency: "USD" } } } },
    });
    expect((await send(body)).status).toBe(200);
    const [after] = await db.select().from(payments).where(eq(payments.id, p!.id));
    expect(after!.refundedCents).toBe(2500);
  });

  it("free divisions don't go to Square", async () => {
    const d = await admin.post(`/api/v1/admin/league/seasons/${seasonId}/divisions`).send({ name: "Free Clinic", genderPolicy: "coed", capacity: 10, priceCents: 0, status: "open" });
    const { a } = await family("Freebie");
    const pid = await addPlayer(a);
    const r = await a.post("/api/v1/registrations").send({ playerId: pid, divisionId: d.body.division.id, ...accept });
    const before = square.calls.length;
    const pay = await a.post(`/api/v1/registrations/${r.body.registration.id}/pay`).send({ sourceId: "none" });
    expect(pay.status).toBe(200);
    expect(pay.body.registration.status).toBe("paid");
    expect(square.calls.length).toBe(before);
  });

  it("won't re-take a lapsed hold once the division is closed", async () => {
    const { a, regId } = await startGirl("Closed");
    await db.update(registrations).set({ holdExpiresAt: new Date(Date.now() - 60_000) }).where(eq(registrations.id, regId));
    const d = await admin.get("/api/v1/admin/league/seasons");
    const girls = d.body.items.flatMap((x: { divisions: { id: string }[] }) => x.divisions).find((x: { id: string }) => x.id === girlsId);
    await admin.put(`/api/v1/admin/league/divisions/${girlsId}`).send({ ...girls, status: "closed", eligibilityNotes: girls.eligibilityNotes ?? "" , birthDateFrom: girls.birthDateFrom ?? "", birthDateTo: girls.birthDateTo ?? "" });
    const res = await a.post(`/api/v1/registrations/${regId}/pay`).send({ sourceId: "cnon:card-nonce-ok" });
    expect(res.status).toBe(409);
    await admin.put(`/api/v1/admin/league/divisions/${girlsId}`).send({ ...girls, status: "open", eligibilityNotes: girls.eligibilityNotes ?? "", birthDateFrom: girls.birthDateFrom ?? "", birthDateTo: girls.birthDateTo ?? "" });
  });
});
