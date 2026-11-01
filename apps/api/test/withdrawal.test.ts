import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { divisions, featureFlags, householdMembers, households, players, registrations, seasons, siteSettings, user, userRoleAssignments, withdrawalRequests } from "../src/db/schema/index.js";
import { resetFlagCache } from "../src/modules/platform/flags.js";
import { clearSubscribers, processOutbox } from "../src/modules/platform/outbox.js";
import { registerSubscribers } from "../src/modules/subscribers.js";
import { agent, mail, signUp, uniqueEmail, type Agent } from "./helpers.js";

let admin: Agent;
let adminId: string;
let seasonId: string;
let divisionId: string;
const INBOX = "league-inbox@example.com";
let previousContact: unknown = null;

const drain = async () => {
  for (;;) {
    const r = await processOutbox(200);
    if (r.processed + r.failed === 0) return;
  }
};

/** A family with one paid registration. */
async function paidFamily(name: string) {
  const a = agent();
  const email = uniqueEmail(name.toLowerCase());
  await signUp(a, email, `${name} Parent`);
  const [u] = await db.select().from(user).where(eq(user.email, email));
  const [h] = await db.insert(households).values({ displayName: `The ${name} Family` }).returning();
  await db.insert(householdMembers).values({ householdId: h!.id, userId: u!.id });
  const [p] = await db.insert(players).values({ householdId: h!.id, firstName: name, lastName: "Kid", birthDate: "2017-02-02", gender: "boy" }).returning();
  const [r] = await db
    .insert(registrations)
    .values({ seasonId, divisionId, playerId: p!.id, householdId: h!.id, status: "paid", priceCents: 10000, totalCents: 10000, paidAt: new Date() })
    .returning();
  return { a, email, registrationId: r!.id };
}

beforeAll(async () => {
  clearSubscribers();
  registerSubscribers();
  const email = uniqueEmail("wd-admin");
  admin = agent();
  await signUp(admin, email, "Withdraw Admin");
  const [u] = await db.select().from(user).where(eq(user.email, email));
  adminId = u!.id;
  await db.insert(userRoleAssignments).values({ userId: adminId, roleKey: "super_admin" });
  await db.insert(featureFlags).values({ key: "r1b.registration", enabled: true }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true } });
  resetFlagCache();
  const [s] = await db.insert(seasons).values({ name: "Withdraw Season", year: 2027 }).returning();
  seasonId = s!.id;
  const [d] = await db.insert(divisions).values({ seasonId, name: "Withdraw 8U", capacity: 20, priceCents: 10000, status: "open" }).returning();
  divisionId = d!.id;
  const [c] = await db.select().from(siteSettings).where(eq(siteSettings.key, "contact"));
  previousContact = c?.value ?? null;
  await db.insert(siteSettings).values({ key: "contact", value: { inboxEmail: INBOX } }).onConflictDoUpdate({ target: siteSettings.key, set: { value: { inboxEmail: INBOX } } });
});

afterAll(async () => {
  await drain();
  clearSubscribers();
  if (previousContact) await db.update(siteSettings).set({ value: previousContact }).where(eq(siteSettings.key, "contact"));
  else await db.delete(siteSettings).where(eq(siteSettings.key, "contact"));
  await db.update(userRoleAssignments).set({ revokedAt: new Date() }).where(eq(userRoleAssignments.userId, adminId));
});

describe("withdrawal requests", () => {
  it("lets a family ask to withdraw a paid registration; the league and family are emailed", async () => {
    const f = await paidFamily("Leaving");
    const r = await f.a.post(`/api/v1/registrations/${f.registrationId}/withdrawal`).send({ reason: "Moving to Orlando" });
    expect(r.status).toBe(201);
    expect((await f.a.post(`/api/v1/registrations/${f.registrationId}/withdrawal`).send({})).status).toBe(409);
    const list = (await f.a.get("/api/v1/registrations")).body.items;
    expect(list[0].withdrawal.status).toBe("open");
    // Another family can't request for this registration.
    const other = await paidFamily("Other");
    expect((await other.a.post(`/api/v1/registrations/${f.registrationId}/withdrawal`).send({})).status).toBe(404);

    await drain();
    const toLeague = mail.last(INBOX, "withdrawal.requested_league")!;
    expect(toLeague.subject).toMatch(/Leaving Kid/);
    expect(toLeague.text).toContain("Moving to Orlando");
    expect(toLeague.text).toContain(`/admin/registrations/${f.registrationId}`);
    expect(mail.last(f.email, "withdrawal.requested_family")).toBeTruthy();

    // Admin sees it in the filtered list and the count.
    const open = (await admin.get(`/api/v1/admin/league/registrations?seasonId=${seasonId}&withdrawal=open`)).body;
    expect(open.items.map((x: { id: string }) => x.id)).toEqual([f.registrationId]);
    expect((await admin.get("/api/v1/admin/league/withdrawals/count")).body.open).toBeGreaterThanOrEqual(1);
    const detail = (await admin.get(`/api/v1/admin/league/registrations/${f.registrationId}`)).body;
    expect(detail.withdrawal).toMatchObject({ status: "open", reason: "Moving to Orlando" });
  });

  it("lets the family take a request back", async () => {
    const f = await paidFamily("Stayer");
    await f.a.post(`/api/v1/registrations/${f.registrationId}/withdrawal`).send({});
    expect((await f.a.delete(`/api/v1/registrations/${f.registrationId}/withdrawal`)).status).toBe(200);
    expect((await f.a.delete(`/api/v1/registrations/${f.registrationId}/withdrawal`)).status).toBe(409);
    // ...and ask again later.
    expect((await f.a.post(`/api/v1/registrations/${f.registrationId}/withdrawal`).send({})).status).toBe(201);
  });

  it("closes the request when the league cancels, and emails the family", async () => {
    const f = await paidFamily("Cancelme");
    await f.a.post(`/api/v1/registrations/${f.registrationId}/withdrawal`).send({});
    const c = await admin.post(`/api/v1/admin/league/registrations/${f.registrationId}/cancel`).send({ reason: "Family asked to withdraw", refund: false });
    expect(c.status).toBe(200);
    const [w] = await db.select().from(withdrawalRequests).where(eq(withdrawalRequests.registrationId, f.registrationId));
    expect(w!.status).toBe("completed");
    await drain();
    expect(mail.last(f.email, "registration.cancelled")!.subject).toMatch(/Cancelme Kid's registration is cancelled/);
  });

  it("lets the league decline with a note the family receives", async () => {
    const f = await paidFamily("Declined");
    await f.a.post(`/api/v1/registrations/${f.registrationId}/withdrawal`).send({ reason: "Changed mind" });
    expect((await admin.post(`/api/v1/admin/league/registrations/${f.registrationId}/withdrawal/decline`).send({ note: "x" })).status).toBe(400);
    const d = await admin.post(`/api/v1/admin/league/registrations/${f.registrationId}/withdrawal/decline`).send({ note: "Rosters are final after the draft; no refunds." });
    expect(d.body.withdrawal.status).toBe("declined");
    await drain();
    expect(mail.last(f.email, "withdrawal.declined")!.text).toContain("Rosters are final after the draft");
    const [row] = await db.select().from(registrations).where(eq(registrations.id, f.registrationId));
    expect(row!.status).toBe("paid");
  });

  it("refuses unpaid registrations (the family can cancel those themselves)", async () => {
    const f = await paidFamily("Unpaid");
    await db.update(registrations).set({ status: "pending_payment", paidAt: null }).where(eq(registrations.id, f.registrationId));
    const r = await f.a.post(`/api/v1/registrations/${f.registrationId}/withdrawal`).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/cancel it yourself/);
  });
});
