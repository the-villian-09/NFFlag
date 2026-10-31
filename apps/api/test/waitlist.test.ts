import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/client.js";
import { featureFlags, seasons, user, userRoleAssignments, waitlistEntries } from "../src/db/schema/index.js";
import { resetFlagCache } from "../src/modules/platform/flags.js";
import { clearSubscribers, processOutbox } from "../src/modules/platform/outbox.js";
import { processWaitlist } from "../src/modules/registration/waitlist.js";
import { registerSubscribers } from "../src/modules/subscribers.js";
import { agent, mail, signUp, uniqueEmail, type Agent } from "./helpers.js";

// Square: every card charge succeeds; refunds are accepted.
let seq = 0;
const realFetch = globalThis.fetch;
beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.host.includes("squareup")) return realFetch(input, init);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v2/refunds") return json({ refund: { id: `wl_ref_${++seq}`, status: "PENDING" } });
    return json({ payment: { id: `wl_pay_${++seq}`, status: "COMPLETED", reference_id: body.reference_id, amount_money: body.amount_money } });
  });
  clearSubscribers();
  registerSubscribers();
});

const accept = { signerName: "Pat Parent", acceptedWaivers: ["waiver-liability", "waiver-medical", "waiver-media"] };
let admin: Agent;
let adminId: string;
let divisionId: string;
let seasonId: string;
let previousCurrent: string | null = null;

async function drain() {
  for (;;) {
    const r = await processOutbox(200);
    if (r.processed + r.failed === 0) return;
  }
}

async function family(name: string) {
  const a = agent();
  const email = uniqueEmail(name.toLowerCase());
  await signUp(a, email);
  await a.post("/api/v1/households").send({ displayName: `The ${name} Family` });
  const p = await a.post("/api/v1/players").send({
    firstName: name,
    lastName: "Kid",
    birthDate: "2017-05-05",
    gender: "boy",
    medical: { emergencyContactName: "Grandma", emergencyContactPhone: "904-555-0199" },
  });
  return { a, email, playerId: p.body.player.id as string };
}

beforeAll(async () => {
  const email = uniqueEmail("wl-admin");
  admin = agent();
  await signUp(admin, email, "Wendy Admin");
  const [u] = await db.select().from(user).where(eq(user.email, email));
  adminId = u!.id;
  await db.insert(userRoleAssignments).values({ userId: adminId, roleKey: "super_admin" });
  const [cur] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.isCurrent, "current"));
  previousCurrent = cur?.id ?? null;
  const s = await admin.post("/api/v1/admin/league/seasons").send({
    name: "Waitlist Season",
    year: 2027,
    status: "registration_open",
    registrationOpensAt: new Date(Date.now() - 86400_000).toISOString(),
    registrationClosesAt: "",
    ageCutoffDate: "",
    isCurrent: true,
  });
  seasonId = s.body.season.id;
  const d = await admin.post(`/api/v1/admin/league/seasons/${seasonId}/divisions`).send({ name: "Tiny 9U", genderPolicy: "coed", capacity: 1, priceCents: 10000, status: "open" });
  divisionId = d.body.division.id;
  await admin.put("/api/v1/admin/flags/r1b.registration").send({ enabled: true });
  await admin.put("/api/v1/admin/flags/r2.waitlist_offers").send({ enabled: false });
  resetFlagCache();
});

afterAll(async () => {
  await drain();
  clearSubscribers();
  vi.restoreAllMocks();
  await db.update(seasons).set({ isCurrent: null });
  if (previousCurrent) await db.update(seasons).set({ isCurrent: "current" }).where(eq(seasons.id, previousCurrent));
  await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, "r2.waitlist_offers"));
  await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, "r1b.registration"));
  await db.update(userRoleAssignments).set({ revokedAt: new Date() }).where(eq(userRoleAssignments.userId, adminId));
  resetFlagCache();
});

describe("waitlist", () => {
  it("fills, queues, offers the freed spot to the first family, and lets them claim and pay", async () => {
    // A takes the only spot.
    const A = await family("Alpha");
    const ra = await A.a.post("/api/v1/registrations").send({ playerId: A.playerId, divisionId, ...accept });
    await A.a.post(`/api/v1/registrations/${ra.body.registration.id}/pay`).send({ sourceId: "cnon:ok" });

    // B finds it full; the waitlist is off until the release switch is on.
    const B = await family("Bravo");
    const full = await B.a.post("/api/v1/registrations").send({ playerId: B.playerId, divisionId, ...accept });
    expect(full.body.error.code).toBe("DIVISION_FULL");
    expect((await B.a.post("/api/v1/waitlist").send({ playerId: B.playerId, divisionId })).status).toBe(403);
    await admin.put("/api/v1/admin/flags/r2.waitlist_offers").send({ enabled: true });
    resetFlagCache();

    const opts = await B.a.get("/api/v1/registration/options");
    expect(opts.body.waitlist).toBe(true);
    expect(opts.body.divisions.find((d: { id: string }) => d.id === divisionId).full).toBe(true);

    const jb = await B.a.post("/api/v1/waitlist").send({ playerId: B.playerId, divisionId });
    expect(jb.status).toBe(201);
    expect(jb.body.position).toBe(1);
    expect((await B.a.post("/api/v1/waitlist").send({ playerId: B.playerId, divisionId })).status).toBe(409);
    const C = await family("Charlie");
    expect((await C.a.post("/api/v1/waitlist").send({ playerId: C.playerId, divisionId })).body.position).toBe(2);
    await drain();
    expect(mail.last(B.email, "waitlist.joined")?.text).toContain("#1");

    // A drops out (admin cancels with refund): the spot goes to B, not to a walk-in.
    await admin.post(`/api/v1/admin/league/registrations/${ra.body.registration.id}/cancel`).send({ reason: "Moved away", refund: true });
    const D = await family("Delta");
    expect((await D.a.post("/api/v1/registrations").send({ playerId: D.playerId, divisionId, ...accept })).body.error.code).toBe("DIVISION_FULL");
    const r1 = await processWaitlist();
    expect(r1.offered).toBe(1);
    expect((await processWaitlist()).offered).toBe(0); // held for B, nothing more to offer
    await drain();
    const offerMail = mail.last(B.email, "waitlist.offered")!;
    const claimUrl = offerMail.text.match(/https?:\/\/\S+register\?offer=[\w-]+/)![0];
    expect(offerMail.html).toContain("Claim the spot");
    const entryId = new URL(claimUrl).searchParams.get("offer")!;

    // Someone else can't claim B's offer.
    expect((await C.a.post(`/api/v1/waitlist/${entryId}/accept`).send(accept)).status).toBe(404);

    const claim = await B.a.post(`/api/v1/waitlist/${entryId}/accept`).send(accept);
    expect(claim.status).toBe(201);
    const regB = claim.body.registration;
    expect(regB.status).toBe("pending_payment");
    expect(new Date(regB.holdExpiresAt).getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);
    const pay = await B.a.post(`/api/v1/registrations/${regB.id}/pay`).send({ sourceId: "cnon:ok" });
    expect(pay.body.registration.status).toBe("paid");
    const [entry] = await db.select().from(waitlistEntries).where(eq(waitlistEntries.id, entryId));
    expect(entry).toMatchObject({ status: "accepted", registrationId: regB.id });

    // Capacity goes up: C gets an offer, lets it lapse, and it expires with an email.
    const div = (await admin.get("/api/v1/admin/league/seasons")).body.items.flatMap((s: { divisions: unknown[] }) => s.divisions).find((x: { id: string }) => x.id === divisionId);
    await admin.put(`/api/v1/admin/league/divisions/${divisionId}`).send({ ...div, capacity: 3, birthDateFrom: "", birthDateTo: "", eligibilityNotes: "" });
    expect((await processWaitlist()).offered).toBe(1);
    await db.update(waitlistEntries).set({ offerExpiresAt: new Date(Date.now() - 1000) }).where(eq(waitlistEntries.playerId, C.playerId));
    expect(await (async () => (await processWaitlist()).expired)()).toBe(1);
    await drain();
    expect(mail.last(C.email, "waitlist.offer_expired")).toBeTruthy();
    const expiredClaim = await C.a.post(`/api/v1/waitlist/${(await C.a.get("/api/v1/waitlist")).body.items[0].id}/accept`).send(accept);
    expect(expiredClaim.status).toBe(409);

    // Nobody waiting any more, so D can register directly.
    expect((await D.a.post("/api/v1/registrations").send({ playerId: D.playerId, divisionId, ...accept })).status).toBe(201);
  });

  it("admins see the list and can remove a family; families can leave", async () => {
    // Fill the division again so new families have to wait.
    await db.update(waitlistEntries).set({ status: "removed" }).where(eq(waitlistEntries.divisionId, divisionId));
    const E = await family("Echo");
    const F = await family("Foxtrot");
    const d = (await admin.get("/api/v1/admin/league/seasons")).body.items.flatMap((s: { divisions: unknown[] }) => s.divisions).find((x: { id: string }) => x.id === divisionId);
    await admin.put(`/api/v1/admin/league/divisions/${divisionId}`).send({ ...d, status: "full", birthDateFrom: "", birthDateTo: "", eligibilityNotes: "" });
    const je = await E.a.post("/api/v1/waitlist").send({ playerId: E.playerId, divisionId });
    const jf = await F.a.post("/api/v1/waitlist").send({ playerId: F.playerId, divisionId });
    expect(je.status).toBe(201);
    const list = await admin.get(`/api/v1/admin/league/waitlist?seasonId=${seasonId}`);
    expect(list.body.items.map((i: { playerFirstName: string; position: number }) => [i.playerFirstName, i.position])).toEqual([
      ["Echo", 1],
      ["Foxtrot", 2],
    ]);
    expect((await admin.post(`/api/v1/admin/league/waitlist/${je.body.entry.id}/remove`).send({ reason: "Duplicate" })).status).toBe(200);
    expect((await F.a.get("/api/v1/waitlist")).body.items[0].position).toBe(1);
    expect((await F.a.post(`/api/v1/waitlist/${jf.body.entry.id}/leave`).send({})).status).toBe(200);
    expect((await F.a.get("/api/v1/waitlist")).body.items).toHaveLength(0);
    expect((await E.a.get("/api/v1/admin/league/waitlist")).status).toBe(403);
  });
});
