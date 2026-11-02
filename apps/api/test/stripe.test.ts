/**
 * Stripe as the card provider: registration and coach fees, bank checks
 * (3-D Secure), lost responses, webhooks and refunds. Stripe's API is faked.
 */
import { and, eq, like } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/client.js";
import { featureFlags, payments, refunds, registrations, seasons, user, userRoleAssignments, volunteerApplications } from "../src/db/schema/index.js";
import { clearSubscribers, processOutbox } from "../src/modules/platform/outbox.js";
import { resetFlagCache } from "../src/modules/platform/flags.js";
import { reconcileProcessing } from "../src/modules/registration/service.js";
import { verifyStripeSignature } from "../src/modules/stripe/client.js";
import { registerSubscribers } from "../src/modules/subscribers.js";
import { agent, signUp, uniqueEmail, useProvider, type Agent } from "./helpers.js";

/* ---------------- fake Stripe ---------------- */

type PI = { id: string; status: string; amount: number; created: number; client_secret: string; metadata: Record<string, string>; latest_charge: unknown; last_payment_error: unknown };
const stripe = {
  calls: [] as { method: string; path: string; body: URLSearchParams; key: string | null }[],
  intents: new Map<string, PI>(),
  /** idempotency key → [status, body] of the original response. */
  byKey: new Map<string, [number, unknown]>(),
  seq: 0,
};
const realFetch = globalThis.fetch;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const charge = (pi: PI) => ({ id: `ch_${pi.id}`, receipt_url: `https://pay.stripe.com/receipts/${pi.id}`, payment_method_details: { card: { brand: "visa", last4: "4242" } } });

beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.host !== "api.stripe.com") return realFetch(input, init);
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== "Bearer sk_test_fake") return json(401, { error: { type: "invalid_request_error", message: "Invalid API Key provided" } });
    const method = init?.method ?? "GET";
    const body = new URLSearchParams(method === "POST" ? String(init?.body ?? "") : url.search);
    const key = headers.get("idempotency-key");
    stripe.calls.push({ method, path: url.pathname, body, key });
    if (method === "POST" && key && stripe.byKey.has(key)) {
      const [s, b] = stripe.byKey.get(key)!;
      return json(s, b, { "idempotent-replayed": "true" });
    }
    const remember = (s: number, b: unknown) => {
      if (key) stripe.byKey.set(key, [s, b]);
      return json(s, b);
    };
    if (method === "POST" && url.pathname === "/v1/payment_intents") {
      const token = body.get("confirmation_token");
      if (token === "ctoken_declined") {
        return remember(402, { error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds." } });
      }
      if (token === "ctoken_bad_request") return remember(400, { error: { type: "invalid_request_error", code: "parameter_unknown", message: "Received unknown parameter" } });
      const id = `pi_${++stripe.seq}`;
      const pi: PI = {
        id,
        status: token === "ctoken_3ds" ? "requires_action" : "succeeded",
        amount: Number(body.get("amount")),
        created: Math.floor(Date.now() / 1000),
        client_secret: `${id}_secret_x`,
        metadata: { reference: body.get("metadata[reference]") ?? "" },
        latest_charge: null,
        last_payment_error: null,
      };
      if (pi.status === "succeeded") pi.latest_charge = charge(pi);
      stripe.intents.set(id, pi);
      const res = remember(200, pi);
      // Charged, but the response is lost on the way back.
      if (token === "ctoken_lost") return json(503, { error: { type: "api_error", message: "unavailable" } });
      return res;
    }
    const m = url.pathname.match(/^\/v1\/payment_intents\/([^/]+)(\/cancel)?$/);
    if (m) {
      const pi = stripe.intents.get(m[1]!);
      if (!pi) return json(404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such payment_intent" } });
      if (m[2]) {
        if (pi.status === "succeeded") return json(400, { error: { type: "invalid_request_error", code: "payment_intent_unexpected_state", message: "already succeeded" } });
        pi.status = "canceled";
      }
      return json(200, pi);
    }
    if (method === "POST" && url.pathname === "/v1/refunds") {
      return remember(200, { id: `re_${++stripe.seq}`, status: "pending", amount: Number(body.get("amount")), payment_intent: body.get("payment_intent") });
    }
    return json(404, { error: { type: "invalid_request_error", message: "not found" } });
  });
  clearSubscribers();
  registerSubscribers();
});

const lastCall = (path: string) => [...stripe.calls].reverse().find((c) => c.path === path);
/** The cardholder finishes the bank check in the browser. */
function completeAction(clientSecret: string) {
  const pi = stripe.intents.get(clientSecret.split("_secret")[0]!)!;
  pi.status = "succeeded";
  pi.latest_charge = charge(pi);
}

function signed(event: unknown) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex");
  return agent().post("/api/v1/webhooks/stripe").set("content-type", "application/json").set("stripe-signature", `t=${t},v1=${sig}`).send(body);
}
let evt = 0;
const event = (type: string, object: unknown) => ({ id: `evt_${++evt}_${Date.now()}`, type, livemode: false, data: { object } });

async function drain() {
  for (;;) {
    const r = await processOutbox(200);
    if (r.processed + r.failed === 0) return;
  }
}

/* ---------------- fixtures ---------------- */

let admin: Agent;
let adminId: string;
let divisionId: string;
let previousCurrent: string | null = null;
const accept = { signerName: "Pat Parent", acceptedWaivers: ["waiver-liability", "waiver-medical", "waiver-media"] };

async function startRegistration(name: string) {
  const a = agent();
  await signUp(a, uniqueEmail(name.toLowerCase()), `${name} Parent`);
  await a.post("/api/v1/households").send({ displayName: `The ${name} Family`, phone: "904-555-0100" });
  const p = await a.post("/api/v1/players").send({
    firstName: name,
    lastName: "Player",
    birthDate: "2016-06-01",
    gender: "boy",
    medical: { emergencyContactName: "Grandma", emergencyContactPhone: "904-555-0199" },
  });
  const r = await a.post("/api/v1/registrations").send({ playerId: p.body.player.id, divisionId, ...accept });
  expect(r.status).toBe(201);
  return { a, regId: r.body.registration.id as string };
}
const regStatus = async (id: string) => (await db.select().from(registrations).where(eq(registrations.id, id)))[0]!;

beforeAll(async () => {
  await useProvider("stripe");
  admin = agent();
  const email = uniqueEmail("stripe-admin");
  await signUp(admin, email, "Stripe Admin");
  const [u] = await db.select().from(user).where(eq(user.email, email));
  adminId = u!.id;
  await db.insert(userRoleAssignments).values({ userId: adminId, roleKey: "super_admin" });
  const [cur] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.isCurrent, "current"));
  previousCurrent = cur?.id ?? null;
  const s = await admin.post("/api/v1/admin/league/seasons").send({
    name: "Stripe Season",
    year: 2027,
    status: "registration_open",
    registrationOpensAt: new Date(Date.now() - 86400_000).toISOString(),
    registrationClosesAt: "",
    ageCutoffDate: "",
    isCurrent: true,
  });
  const d = await admin.post(`/api/v1/admin/league/seasons/${s.body.season.id}/divisions`).send({ name: "Stripe 10U", genderPolicy: "coed", capacity: 50, priceCents: 10000, status: "open" });
  divisionId = d.body.division.id;
  await admin.put("/api/v1/admin/flags/r1b.registration").send({ enabled: true });
  await admin.put("/api/v1/admin/flags/r2.staff_applications").send({ enabled: true });
  resetFlagCache();
});

afterAll(async () => {
  await drain();
  clearSubscribers();
  vi.restoreAllMocks();
  await db.update(seasons).set({ isCurrent: null });
  if (previousCurrent) await db.update(seasons).set({ isCurrent: "current" }).where(eq(seasons.id, previousCurrent));
  else await db.update(seasons).set({ isCurrent: "current" }).where(like(seasons.name, "%(sample)"));
  await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, "r1b.registration"));
  await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, "r2.staff_applications"));
  await db.update(userRoleAssignments).set({ revokedAt: new Date() }).where(eq(userRoleAssignments.userId, adminId));
  await useProvider("square");
  resetFlagCache();
});

/* ---------------- tests ---------------- */

describe("Stripe checkout", () => {
  it("offers the Stripe card form and charges a confirmed PaymentIntent", async () => {
    const { a, regId } = await startRegistration("Stripey");
    const opts = await a.get("/api/v1/registration/options");
    expect(opts.body.checkout).toEqual({ provider: "stripe", publishableKey: "pk_test_fake", environment: "test" });

    const res = await a.post(`/api/v1/registrations/${regId}/pay`).send({ sourceId: "ctoken_ok", expectedTotalCents: 10000 });
    expect(res.status).toBe(200);
    expect(res.body.registration.status).toBe("paid");
    const call = lastCall("/v1/payment_intents")!;
    expect(call.body.get("amount")).toBe("10000");
    expect(call.body.get("confirm")).toBe("true");
    expect(call.body.get("confirmation_token")).toBe("ctoken_ok");
    expect(call.body.get("payment_method_types[0]")).toBe("card");
    expect(call.body.get("metadata[reference]")).toBe(regId);
    expect(call.key).toBeTruthy();
    const [p] = await db.select().from(payments).where(eq(payments.registrationId, regId));
    expect(p).toMatchObject({ provider: "stripe", providerEnvironment: "test", status: "COMPLETED", amountCents: 10000, cardBrand: "VISA", cardLast4: "4242" });
    expect(p!.receiptUrl).toContain("pay.stripe.com");
  });

  it("a declined card goes back to unpaid with a message the family can act on, and can be retried", async () => {
    const { a, regId } = await startRegistration("Declined");
    const res = await a.post(`/api/v1/registrations/${regId}/pay`).send({ sourceId: "ctoken_declined" });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ code: "PAYMENT_FAILED", message: "The card was declined for insufficient funds." });
    expect(await regStatus(regId)).toMatchObject({ status: "pending_payment", paymentError: "The card was declined for insufficient funds." });
    expect((await a.post(`/api/v1/registrations/${regId}/pay`).send({ sourceId: "ctoken_ok" })).body.registration.status).toBe("paid");
  });

  it("a problem with our Stripe request isn't blamed on the card", async () => {
    const { a, regId } = await startRegistration("Setup");
    const res = await a.post(`/api/v1/registrations/${regId}/pay`).send({ sourceId: "ctoken_bad_request" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("PAYMENTS_UNAVAILABLE");
    expect((await regStatus(regId)).status).toBe("pending_payment");
  });

  it("a bank check (3-D Secure): the browser finishes it, then confirm settles the payment", async () => {
    const { a, regId } = await startRegistration("Secure");
    const res = await a.post(`/api/v1/registrations/${regId}/pay`).send({ sourceId: "ctoken_3ds" });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe("PAYMENT_ACTION_REQUIRED");
    const clientSecret = res.body.error.clientSecret as string;
    expect(clientSecret).toMatch(/^pi_\d+_secret/);
    const r = await regStatus(regId);
    expect(r.status).toBe("processing");
    expect((r.paymentRequest as { intentId?: string }).intentId).toBe(clientSecret.split("_secret")[0]);
    // Can't pay twice meanwhile.
    expect((await a.post(`/api/v1/registrations/${regId}/pay`).send({ sourceId: "ctoken_ok" })).status).toBe(409);

    completeAction(clientSecret);
    const done = await a.post(`/api/v1/registrations/${regId}/pay/confirm`);
    expect(done.status).toBe(200);
    expect(done.body.registration.status).toBe("paid");
    // Confirming again is harmless.
    expect((await a.post(`/api/v1/registrations/${regId}/pay/confirm`)).body.registration.status).toBe("paid");
    // Another family can't confirm it.
    const other = await startRegistration("Nosy");
    expect((await other.a.post(`/api/v1/registrations/${regId}/pay/confirm`)).status).toBe(404);
  });

  it("an unfinished bank check is cancelled so the family can try again", async () => {
    const { a, regId } = await startRegistration("Abandon");
    const res = await a.post(`/api/v1/registrations/${regId}/pay`).send({ sourceId: "ctoken_3ds" });
    const intentId = (res.body.error.clientSecret as string).split("_secret")[0]!;
    const confirm = await a.post(`/api/v1/registrations/${regId}/pay/confirm`);
    expect(confirm.status).toBe(402);
    expect(confirm.body.error.code).toBe("PAYMENT_FAILED");
    expect(stripe.intents.get(intentId)!.status).toBe("canceled");
    expect((await regStatus(regId)).status).toBe("pending_payment");
    expect((await a.post(`/api/v1/registrations/${regId}/pay`).send({ sourceId: "ctoken_ok" })).body.registration.status).toBe("paid");
  });

  it("the worker settles a payment whose response was lost (same idempotency key, read back fresh)", async () => {
    const { a, regId } = await startRegistration("Lost");
    const res = await a.post(`/api/v1/registrations/${regId}/pay`).send({ sourceId: "ctoken_lost" });
    expect(res.body.error.code).toBe("PAYMENT_PENDING");
    const key = lastCall("/v1/payment_intents")!.key;
    expect(await reconcileProcessing(0)).toBeGreaterThanOrEqual(1);
    expect((await regStatus(regId)).status).toBe("paid");
    const resent = stripe.calls.filter((c) => c.path === "/v1/payment_intents" && c.key === key);
    expect(resent).toHaveLength(2);
    expect((await db.select().from(payments).where(eq(payments.registrationId, regId))).length).toBe(1);
  });

  it("webhook: a payment that succeeded later is recorded; bad signatures and other modes are ignored", async () => {
    const { a, regId } = await startRegistration("Hooked");
    const res = await a.post(`/api/v1/registrations/${regId}/pay`).send({ sourceId: "ctoken_3ds" });
    const intentId = (res.body.error.clientSecret as string).split("_secret")[0]!;
    completeAction(res.body.error.clientSecret);
    const pi = stripe.intents.get(intentId)!;

    const bad = await agent().post("/api/v1/webhooks/stripe").set("content-type", "application/json").set("stripe-signature", "t=1,v1=00").send("{}");
    expect(bad.status).toBe(403);
    expect((await signed({ ...event("payment_intent.succeeded", pi), livemode: true })).status).toBe(200);
    expect((await regStatus(regId)).status).toBe("processing"); // a live-mode event doesn't touch test records

    const e = event("payment_intent.succeeded", { ...pi, latest_charge: `ch_${pi.id}` });
    expect((await signed(e)).status).toBe(200);
    expect((await regStatus(regId)).status).toBe("paid");
    const [p] = await db.select().from(payments).where(eq(payments.registrationId, regId));
    expect(p!.cardLast4).toBe("4242");
    expect((await signed(e)).body.duplicate).toBe(true);
  });

  it("webhook: a failed attempt frees the registration only if it's the current one", async () => {
    const { a, regId } = await startRegistration("Failhook");
    const res = await a.post(`/api/v1/registrations/${regId}/pay`).send({ sourceId: "ctoken_3ds" });
    const pi = stripe.intents.get((res.body.error.clientSecret as string).split("_secret")[0]!)!;
    // An old failed attempt (created well before this one) is ignored.
    await signed(event("payment_intent.payment_failed", { ...pi, id: "pi_old", status: "requires_payment_method", created: pi.created - 3600 }));
    expect((await regStatus(regId)).status).toBe("processing");
    await signed(event("payment_intent.payment_failed", { ...pi, status: "requires_payment_method", last_payment_error: { code: "card_declined", decline_code: "generic_decline" } }));
    expect(await regStatus(regId)).toMatchObject({ status: "pending_payment", paymentError: "Your card was declined. Please try another card or contact your bank." });
  });

  it("refunds through Stripe (even after switching to Square) and records refund updates and dashboard refunds", async () => {
    const { a, regId } = await startRegistration("Refundee");
    await a.post(`/api/v1/registrations/${regId}/pay`).send({ sourceId: "ctoken_ok" });
    const [p] = await db.select().from(payments).where(eq(payments.registrationId, regId));

    await useProvider("square");
    const r = await admin.post(`/api/v1/admin/league/registrations/${regId}/refund`).send({ amountCents: 4000, reason: "Partial refund" });
    expect(r.status).toBe(200);
    expect(lastCall("/v1/refunds")!.body.get("payment_intent")).toBe(p!.providerPaymentId);
    expect(lastCall("/v1/refunds")!.body.get("amount")).toBe("4000");
    const refundId = r.body.refund.refundId as string;
    expect(r.body.refund.status).toBe("PENDING");

    await signed(event("refund.updated", { id: refundId, status: "succeeded", amount: 4000, payment_intent: p!.providerPaymentId }));
    const [row] = await db.select().from(refunds).where(eq(refunds.providerRefundId, refundId));
    expect(row!.status).toBe("COMPLETED");

    // A refund made in the Stripe dashboard.
    await signed(event("refund.created", { id: "re_dashboard", status: "succeeded", amount: 1000, payment_intent: p!.providerPaymentId }));
    const [after] = await db.select().from(payments).where(eq(payments.id, p!.id));
    expect(after!.refundedCents).toBe(5000);
    const [dash] = await db.select().from(refunds).where(and(eq(refunds.paymentId, p!.id), eq(refunds.providerRefundId, "re_dashboard")));
    expect(dash!.reason).toBe("Refund reported by Stripe");
    await useProvider("stripe");
  });

  it("coach and team mom fees go through Stripe too, including the bank check", async () => {
    const v = agent();
    const email = uniqueEmail("stripe-coach");
    await signUp(v, email, "Coach Stripe");
    expect((await v.get("/api/v1/volunteer/options")).body.checkout).toMatchObject({ provider: "stripe" });
    const created = await v.post("/api/v1/volunteer/applications").send({
      roleKey: "head_coach",
      phone: "904-555-0111",
      experience: "Coached 3 seasons",
      signerName: "Coach Stripe",
      acceptAgreement: true,
    });
    expect(created.status).toBe(201);
    const id = created.body.application.id as string;
    const res = await v.post(`/api/v1/volunteer/applications/${id}/pay`).send({ sourceId: "ctoken_3ds", expectedTotalCents: 2500 });
    expect(res.body.error.code).toBe("PAYMENT_ACTION_REQUIRED");
    expect(lastCall("/v1/payment_intents")!.body.get("metadata[reference]")).toBe(`app:${id}`);
    completeAction(res.body.error.clientSecret);
    const done = await v.post(`/api/v1/volunteer/applications/${id}/pay/confirm`);
    expect(done.body.application.status).toBe("submitted");
    const [p] = await db.select().from(payments).where(eq(payments.applicationId, id));
    expect(p).toMatchObject({ provider: "stripe", amountCents: 2500 });
    const [app] = await db.select().from(volunteerApplications).where(eq(volunteerApplications.id, id));
    expect(app!.paymentRequest).toBeNull();
  });

  it("only a Super Admin switches the provider, and the switch is kept when other settings are saved", async () => {
    expect((await admin.put("/api/v1/admin/league/payment-settings").send({ provider: "square" })).body.settings.provider).toBe("square");
    expect((await admin.put("/api/v1/admin/league/payment-settings").send({ holdMinutes: 20 })).body.settings).toMatchObject({ provider: "square", holdMinutes: 20 });
    const pay = await admin.get("/api/v1/admin/payments");
    expect(pay.body.stripe).toMatchObject({ configured: true, environment: "test", webhookConfigured: true });
    expect(pay.body.stripe.webhookUrl).toBe("http://localhost:3000/api/v1/webhooks/stripe");
    await admin.put("/api/v1/admin/league/payment-settings").send({ provider: "stripe", holdMinutes: 15 });
  });

  it("verifies Stripe signatures, rejecting stale ones", () => {
    const body = '{"id":"evt"}';
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex");
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`)).toBe(true);
    const tampered = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
    expect(verifyStripeSignature(body, `t=${t},v1=${tampered}`)).toBe(false);
    expect(verifyStripeSignature(body, `t=${t - 600},v1=${createHmac("sha256", "whsec_test").update(`${t - 600}.${body}`).digest("hex")}`)).toBe(false);
  });
});
