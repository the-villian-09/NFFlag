import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { featureFlags, registrations, seasons, siteSettings, user, userRoleAssignments, volunteerApplications } from "../src/db/schema/index.js";
import { resetFlagCache } from "../src/modules/platform/flags.js";
import { discountFor } from "../src/modules/promo/service.js";
import { agent, signUp, uniqueEmail, type Agent } from "./helpers.js";

let admin: Agent;
let adminId: string;
let seasonId: string;
let boysId: string;
let girlsId: string;
let previousCurrent: string | null = null;
const accept = { signerName: "Pat Parent", acceptedWaivers: ["waiver-liability", "waiver-medical", "waiver-media"] };
const MEDICAL = { emergencyContactName: "Grandma", emergencyContactPhone: "904-555-0199" };

async function setFlag(key: string, on: boolean) {
  await db.insert(featureFlags).values({ key, enabled: on }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: on } });
  resetFlagCache();
}

async function family(name: string) {
  const a = agent();
  const email = uniqueEmail(name.toLowerCase());
  await signUp(a, email, `${name} Parent`);
  await a.post("/api/v1/households").send({ displayName: `The ${name} Family`, phone: "904-555-0100" });
  const [u] = await db.select().from(user).where(eq(user.email, email));
  return { a, email, userId: u!.id };
}

async function startReg(a: Agent, opts: { divisionId?: string; gender?: "boy" | "girl"; first?: string } = {}) {
  const p = await a.post("/api/v1/players").send({ firstName: opts.first ?? "Sam", lastName: "Kid", birthDate: "2017-06-01", gender: opts.gender ?? "boy", medical: MEDICAL });
  const r = await a.post("/api/v1/registrations").send({ playerId: p.body.player.id, divisionId: opts.divisionId ?? boysId, ...accept });
  expect(r.status).toBe(201);
  return r.body.registration as { id: string; totalCents: number };
}

const promo = (over: Record<string, unknown> = {}) => admin.post("/api/v1/admin/promo-codes").send({ kind: "percent", value: 20, appliesTo: "registration", ...over });
const apply = (a: Agent, regId: string, code: string | null) => a.put(`/api/v1/registrations/${regId}/promo`).send({ code });

beforeAll(async () => {
  const email = uniqueEmail("promo-admin");
  admin = agent();
  await signUp(admin, email, "Promo Admin");
  const [u] = await db.select().from(user).where(eq(user.email, email));
  adminId = u!.id;
  await db.insert(userRoleAssignments).values({ userId: adminId, roleKey: "super_admin" });
  const [cur] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.isCurrent, "current"));
  previousCurrent = cur?.id ?? null;
  await setFlag("r1b.registration", true);
  await setFlag("r2.staff_applications", true);
  await setFlag("r2.promo_codes", true);
  // League pays the card fee, so totals are easy to read.
  await db.delete(siteSettings).where(eq(siteSettings.key, "payments"));
  const s = await admin.post("/api/v1/admin/league/seasons").send({
    name: "Promo Season",
    year: 2027,
    status: "registration_open",
    registrationOpensAt: new Date(Date.now() - 86400_000).toISOString(),
    registrationClosesAt: "",
    isCurrent: true,
  });
  seasonId = s.body.season.id;
  boysId = (await admin.post(`/api/v1/admin/league/seasons/${seasonId}/divisions`).send({ name: "Promo Boys", genderPolicy: "boys", capacity: 50, priceCents: 10000, status: "open" })).body.division.id;
  girlsId = (await admin.post(`/api/v1/admin/league/seasons/${seasonId}/divisions`).send({ name: "Promo Girls", genderPolicy: "girls", capacity: 50, priceCents: 12000, status: "open" })).body.division.id;
});

afterAll(async () => {
  await db.update(seasons).set({ isCurrent: null }).where(eq(seasons.id, seasonId));
  if (previousCurrent) await db.update(seasons).set({ isCurrent: "current" }).where(eq(seasons.id, previousCurrent));
  await db.update(userRoleAssignments).set({ revokedAt: new Date() }).where(eq(userRoleAssignments.userId, adminId));
  await setFlag("r2.promo_codes", false);
  await setFlag("r1b.registration", false);
});

describe("discount math", () => {
  it("rounds percent off and never goes below zero", () => {
    expect(discountFor({ kind: "percent", value: 15 }, 9999)).toBe(1500);
    expect(discountFor({ kind: "amount", value: 2500 }, 10000)).toBe(2500);
    expect(discountFor({ kind: "amount", value: 50000 }, 10000)).toBe(10000);
  });
});

describe("promo codes", () => {
  it("lets admins create codes, with checks; families can't", async () => {
    expect((await promo({ code: "x" })).status).toBe(400);
    expect((await promo({ code: "BAD", value: 150 })).status).toBe(400);
    const r = await promo({ code: "early20", description: "Early bird" });
    expect(r.status).toBe(201);
    expect(r.body.promo.code).toBe("EARLY20");
    expect((await promo({ code: "Early20" })).status).toBe(409);
    const fam = await family("Nosy");
    expect((await fam.a.post("/api/v1/admin/promo-codes").send({ code: "MINE", kind: "percent", value: 100, appliesTo: "both" })).status).toBe(403);
  });

  it("takes the discount off at checkout (any letter case) and can be removed", async () => {
    const f = await family("Early");
    const reg = await startReg(f.a);
    expect(reg.totalCents).toBe(10000);
    const r = await apply(f.a, reg.id, " early20 ");
    expect(r.status).toBe(200);
    expect(r.body.registration).toMatchObject({ discountCents: 2000, totalCents: 8000, promoCode: "EARLY20" });
    const list = (await f.a.get("/api/v1/registrations")).body.items;
    expect(list[0]).toMatchObject({ promoCode: "EARLY20", discountCents: 2000, totalCents: 8000 });
    const off = await apply(f.a, reg.id, null);
    expect(off.body.registration).toMatchObject({ discountCents: 0, totalCents: 10000, promoCode: null });
    expect((await apply(f.a, reg.id, "NOPE")).body.error.message).toBe("That code isn't valid.");
    // Another family can't touch this registration.
    const other = await family("Other");
    expect((await apply(other.a, reg.id, "EARLY20")).status).toBe(404);
  });

  it("grosses up the card fee on the discounted price when the parent pays it", async () => {
    await admin.put("/api/v1/admin/league/payment-settings").send({ feeMode: "parent", feePercentBps: 290, feeFixedCents: 30, holdMinutes: 15, offerHours: 48 });
    try {
      const f = await family("Gross");
      const reg = await startReg(f.a);
      const r = await apply(f.a, reg.id, "EARLY20");
      expect(r.body.registration.discountCents).toBe(2000);
      expect(r.body.registration.totalCents).toBe(Math.ceil((8000 + 30) / (1 - 0.029)));
    } finally {
      await db.delete(siteSettings).where(eq(siteSettings.key, "payments"));
    }
  });

  it("respects divisions, what it applies to, dates and the on/off switch", async () => {
    await promo({ code: "GIRLSONLY", kind: "amount", value: 3000, seasonId, divisionIds: [girlsId] });
    await promo({ code: "COACHES", kind: "percent", value: 50, appliesTo: "staff" });
    await promo({ code: "LATER", startsAt: new Date(Date.now() + 86400_000).toISOString() });
    await promo({ code: "GONE", endsAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() - 86400_000).toISOString() });
    await promo({ code: "PAUSED", active: false });
    const f = await family("Rules");
    const boy = await startReg(f.a);
    expect((await apply(f.a, boy.id, "GIRLSONLY")).body.error.message).toMatch(/this division/);
    expect((await apply(f.a, boy.id, "COACHES")).body.error.message).toMatch(/coach and team mom fees/);
    expect((await apply(f.a, boy.id, "LATER")).body.error.message).toBe("That code isn't valid."); // not revealed before it starts
    expect((await apply(f.a, boy.id, "GONE")).body.error.message).toMatch(/expired/);
    expect((await apply(f.a, boy.id, "PAUSED")).body.error.message).toBe("That code isn't valid.");
    const girl = await startReg(f.a, { divisionId: girlsId, gender: "girl", first: "Gia" });
    expect((await apply(f.a, girl.id, "GIRLSONLY")).body.registration.totalCents).toBe(9000);

    await setFlag("r2.promo_codes", false);
    expect((await apply(f.a, boy.id, "EARLY20")).body.error.code).toBe("FEATURE_DISABLED");
    await setFlag("r2.promo_codes", true);
  });

  it("limits total uses and uses per family; a cancelled registration frees its use", async () => {
    await promo({ code: "ONEONLY", maxUses: 1 });
    await promo({ code: "SIBLING", kind: "amount", value: 1500, onePerFamily: true });
    const a = await family("First");
    const b = await family("Second");
    const ra = await startReg(a.a);
    const rb = await startReg(b.a);
    expect((await apply(a.a, ra.id, "ONEONLY")).status).toBe(200);
    expect((await apply(b.a, rb.id, "ONEONLY")).body.error.message).toBe("That code has been used up.");
    await a.a.post(`/api/v1/registrations/${ra.id}/cancel`);
    expect((await apply(b.a, rb.id, "ONEONLY")).status).toBe(200);

    const ra2 = await startReg(a.a, { first: "Al" });
    const ra3 = await startReg(a.a, { first: "Bo" });
    expect((await apply(a.a, ra2.id, "SIBLING")).status).toBe(200);
    expect((await apply(a.a, ra3.id, "SIBLING")).body.error.message).toBe("Your family has already used that code.");
    // Re-applying to the same registration is fine.
    expect((await apply(a.a, ra2.id, "SIBLING")).status).toBe(200);

    const listed = (await admin.get("/api/v1/admin/promo-codes")).body.items.find((p: { code: string }) => p.code === "ONEONLY");
    expect(listed.uses).toBe(1);
  });

  it("completes a fully discounted registration without a card", async () => {
    await promo({ code: "SPONSOR100", value: 100 });
    const f = await family("Free");
    const reg = await startReg(f.a);
    expect((await f.a.post(`/api/v1/registrations/${reg.id}/pay`).send({})).status).toBe(400); // still $100
    const r = await apply(f.a, reg.id, "SPONSOR100");
    expect(r.body.registration.totalCents).toBe(0);
    const paid = await f.a.post(`/api/v1/registrations/${reg.id}/pay`).send({});
    expect(paid.status).toBe(200);
    expect(paid.body.registration.status).toBe("paid");
    expect((await apply(f.a, reg.id, null)).status).toBe(409); // can't change after paying
  });

  it("drops a code that ran out while the family's hold lapsed, before charging", async () => {
    await promo({ code: "LASTONE", maxUses: 1 });
    const a = await family("Slow");
    const b = await family("Fast");
    const ra = await startReg(a.a);
    await apply(a.a, ra.id, "LASTONE");
    await db.update(registrations).set({ status: "expired", holdExpiresAt: new Date(Date.now() - 1000) }).where(eq(registrations.id, ra.id));
    const rb = await startReg(b.a);
    expect((await apply(b.a, rb.id, "LASTONE")).status).toBe(200);
    const pay = await a.a.post(`/api/v1/registrations/${ra.id}/pay`).send({ sourceId: "cnon:card-nonce-ok" });
    expect(pay.status).toBe(409);
    expect(pay.body.error.message).toMatch(/LASTONE can't be used any more.*\$100\.00/);
    expect(pay.body.error.registration).toMatchObject({ totalCents: 10000, discountCents: 0, promoCode: null });
    const [after] = await db.select().from(registrations).where(eq(registrations.id, ra.id));
    expect(after).toMatchObject({ promoCodeId: null, discountCents: 0, totalCents: 10000 });
  });

  it("works on coach and team mom fees, including a fee waived in full", async () => {
    await promo({ code: "COACHFREE", value: 100, appliesTo: "both" });
    const v = agent();
    const email = uniqueEmail("promo-coach");
    await signUp(v, email, "Coach Promo");
    const app = await v.post("/api/v1/volunteer/applications").send({ roleKey: "head_coach", phone: "904-555-0111", signerName: "Coach Promo", acceptAgreement: true });
    expect(app.status).toBe(201);
    const id = app.body.application.id;
    expect((await v.put(`/api/v1/volunteer/applications/${id}/promo`).send({ code: "EARLY20" })).body.error.message).toMatch(/not staff fees/);
    const half = await v.put(`/api/v1/volunteer/applications/${id}/promo`).send({ code: "coaches" });
    expect(half.body.application).toMatchObject({ discountCents: 1250, totalCents: 1250, promoCode: "COACHES" });
    const free = await v.put(`/api/v1/volunteer/applications/${id}/promo`).send({ code: "COACHFREE" });
    expect(free.body.application.totalCents).toBe(0);
    const paid = await v.post(`/api/v1/volunteer/applications/${id}/pay`).send({});
    expect(paid.status).toBe(200);
    const [row] = await db.select().from(volunteerApplications).where(eq(volunteerApplications.id, id));
    expect(row!.status).toBe("submitted");
  });

  it("re-checks a held code at payment: paused or edited codes don't slip through, and the shown total must match", async () => {
    const p = (await promo({ code: "LEAKED", value: 100 })).body.promo;
    const f = await family("Leak");
    const reg = await startReg(f.a);
    await apply(f.a, reg.id, "LEAKED");
    // The league pauses the code after it leaked; an unpaid hold can't use it any more.
    await admin.put(`/api/v1/admin/promo-codes/${p.id}`).send({ ...p, active: false });
    const blocked = await f.a.post(`/api/v1/registrations/${reg.id}/pay`).send({ expectedTotalCents: 0 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/LEAKED can't be used any more.*\$100\.00/);
    expect(blocked.body.error.registration).toMatchObject({ totalCents: 10000, promoCode: null });
    const [row] = await db.select().from(registrations).where(eq(registrations.id, reg.id));
    expect(row!.status).toBe("pending_payment");

    // An edited code (typo fixed: 50% → 10%) updates the price instead of honoring the old one.
    const q = (await promo({ code: "TYPO", value: 50 })).body.promo;
    await apply(f.a, reg.id, "TYPO");
    await admin.put(`/api/v1/admin/promo-codes/${q.id}`).send({ ...q, value: 10 });
    const changed = await f.a.post(`/api/v1/registrations/${reg.id}/pay`).send({ sourceId: "cnon:x", expectedTotalCents: 5000 });
    expect(changed.status).toBe(409);
    expect(changed.body.error.message).toMatch(/TYPO was changed by the league.*\$90\.00/);
    expect(changed.body.error.registration).toMatchObject({ totalCents: 9000, discountCents: 1000, promoCode: "TYPO" });

    // A screen showing an old total is never charged a different amount.
    const stale = await f.a.post(`/api/v1/registrations/${reg.id}/pay`).send({ sourceId: "cnon:x", expectedTotalCents: 5000 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toMatch(/\$90\.00/);
  });

  it("re-checks a staff application's code at payment too", async () => {
    const p = (await promo({ code: "STAFFLEAK", value: 100, appliesTo: "staff" })).body.promo;
    const v = agent();
    await signUp(v, uniqueEmail("promo-asst"), "Asst Promo");
    const app = await v.post("/api/v1/volunteer/applications").send({ roleKey: "assistant_coach", phone: "904-555-0111", signerName: "Asst Promo", acceptAgreement: true });
    const id = app.body.application.id;
    await v.put(`/api/v1/volunteer/applications/${id}/promo`).send({ code: "STAFFLEAK" });
    await admin.put(`/api/v1/admin/promo-codes/${p.id}`).send({ ...p, active: false });
    const blocked = await v.post(`/api/v1/volunteer/applications/${id}/pay`).send({ expectedTotalCents: 0 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.application).toMatchObject({ totalCents: 2500, promoCode: null });
    const [row] = await db.select().from(volunteerApplications).where(eq(volunteerApplications.id, id));
    expect(row!.status).toBe("pending_payment");
  });
});
