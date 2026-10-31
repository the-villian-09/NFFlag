import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import {
  auditLogs,
  divisions,
  householdMembers,
  households,
  playerMedical,
  players,
  registrations,
  rosterEntries,
  seasons,
  user,
  userRoleAssignments,
  volunteerApplications,
} from "../src/db/schema/index.js";
import { clearSubscribers, processOutbox } from "../src/modules/platform/outbox.js";
import { registerSubscribers } from "../src/modules/subscribers.js";
import { buildSlots } from "../src/modules/teams/service.js";
import { agent, mail, signUp, uniqueEmail, type Agent } from "./helpers.js";

let admin: Agent;
let adminId: string;
let seasonId: string;
let divisionId: string;
let previousCurrent: string | null = null;

async function person(prefix: string) {
  const a = agent();
  const email = uniqueEmail(prefix.toLowerCase());
  await signUp(a, email, `${prefix} Person`);
  const [u] = await db.select().from(user).where(eq(user.email, email));
  return { a, email, userId: u!.id };
}

/** A family with one approved registration in the test division. */
async function family(prefix: string, userId?: string) {
  const owner = userId ? { userId, email: "" } : await person(prefix);
  const [h] = await db.insert(households).values({ displayName: `The ${prefix} Family`, phone: "904-555-0100" }).returning();
  await db.insert(householdMembers).values({ householdId: h!.id, userId: owner.userId });
  const [p] = await db.insert(players).values({ householdId: h!.id, firstName: prefix, lastName: "Kid", birthDate: "2017-03-03", gender: "boy" }).returning();
  await db.insert(playerMedical).values({ playerId: p!.id, allergies: `${prefix} allergy`, emergencyContactName: "Nana", emergencyContactPhone: "904-555-0199" });
  const [r] = await db
    .insert(registrations)
    .values({ seasonId, divisionId, playerId: p!.id, householdId: h!.id, status: "approved", priceCents: 10000, totalCents: 10000, paidAt: new Date() })
    .returning();
  return { ...owner, playerId: p!.id, registrationId: r!.id };
}

async function approvedStaff(prefix: string, roleKey: "head_coach" | "assistant_coach" | "team_manager") {
  const p = await person(prefix);
  await db.insert(volunteerApplications).values({ seasonId, userId: p.userId, roleKey, phone: "904-555-0111", status: "approved", screeningStatus: "cleared" });
  return p;
}

const drainAll = async () => {
  for (;;) {
    const r = await processOutbox(200);
    if (r.processed + r.failed === 0) return;
  }
};

beforeAll(async () => {
  clearSubscribers();
  registerSubscribers();
  const a = await person("teams-admin");
  admin = a.a;
  adminId = a.userId;
  await db.insert(userRoleAssignments).values({ userId: adminId, roleKey: "super_admin" });
  const [cur] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.isCurrent, "current"));
  previousCurrent = cur?.id ?? null;
  const [s] = await db.insert(seasons).values({ name: "Draft Season", year: 2027 }).returning();
  seasonId = s!.id;
  const [d] = await db.insert(divisions).values({ seasonId, name: "Draft 8U", capacity: 40, priceCents: 10000, status: "open" }).returning();
  divisionId = d!.id;
});

afterAll(async () => {
  await drainAll();
  clearSubscribers();
  await db.update(userRoleAssignments).set({ revokedAt: new Date() }).where(eq(userRoleAssignments.userId, adminId));
  if (previousCurrent) await db.update(seasons).set({ isCurrent: "current" }).where(eq(seasons.id, previousCurrent));
});

describe("snake order", () => {
  it("snakes and fills coaches' children into their team's first rounds", () => {
    const slots = buildSlots(["A", "B", "C"], 3, new Map([["A", 1], ["C", 2]]), new Map());
    expect(slots.map((s) => `${s.pick}${s.teamId}${s.kind ? "*" : ""}`)).toEqual([
      "1A*", "2B", "3C*", // round 1
      "4C*", "5B", "6A", // round 2 (reversed)
      "7A", "8B", "9C", // round 3
    ]);
  });
});

describe("teams and the draft", () => {
  let coach1: Awaited<ReturnType<typeof approvedStaff>>;
  let coach2: Awaited<ReturnType<typeof approvedStaff>>;
  let assistant: Awaited<ReturnType<typeof approvedStaff>>;
  let teamIds: string[] = [];
  let coachKid: Awaited<ReturnType<typeof family>>;
  const families: Awaited<ReturnType<typeof family>>[] = [];

  it("creates teams, assigns approved staff, and places a coach's own child", async () => {
    coach1 = await approvedStaff("coachone", "head_coach");
    coach2 = await approvedStaff("coachtwo", "head_coach");
    assistant = await approvedStaff("assist", "assistant_coach");
    coachKid = await family("Junior", coach1.userId);
    for (const n of ["Ava", "Ben", "Cal", "Dee", "Eli"]) families.push(await family(n));

    for (const name of ["Lightning", "Thunder", "Storm"]) {
      const r = await admin.post(`/api/v1/admin/teams/divisions/${divisionId}/teams`).send({ name });
      expect(r.status).toBe(201);
      teamIds.push(r.body.team.id);
    }
    expect((await admin.post(`/api/v1/admin/teams/divisions/${divisionId}/teams`).send({ name: "Storm" })).status).toBe(409);

    const stranger = await person("stranger");
    expect((await admin.post(`/api/v1/admin/teams/teams/${teamIds[0]}/staff`).send({ userId: stranger.userId, roleKey: "head_coach" })).status).toBe(409);

    const a1 = await admin.post(`/api/v1/admin/teams/teams/${teamIds[0]}/staff`).send({ userId: coach1.userId, roleKey: "head_coach" });
    expect(a1.body.childrenPlaced).toBe(1);
    expect((await admin.post(`/api/v1/admin/teams/teams/${teamIds[0]}/staff`).send({ userId: coach2.userId, roleKey: "head_coach" })).status).toBe(409);
    await admin.post(`/api/v1/admin/teams/teams/${teamIds[1]}/staff`).send({ userId: coach2.userId, roleKey: "head_coach" });
    await admin.post(`/api/v1/admin/teams/teams/${teamIds[0]}/staff`).send({ userId: assistant.userId, roleKey: "assistant_coach" });

    const overview = await admin.get(`/api/v1/admin/teams/seasons/${seasonId}`);
    const div = overview.body.items[0];
    expect(div.teams.map((t: { players: number }) => t.players)).toEqual([1, 0, 0]);
    expect(div.available).toBe(5);
    expect(overview.body.staffPool.find((s: { userId: string }) => s.userId === coach1.userId).assignments[0].teamName).toBe("Lightning");
    expect((await coach1.a.get(`/api/v1/admin/teams/seasons/${seasonId}`)).status).toBe(403);
  });

  it("runs the draft: order, picks in snake order, a stale-screen guard, and undo", async () => {
    expect((await admin.put(`/api/v1/admin/teams/divisions/${divisionId}/draft/order`).send({ order: [teamIds[0]] })).status).toBe(400);
    await admin.put(`/api/v1/admin/teams/divisions/${divisionId}/draft/order`).send({ order: teamIds });
    let board = (await admin.post(`/api/v1/admin/teams/divisions/${divisionId}/draft/start`)).body;
    expect(board.draft.status).toBe("live");
    // Pick 1 belongs to Lightning but is its coach's child, so Thunder is on the clock.
    expect(board.current).toMatchObject({ pick: 2, teamId: teamIds[1] });

    const stale = await admin.post(`/api/v1/admin/teams/divisions/${divisionId}/draft/pick`).send({ registrationId: families[0]!.registrationId, expectedPick: 1 });
    expect(stale.status).toBe(409);

    const order: string[] = [];
    for (const f of families) {
      const cur = board.current;
      order.push(cur.teamId);
      board = (await admin.post(`/api/v1/admin/teams/divisions/${divisionId}/draft/pick`).send({ registrationId: f.registrationId, expectedPick: cur.pick })).body;
    }
    // Thunder, Storm | Storm, Thunder, Lightning (snake) ...
    expect(order.slice(0, 5)).toEqual([teamIds[1], teamIds[2], teamIds[2], teamIds[1], teamIds[0]]);
    expect(board.current).toBeNull();
    expect((await admin.post(`/api/v1/admin/teams/divisions/${divisionId}/draft/pick`).send({ registrationId: families[0]!.registrationId })).status).toBe(409);

    board = (await admin.post(`/api/v1/admin/teams/divisions/${divisionId}/draft/undo`)).body;
    expect(board.available).toHaveLength(1);
    board = (await admin.post(`/api/v1/admin/teams/divisions/${divisionId}/draft/pick`).send({ registrationId: families[4]!.registrationId })).body;
    expect(board.available).toHaveLength(0);
  });

  it("publishes rosters: coaches see only their team, head coach sees medical (audited), families are emailed", async () => {
    expect((await admin.post(`/api/v1/admin/teams/divisions/${divisionId}/draft/publish`)).status).toBe(409);
    await admin.post(`/api/v1/admin/teams/divisions/${divisionId}/draft/complete`);
    const before = (await coach1.a.get("/api/v1/my-teams")).body.items;
    expect(before.map((t: { name: string; published: boolean }) => [t.name, t.published])).toEqual([["Lightning", false]]);
    expect((await coach1.a.get(`/api/v1/my-teams/${teamIds[0]}`)).status).toBe(403);

    const pub = await admin.post(`/api/v1/admin/teams/divisions/${divisionId}/draft/publish`);
    expect(pub.body.draft.publishedAt).toBeTruthy();

    const mine = await coach1.a.get("/api/v1/my-teams");
    expect(mine.body.items.map((t: { name: string; published: boolean }) => [t.name, t.published])).toEqual([["Lightning", true]]);
    const team = await coach1.a.get(`/api/v1/my-teams/${teamIds[0]}`);
    expect(team.status).toBe(200);
    expect(team.body.canSeeMedical).toBe(true);
    const junior = team.body.roster.find((r: { firstName: string }) => r.firstName === "Junior");
    expect(junior.medical.allergies).toBe("Junior allergy");
    expect(junior.guardians[0].email).toBe(coach1.email);
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "medical.view"), eq(auditLogs.targetId, teamIds[0]!)));
    expect(audit.length).toBeGreaterThan(0);

    // Assistant: roster, no medical. Other team's coach: no access.
    const asst = await assistant.a.get(`/api/v1/my-teams/${teamIds[0]}`);
    expect(asst.body.canSeeMedical).toBe(false);
    expect(asst.body.roster[0].medical).toBeNull();
    expect((await coach2.a.get(`/api/v1/my-teams/${teamIds[0]}`)).status).toBe(403);

    // A family sees the team and the head coach; they got an email.
    const f = families[0]!;
    const regs = await (f as unknown as { a: Agent }).a.get("/api/v1/registrations");
    expect(regs.body.items[0].team).toEqual({ name: "Thunder", coach: { name: "coachtwo Person", email: coach2.email } });
    await drainAll();
    const msg = mail.last(f.email, "roster.published")!;
    expect(msg.subject).toMatch(/Ava Kid's team/);
    expect(msg.text).toContain("coachtwo Person");
  });

  it("moves a player after the draft, and a rejected registration leaves the team", async () => {
    const [entry] = await db.select().from(rosterEntries).where(eq(rosterEntries.registrationId, families[1]!.registrationId));
    const mv = await admin.post(`/api/v1/admin/teams/roster/${entry!.id}/move`).send({ teamId: teamIds[2] });
    expect(mv.body.entry.teamId).toBe(teamIds[2]);
    await db.update(registrations).set({ status: "paid" }).where(eq(registrations.id, families[1]!.registrationId));
    await admin.post(`/api/v1/admin/league/registrations/${families[1]!.registrationId}/decision`).send({ decision: "rejected", reason: "Wrong age", refund: false });
    expect(await db.select().from(rosterEntries).where(eq(rosterEntries.registrationId, families[1]!.registrationId))).toHaveLength(0);
  });
});
