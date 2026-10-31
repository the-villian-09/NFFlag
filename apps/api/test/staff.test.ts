import { and, eq, isNull } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/client.js";
import { featureFlags, payments, seasons, user, userRoleAssignments, volunteerApplications } from "../src/db/schema/index.js";
import { resetFlagCache } from "../src/modules/platform/flags.js";
import { clearSubscribers, processOutbox } from "../src/modules/platform/outbox.js";
import { reconcileApplications } from "../src/modules/staff/service.js";
import { registerSubscribers } from "../src/modules/subscribers.js";
import { agent, mail, signUp, uniqueEmail, type Agent } from "./helpers.js";

const calls: { path: string; body: Record<string, unknown> }[] = [];
const byKey = new Map<string, unknown>();
let seq = 0;
const realFetch = globalThis.fetch;
beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.host.includes("squareup")) return realFetch(input, init);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path: url.pathname, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v2/refunds") return json(200, { refund: { id: `st_ref_${++seq}`, status: "PENDING" } });
    if (body.source_id === "cnon:declined") return json(400, { errors: [{ code: "CARD_DECLINED", category: "PAYMENT_METHOD_ERROR" }] });
    if (byKey.has(body.idempotency_key)) return json(200, { payment: byKey.get(body.idempotency_key) });
    const payment = { id: `st_pay_${++seq}`, status: "COMPLETED", reference_id: body.reference_id, amount_money: body.amount_money };
    byKey.set(body.idempotency_key, payment);
    if (body.source_id === "cnon:lost") return json(503, { errors: [{ code: "SERVICE_UNAVAILABLE" }] });
    return json(200, { payment });
  });
  clearSubscribers();
  registerSubscribers();
});

const sign = (body: string) => createHmac("sha256", "test-signature-key").update("http://localhost:3000/api/v1/webhooks/square" + body).digest("base64");
const refundCalls = () => calls.filter((c) => c.path === "/v2/refunds").length;
async function drain() {
  for (;;) {
    const r = await processOutbox(200);
    if (r.processed + r.failed === 0) return;
  }
}

let admin: Agent;
let adminId: string;
let seasonId: string;
let previousCurrent: string | null = null;

async function volunteer(prefix: string) {
  const a = agent();
  const email = uniqueEmail(prefix);
  await signUp(a, email, `${prefix} Volunteer`);
  const [u] = await db.select().from(user).where(eq(user.email, email));
  return { a, email, userId: u!.id };
}
const form = { phone: "904-555-0111", experience: "Coached 3 seasons", signerName: "Val Volunteer", acceptAgreement: true };

beforeAll(async () => {
  const email = uniqueEmail("staff-admin");
  admin = agent();
  await signUp(admin, email);
  const [u] = await db.select().from(user).where(eq(user.email, email));
  adminId = u!.id;
  await db.insert(userRoleAssignments).values({ userId: adminId, roleKey: "super_admin" });
  const [cur] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.isCurrent, "current"));
  previousCurrent = cur?.id ?? null;
  const s = await admin.post("/api/v1/admin/league/seasons").send({
    name: "Staff Season",
    year: 2027,
    status: "registration_open",
    registrationOpensAt: new Date(Date.now() - 86400_000).toISOString(),
    registrationClosesAt: "",
    ageCutoffDate: "",
    isCurrent: true,
  });
  seasonId = s.body.season.id;
  await admin.put("/api/v1/admin/flags/r2.staff_applications").send({ enabled: false });
  resetFlagCache();
});

afterAll(async () => {
  await drain();
  clearSubscribers();
  vi.restoreAllMocks();
  await db.update(seasons).set({ isCurrent: null });
  if (previousCurrent) await db.update(seasons).set({ isCurrent: "current" }).where(eq(seasons.id, previousCurrent));
  await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, "r2.staff_applications"));
  await db.update(userRoleAssignments).set({ revokedAt: new Date() }).where(eq(userRoleAssignments.userId, adminId));
  resetFlagCache();
});

describe("volunteer applications", () => {
  it("apply, pay, record a cleared background check, approve → coach role for the season", async () => {
    const v = await volunteer("coach");
    expect((await v.a.post("/api/v1/volunteer/applications").send({ ...form, roleKey: "head_coach" })).status).toBe(403);
    await admin.put("/api/v1/admin/flags/r2.staff_applications").send({ enabled: true });
    resetFlagCache();

    const opts = await v.a.get("/api/v1/volunteer/options");
    expect(opts.body.enabled).toBe(true);
    expect(opts.body.roles.find((r: { key: string }) => r.key === "head_coach")).toMatchObject({ priceCents: 2500, totalCents: 2500 });
    expect(opts.body.agreement.slug).toBe("volunteer-agreement");

    expect((await v.a.post("/api/v1/volunteer/applications").send({ ...form, roleKey: "head_coach", acceptAgreement: false })).status).toBe(400);
    const created = await v.a.post("/api/v1/volunteer/applications").send({ ...form, roleKey: "head_coach" });
    expect(created.status).toBe(201);
    const app = created.body.application;
    expect(app).toMatchObject({ status: "pending_payment", totalCents: 2500 });
    expect(app.screeningStatus).toBeUndefined(); // applicants get a limited view
    const [stored] = await db.select().from(volunteerApplications).where(eq(volunteerApplications.id, app.id));
    expect((stored!.agreements as { signerName: string }[])[0]!.signerName).toBe("Val Volunteer");
    expect((await v.a.post("/api/v1/volunteer/applications").send({ ...form, roleKey: "head_coach" })).status).toBe(409);

    expect((await v.a.post(`/api/v1/volunteer/applications/${app.id}/pay`).send({ sourceId: "cnon:declined" })).status).toBe(402);
    const paid = await v.a.post(`/api/v1/volunteer/applications/${app.id}/pay`).send({ sourceId: "cnon:ok" });
    expect(paid.body.application.status).toBe("submitted");
    expect(calls.at(-1)!.body.reference_id).toBe(`app:${app.id}`);
    const [p] = await db.select().from(payments).where(eq(payments.applicationId, app.id));
    expect(p).toMatchObject({ amountCents: 2500, registrationId: null });
    await drain();
    expect(mail.last(v.email, "staff.application_submitted")?.text).toContain("$25.00");

    // Admin review
    const list = await admin.get(`/api/v1/admin/staff/applications?seasonId=${seasonId}`);
    expect(list.body.items.find((i: { id: string }) => i.id === app.id)).toMatchObject({ roleLabel: "Head coach", screeningStatus: "not_started" });
    expect((await v.a.get("/api/v1/admin/staff/applications")).status).toBe(403);

    const early = await admin.post(`/api/v1/admin/staff/applications/${app.id}/decision`).send({ decision: "approved" });
    expect(early.status).toBe(409);
    expect(early.body.error.message).toMatch(/background check/);
    expect((await admin.put(`/api/v1/admin/staff/applications/${app.id}/screening`).send({ status: "cleared" })).status).toBe(400);
    const old = await admin
      .put(`/api/v1/admin/staff/applications/${app.id}/screening`)
      .send({ status: "cleared", provider: "Sterling", completedOn: "2024-01-01", expiresOn: "2025-01-01" });
    expect(old.status).toBe(200);
    expect((await admin.post(`/api/v1/admin/staff/applications/${app.id}/decision`).send({ decision: "approved" })).body.error.message).toMatch(/expired/);
    await admin.put(`/api/v1/admin/staff/applications/${app.id}/screening`).send({ status: "cleared", provider: "Sterling", completedOn: "2026-10-01", expiresOn: "2028-10-01" });
    const ok = await admin.post(`/api/v1/admin/staff/applications/${app.id}/decision`).send({ decision: "approved" });
    expect(ok.status).toBe(200);
    expect(ok.body.application.status).toBe("approved");
    const [role] = await db
      .select()
      .from(userRoleAssignments)
      .where(and(eq(userRoleAssignments.userId, v.userId), eq(userRoleAssignments.roleKey, "head_coach"), isNull(userRoleAssignments.revokedAt)));
    expect(role).toMatchObject({ scopeType: "season", scopeId: seasonId });
    await drain();
    expect(mail.last(v.email, "staff.application_approved")).toBeTruthy();
    const detail = await admin.get(`/api/v1/admin/staff/applications/${app.id}`);
    expect(detail.body.application.paymentRequest).toBeUndefined();
    expect(detail.body.applicant.email).toBe(v.email);
  });

  it("rejecting refunds the fee and emails the applicant", async () => {
    const v = await volunteer("assistant");
    const app = (await v.a.post("/api/v1/volunteer/applications").send({ ...form, roleKey: "assistant_coach" })).body.application;
    await v.a.post(`/api/v1/volunteer/applications/${app.id}/pay`).send({ sourceId: "cnon:ok" });
    const before = refundCalls();
    const res = await admin.post(`/api/v1/admin/staff/applications/${app.id}/decision`).send({ decision: "rejected", reason: "Roster is full", refund: true });
    expect(res.status).toBe(200);
    expect(res.body.refund.amountCents).toBe(2500);
    expect(refundCalls() - before).toBe(1);
    await drain();
    expect(mail.last(v.email, "staff.application_rejected")?.text).toContain("Roster is full");
    expect(mail.last(v.email, "staff.application_refunded")?.text).toContain("$25.00");
  });

  it("withdrawing after paying refunds; a duplicate payment is refunded once", async () => {
    const v = await volunteer("manager");
    const app = (await v.a.post("/api/v1/volunteer/applications").send({ ...form, roleKey: "team_manager" })).body.application;
    await v.a.post(`/api/v1/volunteer/applications/${app.id}/pay`).send({ sourceId: "cnon:ok" });
    const dup = { id: `dup_${app.id}`, status: "COMPLETED", reference_id: `app:${app.id}`, amount_money: { amount: 2500, currency: "USD" } };
    const before = refundCalls();
    for (const n of [1, 2]) {
      const body = JSON.stringify({ event_id: `evt-st-dup${n}-${app.id}`, type: "payment.updated", data: { object: { payment: dup } } });
      expect((await agent().post("/api/v1/webhooks/square").set("content-type", "application/json").set("x-square-hmacsha256-signature", sign(body)).send(body)).status).toBe(200);
    }
    expect(refundCalls() - before).toBe(1);
    const w = await v.a.post(`/api/v1/volunteer/applications/${app.id}/withdraw`).send({});
    expect(w.body.application.status).toBe("withdrawn");
    expect(w.body.refund.amountCents).toBe(2500);
  });

  it("recovers a fee payment whose response was lost", async () => {
    const v = await volunteer("lost");
    const app = (await v.a.post("/api/v1/volunteer/applications").send({ ...form, roleKey: "assistant_coach" })).body.application;
    expect((await v.a.post(`/api/v1/volunteer/applications/${app.id}/pay`).send({ sourceId: "cnon:lost" })).body.error.code).toBe("PAYMENT_PENDING");
    await db.update(volunteerApplications).set({ processingStartedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(volunteerApplications.id, app.id));
    expect(await reconcileApplications()).toBeGreaterThanOrEqual(1);
    const [a] = await db.select().from(volunteerApplications).where(eq(volunteerApplications.id, app.id));
    expect(a!.status).toBe("submitted");
  });

  it("free roles skip payment", async () => {
    const s = (await admin.get("/api/v1/admin/payments")).body.settings;
    await admin.put("/api/v1/admin/league/payment-settings").send({ ...s, volunteerFees: { ...s.volunteerFees, team_manager: 0 } });
    const v = await volunteer("free");
    const app = (await v.a.post("/api/v1/volunteer/applications").send({ ...form, roleKey: "team_manager" })).body.application;
    expect(app).toMatchObject({ status: "submitted", totalCents: 0 });
    await admin.put("/api/v1/admin/league/payment-settings").send(s);
  });
});

describe("volunteer review fixes", () => {
  async function paidApp(prefix: string, role = "assistant_coach") {
    const v = await volunteer(prefix);
    const app = (await v.a.post("/api/v1/volunteer/applications").send({ ...form, roleKey: role })).body.application;
    await v.a.post(`/api/v1/volunteer/applications/${app.id}/pay`).send({ sourceId: "cnon:ok" });
    return { ...v, app };
  }
  const hook = (body: string) => agent().post("/api/v1/webhooks/square").set("content-type", "application/json").set("x-square-hmacsha256-signature", sign(body)).send(body);

  it("admins can't approve their own application", async () => {
    const own = (await admin.post("/api/v1/volunteer/applications").send({ ...form, roleKey: "head_coach" })).body.application;
    await admin.post(`/api/v1/volunteer/applications/${own.id}/pay`).send({ sourceId: "cnon:ok" });
    await admin.put(`/api/v1/admin/staff/applications/${own.id}/screening`).send({ status: "cleared", completedOn: "2026-10-01", expiresOn: "2028-10-01" });
    const res = await admin.post(`/api/v1/admin/staff/applications/${own.id}/decision`).send({ decision: "approved" });
    expect(res.status).toBe(403);
  });

  it("revoking an approval removes the season role; screening can't be downgraded while approved", async () => {
    const v = await paidApp("revoke");
    await admin.put(`/api/v1/admin/staff/applications/${v.app.id}/screening`).send({ status: "cleared", completedOn: "2026-10-01", expiresOn: "2028-10-01" });
    await admin.post(`/api/v1/admin/staff/applications/${v.app.id}/decision`).send({ decision: "approved" });
    expect((await admin.put(`/api/v1/admin/staff/applications/${v.app.id}/screening`).send({ status: "not_cleared" })).status).toBe(409);
    const r = await admin.post(`/api/v1/admin/staff/applications/${v.app.id}/revoke`).send({ reason: "Check came back not cleared" });
    expect(r.body.application.status).toBe("revoked");
    const roles = await db
      .select()
      .from(userRoleAssignments)
      .where(and(eq(userRoleAssignments.userId, v.userId), eq(userRoleAssignments.roleKey, "assistant_coach"), isNull(userRoleAssignments.revokedAt)));
    expect(roles).toHaveLength(0);
    // They can apply again later.
    expect((await v.a.post("/api/v1/volunteer/applications").send({ ...form, roleKey: "assistant_coach" })).status).toBe(201);
  });

  it("withdrawing refunds every payment (original and duplicate) and hides admin notes", async () => {
    const v = await paidApp("both");
    await admin.put(`/api/v1/admin/staff/applications/${v.app.id}/screening`).send({ status: "pending", notes: "Internal: waiting on provider" });
    // A duplicate arrives but its automatic refund fails (Square down), leaving two refundable payments.
    await db.insert(payments).values({ applicationId: v.app.id, providerEnvironment: "sandbox", providerPaymentId: `dup2_${v.app.id}`, status: "COMPLETED", amountCents: 2500 });
    const before = refundCalls();
    const w = await v.a.post(`/api/v1/volunteer/applications/${v.app.id}/withdraw`).send({});
    expect(w.body.refund.amountCents).toBe(5000);
    expect(refundCalls() - before).toBe(2);
    expect(JSON.stringify(w.body)).not.toContain("Internal");
    expect(w.body.application.screeningNotes).toBeUndefined();
  });

  it("an old declined card's FAILED webhook doesn't undo a newer attempt; bad references are ignored", async () => {
    const v = await volunteer("stale");
    const app = (await v.a.post("/api/v1/volunteer/applications").send({ ...form, roleKey: "team_manager" })).body.application;
    expect((await v.a.post(`/api/v1/volunteer/applications/${app.id}/pay`).send({ sourceId: "cnon:lost" })).body.error.code).toBe("PAYMENT_PENDING");
    const stale = JSON.stringify({
      event_id: `evt-stale-${app.id}`,
      type: "payment.updated",
      data: { object: { payment: { id: `old_${app.id}`, status: "FAILED", reference_id: `app:${app.id}`, created_at: new Date(Date.now() - 60_000).toISOString() } } },
    });
    expect((await hook(stale)).status).toBe(200);
    const [still] = await db.select().from(volunteerApplications).where(eq(volunteerApplications.id, app.id));
    expect(still!.status).toBe("processing");
    expect(still!.paymentRequest).not.toBeNull();

    const junk = JSON.stringify({ event_id: `evt-junk-${app.id}`, type: "payment.updated", data: { object: { payment: { id: "pos_1", status: "COMPLETED", reference_id: "app:not-a-uuid" } } } });
    expect((await hook(junk)).status).toBe(200);
    const pos = JSON.stringify({ event_id: `evt-pos-${app.id}`, type: "payment.updated", data: { object: { payment: { id: "pos_2", status: "COMPLETED", reference_id: "Table 4" } } } });
    expect((await hook(pos)).status).toBe(200);
  });
});
