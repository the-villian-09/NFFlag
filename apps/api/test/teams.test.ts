import { and, eq, isNull } from "drizzle-orm";
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
import { featureFlags } from "../src/db/schema/index.js";
import { resetFlagCache } from "../src/modules/platform/flags.js";

const RELEASE_FLAGS = ["r3.teams_draft", "r3.practices", "r4.games", "r4.announcements"];
async function setFlags(on: boolean, keys = RELEASE_FLAGS) {
  for (const key of keys) {
    await db.insert(featureFlags).values({ key, enabled: on }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: on } });
  }
  resetFlagCache();
}
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
  await setFlags(true);
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

  it("a coach's team access ends when the season is completed (audit M3)", async () => {
    expect((await coach1.a.get(`/api/v1/my-teams/${teamIds[0]}`)).status).toBe(200);
    await db.update(seasons).set({ status: "completed" }).where(eq(seasons.id, seasonId));
    expect((await coach1.a.get(`/api/v1/my-teams/${teamIds[0]}`)).status).toBe(403);
    await db.update(seasons).set({ status: "planning" }).where(eq(seasons.id, seasonId));
    expect((await coach1.a.get(`/api/v1/my-teams/${teamIds[0]}`)).status).toBe(200);
  });

  it("moves a player after the draft, and a rejected registration leaves the team", async () => {
    const [entry] = await db.select().from(rosterEntries).where(eq(rosterEntries.registrationId, families[1]!.registrationId));
    const mv = await admin.post(`/api/v1/admin/teams/roster/${entry!.id}/move`).send({ teamId: teamIds[2] });
    expect(mv.body.entry.teamId).toBe(teamIds[2]);
    await db.update(registrations).set({ status: "paid" }).where(eq(registrations.id, families[1]!.registrationId));
    await admin.post(`/api/v1/admin/league/registrations/${families[1]!.registrationId}/decision`).send({ decision: "rejected", reason: "Wrong age", refund: false });
    expect(await db.select().from(rosterEntries).where(eq(rosterEntries.registrationId, families[1]!.registrationId))).toHaveLength(0);
  });

  it("lets an admin take a player off a team after the draft, and the registration shows the team until then", async () => {
    const reg = families[2]!.registrationId;
    const detail = await admin.get(`/api/v1/admin/league/registrations/${reg}`);
    expect(detail.body.team.name).toBeTruthy();
    expect((await coach1.a.delete(`/api/v1/admin/teams/roster/${detail.body.team.entryId}`)).status).toBe(403);
    expect((await admin.delete(`/api/v1/admin/teams/roster/${detail.body.team.entryId}`)).status).toBe(200);
    expect((await admin.get(`/api/v1/admin/league/registrations/${reg}`)).body.team).toBeNull();
    const board = (await admin.get(`/api/v1/admin/teams/divisions/${divisionId}/draft`)).body;
    expect(board.available.some((a: { registrationId: string }) => a.registrationId === reg)).toBe(true);
  });
});

describe("draft-night safeguards and staff access (review fixes)", () => {
  let div2: string;
  let t1: string;
  let t2: string;
  const fams: Awaited<ReturnType<typeof family>>[] = [];
  const draftUrl = () => `/api/v1/admin/teams/divisions/${div2}/draft`;
  const activeTeamGrants = (userId: string, teamId: string) =>
    db
      .select({ roleKey: userRoleAssignments.roleKey })
      .from(userRoleAssignments)
      .where(and(eq(userRoleAssignments.userId, userId), eq(userRoleAssignments.scopeId, teamId), isNull(userRoleAssignments.revokedAt)));

  it("places a coach's child approved after the coach was assigned, when the draft starts", async () => {
    const [d] = await db.insert(divisions).values({ seasonId, name: "Fix 10U", capacity: 40, priceCents: 10000, status: "open" }).returning();
    div2 = d!.id;
    const prev = divisionId;
    divisionId = div2; // family() registers into divisionId
    t1 = (await admin.post(`/api/v1/admin/teams/divisions/${div2}/teams`).send({ name: "Comets" })).body.team.id;
    t2 = (await admin.post(`/api/v1/admin/teams/divisions/${div2}/teams`).send({ name: "Rockets" })).body.team.id;
    const coach = await approvedStaff("latecoach", "head_coach");
    expect((await admin.post(`/api/v1/admin/teams/teams/${t1}/staff`).send({ userId: coach.userId, roleKey: "head_coach" })).body.childrenPlaced).toBe(0);
    await family("Latekid", coach.userId); // approved after assignment
    for (const n of ["Fa", "Fb", "Fc", "Fd"]) fams.push(await family(n));
    divisionId = prev;

    await admin.put(`${draftUrl()}/order`).send({ order: [t1, t2] });
    const board = (await admin.post(`${draftUrl()}/start`)).body;
    expect(board.roster.find((r: { firstName: string }) => r.firstName === "Latekid")).toMatchObject({ teamId: t1, source: "coach_child" });
    expect(board.current).toMatchObject({ pick: 2, teamId: t2 });
  });

  it("locks teams and roster adds during the draft", async () => {
    expect((await admin.post(`/api/v1/admin/teams/divisions/${div2}/teams`).send({ name: "Late Team" })).status).toBe(409);
    expect((await admin.post(`/api/v1/admin/teams/teams/${t1}/roster`).send({ registrationId: fams[0]!.registrationId })).status).toBe(409);
  });

  it("keeps the clock moving forward when a drafted child is cancelled, and undo is guarded", async () => {
    let board = (await admin.get(draftUrl())).body;
    for (const f of fams.slice(0, 3)) {
      board = (await admin.post(`${draftUrl()}/pick`).send({ registrationId: f.registrationId, expectedPick: board.current.pick })).body;
    }
    expect(board.current.pick).toBe(5);
    // Pick 2's registration is cancelled mid-draft (what cancelRegistration does to the roster).
    await db.update(registrations).set({ status: "cancelled" }).where(eq(registrations.id, fams[0]!.registrationId));
    await db.delete(rosterEntries).where(eq(rosterEntries.registrationId, fams[0]!.registrationId));
    board = (await admin.get(draftUrl())).body;
    expect(board.current.pick).toBe(5);
    expect(board.holes).toBe(1);
    expect((await admin.post(`${draftUrl()}/undo`).send({ expectedPick: 3 })).status).toBe(409);
    board = (await admin.post(`${draftUrl()}/undo`).send({ expectedPick: 4 })).body;
    expect(board.current.pick).toBe(4);
    expect(board.available.map((a: { firstName: string }) => a.firstName).sort()).toEqual(["Fc", "Fd"]);
  });

  it("swaps a re-assigned coach's team role and removes it entirely when they leave", async () => {
    const p = await approvedStaff("swapper", "head_coach");
    await db.insert(volunteerApplications).values({ seasonId, userId: p.userId, roleKey: "assistant_coach", phone: "904-555-0112", status: "approved", screeningStatus: "cleared" });
    await admin.post(`/api/v1/admin/teams/teams/${t2}/staff`).send({ userId: p.userId, roleKey: "head_coach" });
    await admin.post(`/api/v1/admin/teams/teams/${t2}/staff`).send({ userId: p.userId, roleKey: "assistant_coach" });
    expect((await activeTeamGrants(p.userId, t2)).map((g) => g.roleKey)).toEqual(["assistant_coach"]);
    await admin.delete(`/api/v1/admin/teams/teams/${t2}/staff/${p.userId}`);
    expect(await activeTeamGrants(p.userId, t2)).toHaveLength(0);
  });

  it("allows only one head coach per team, even with simultaneous requests", async () => {
    const a = await approvedStaff("racea", "head_coach");
    const b = await approvedStaff("raceb", "head_coach");
    const rs = await Promise.all([a, b].map((x) => admin.post(`/api/v1/admin/teams/teams/${t2}/staff`).send({ userId: x.userId, roleKey: "head_coach" })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it("removing a coach's approval takes them off their team", async () => {
    const p = await approvedStaff("revokee", "assistant_coach");
    await admin.post(`/api/v1/admin/teams/teams/${t1}/staff`).send({ userId: p.userId, roleKey: "assistant_coach" });
    const [app] = await db.select().from(volunteerApplications).where(eq(volunteerApplications.userId, p.userId));
    expect((await admin.post(`/api/v1/admin/staff/applications/${app!.id}/revoke`).send({ reason: "Screening came back" })).status).toBe(200);
    expect(await activeTeamGrants(p.userId, t1)).toHaveLength(0);
    const overview = (await admin.get(`/api/v1/admin/teams/seasons/${seasonId}`)).body;
    const comets = overview.items.flatMap((d: { teams: { id: string; staff: { userId: string }[] }[] }) => d.teams).find((t: { id: string }) => t.id === t1);
    expect(comets.staff.some((s: { userId: string }) => s.userId === p.userId)).toBe(false);
  });
});
