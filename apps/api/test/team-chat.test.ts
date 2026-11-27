/** Team spaces: who can see what, posting rules, RSVPs, alerts and moderation. */
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import {
  divisions,
  drafts,
  featureFlags,
  householdMembers,
  households,
  players,
  practices,
  registrations,
  rosterEntries,
  seasons,
  teamMessages,
  teamStaff,
  teams,
  user,
  userRoleAssignments,
} from "../src/db/schema/index.js";
import { resetFlagCache } from "../src/modules/platform/flags.js";
import { clearSubscribers, processOutbox } from "../src/modules/platform/outbox.js";
import { registerSubscribers } from "../src/modules/subscribers.js";
import { closeLive } from "../src/modules/team-chat/live.js";
import { agent, mail, signUp, uniqueEmail, type Agent } from "./helpers.js";

const FLAG = "r6.team_chat";
let seasonId: string;
let divisionId: string;
let teamA: string;
let teamB: string;
let practiceA: string;
let practiceB: string;
let previousCurrent: string | null = null;

async function person(prefix: string) {
  const a = agent();
  const email = uniqueEmail(prefix.toLowerCase());
  await signUp(a, email, `${prefix} Person`);
  const [u] = await db.select().from(user).where(eq(user.email, email));
  return { a, email, userId: u!.id };
}

/** A household with one child per team given. */
async function family(prefix: string, teamIds: string[]) {
  const p = await person(prefix);
  const [h] = await db.insert(households).values({ displayName: `The ${prefix} Family`, phone: "904-555-0100" }).returning();
  await db.insert(householdMembers).values({ householdId: h!.id, userId: p.userId });
  const kids: string[] = [];
  for (const [i, teamId] of teamIds.entries()) {
    const [k] = await db.insert(players).values({ householdId: h!.id, firstName: `${prefix}${i + 1}`, lastName: "Kid", birthDate: "2017-03-03", gender: "boy" }).returning();
    const [r] = await db.insert(registrations).values({ seasonId, divisionId, playerId: k!.id, householdId: h!.id, status: "approved", priceCents: 0, totalCents: 0, paidAt: new Date() }).returning();
    await db.insert(rosterEntries).values({ teamId, divisionId, registrationId: r!.id, playerId: k!.id, source: "manual" });
    kids.push(k!.id);
  }
  return { ...p, kids };
}

const api = (a: Agent, path: string) => `/api/v1/team-spaces${path}`;
const drain = async () => {
  for (;;) {
    const r = await processOutbox(200);
    if (r.processed + r.failed === 0) return;
  }
};

let coach: Awaited<ReturnType<typeof person>>;
let mom: Awaited<ReturnType<typeof person>>;
let famA: Awaited<ReturnType<typeof family>>;
let famB: Awaited<ReturnType<typeof family>>;
let split: Awaited<ReturnType<typeof family>>;
let admin: Awaited<ReturnType<typeof person>>;
let outsider: Awaited<ReturnType<typeof person>>;

beforeAll(async () => {
  clearSubscribers();
  registerSubscribers();
  const [cur] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.isCurrent, "current"));
  previousCurrent = cur?.id ?? null;
  await db.update(seasons).set({ isCurrent: null });
  const [s] = await db.insert(seasons).values({ name: "Chat Season", year: 2031, status: "in_progress", isCurrent: "current" }).returning();
  seasonId = s!.id;
  const [d] = await db.insert(divisions).values({ seasonId, name: "Chat 10U", genderPolicy: "coed", capacity: 40, priceCents: 0, status: "open" }).returning();
  divisionId = d!.id;
  const [a] = await db.insert(teams).values({ seasonId, divisionId, name: "Chat Hawks", color: "#007cd7" }).returning();
  const [b] = await db.insert(teams).values({ seasonId, divisionId, name: "Chat Owls", color: "#e14b8a" }).returning();
  teamA = a!.id;
  teamB = b!.id;
  await db.insert(drafts).values({ divisionId, status: "complete", publishedAt: new Date() });
  const soon = new Date(Date.now() + 2 * 86400_000);
  const [pa] = await db.insert(practices).values({ teamId: teamA, startsAt: soon, location: "Field 1" }).returning();
  const [pb] = await db.insert(practices).values({ teamId: teamB, startsAt: soon, location: "Field 2" }).returning();
  practiceA = pa!.id;
  practiceB = pb!.id;

  coach = await person("ChatCoach");
  mom = await person("ChatMom");
  await db.insert(teamStaff).values([
    { teamId: teamA, userId: coach.userId, roleKey: "head_coach" },
    { teamId: teamA, userId: mom.userId, roleKey: "team_manager" },
  ]);
  famA = await family("Ava", [teamA]);
  famB = await family("Ben", [teamB]);
  split = await family("Sam", [teamA, teamB]);
  outsider = await person("ChatOutsider");
  admin = await person("ChatAdmin");
  await db.insert(userRoleAssignments).values({ userId: admin.userId, roleKey: "super_admin" });

  await db.insert(featureFlags).values({ key: FLAG, enabled: true }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true } });
  resetFlagCache();
});

afterAll(async () => {
  await closeLive();
  await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, FLAG));
  await db.update(seasons).set({ isCurrent: null });
  if (previousCurrent) await db.update(seasons).set({ isCurrent: "current" }).where(eq(seasons.id, previousCurrent));
  else await db.update(seasons).set({ isCurrent: "current" }).where(like(seasons.name, "%(sample)"));
  await db.update(userRoleAssignments).set({ revokedAt: new Date() }).where(eq(userRoleAssignments.userId, admin.userId));
  resetFlagCache();
});

describe("who belongs where", () => {
  it("each family sees only their own child's team; a family with kids on two teams sees both", async () => {
    const a = (await famA.a.get(api(famA.a, ""))).body.items;
    expect(a.map((s: { teamName: string }) => s.teamName)).toEqual(["Chat Hawks"]);
    expect(a[0].role).toBe("family");
    expect(a[0].children.map((c: { name: string }) => c.name)).toEqual(["Ava1"]);

    const both = (await split.a.get(api(split.a, ""))).body.items;
    expect(both.map((s: { teamName: string }) => s.teamName).sort()).toEqual(["Chat Hawks", "Chat Owls"]);
    // Each team lists only the child who plays there.
    expect(both.find((s: { teamName: string }) => s.teamName === "Chat Owls").children.map((c: { name: string }) => c.name)).toEqual(["Sam2"]);

    expect((await outsider.a.get(api(outsider.a, ""))).body.items).toEqual([]);
    const c = (await coach.a.get(api(coach.a, ""))).body.items;
    expect(c.map((s: { role: string; teamName: string }) => [s.teamName, s.role])).toEqual([["Chat Hawks", "staff"]]);
  });

  it("another team's space, messages, schedule and RSVPs answer 404, like a team that doesn't exist", async () => {
    for (const path of [`/${teamB}`, `/${teamB}/messages?view=chat`, `/${teamB}/events`, `/${teamB}/events/practice/${practiceB}/rsvps`]) {
      expect((await famA.a.get(api(famA.a, path))).status).toBe(404);
    }
    expect((await famA.a.post(api(famA.a, `/${teamB}/messages`)).send({ view: "chat", body: "hi" })).status).toBe(404);
    expect((await famA.a.put(api(famA.a, `/${teamB}/rsvp`)).send({ eventType: "practice", eventId: practiceB, playerId: famB.kids[0], status: "no" })).status).toBe(404);
    expect((await outsider.a.get(api(outsider.a, `/${teamA}`))).status).toBe(404);
    expect((await famA.a.get(api(famA.a, `/00000000-0000-4000-8000-000000000000`))).status).toBe(404);
  });

  it("families wait until rosters are published", async () => {
    await db.update(drafts).set({ publishedAt: null }).where(eq(drafts.divisionId, divisionId));
    expect((await famA.a.get(api(famA.a, ""))).body.items).toEqual([]);
    expect((await famA.a.get(api(famA.a, `/${teamA}`))).status).toBe(404);
    // Staff can get ready before families arrive.
    expect((await coach.a.get(api(coach.a, `/${teamA}`))).status).toBe(200);
    await db.update(drafts).set({ publishedAt: new Date() }).where(eq(drafts.divisionId, divisionId));
  });

  it("is off for families until the flag is on; admins can try it first", async () => {
    await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, FLAG));
    resetFlagCache();
    expect((await famA.a.get(api(famA.a, ""))).status).toBe(403);
    expect((await admin.a.get(api(admin.a, `/${teamA}`))).status).toBe(200);
    await db.update(featureFlags).set({ enabled: true }).where(eq(featureFlags.key, FLAG));
    resetFlagCache();
  });
});

describe("posting", () => {
  it("parents chat; only staff post updates and alerts; the staff chat is staff-only", async () => {
    const chat = await famA.a.post(api(famA.a, `/${teamA}/messages`)).send({ view: "chat", body: "Can anyone carpool Tuesday?" });
    expect(chat.status).toBe(201);
    expect(chat.body.message).toMatchObject({ authorName: "Ava Person", authorLabel: "Parent of Ava1" });

    expect((await famA.a.post(api(famA.a, `/${teamA}/messages`)).send({ view: "feed", body: "Hello" })).status).toBe(403);
    expect((await famA.a.post(api(famA.a, `/${teamA}/messages`)).send({ view: "chat", body: "x", alert: true })).status).toBe(403);
    expect((await famA.a.post(api(famA.a, `/${teamA}/messages`)).send({ view: "staff", body: "x" })).status).toBe(403);
    expect((await famA.a.get(api(famA.a, `/${teamA}/messages?view=staff`))).status).toBe(403);

    const staffMsg = await mom.a.post(api(mom.a, `/${teamA}/messages`)).send({ view: "staff", body: "Snack list is done" });
    expect(staffMsg.status).toBe(201);
    expect(staffMsg.body.message.authorLabel).toBe("Team mom");
    const seen = (await coach.a.get(api(coach.a, `/${teamA}/messages?view=staff`))).body.items;
    expect(seen.map((m: { body: string }) => m.body)).toContain("Snack list is done");
    // A parent can't touch a staff message even knowing its id.
    expect((await famA.a.post(api(famA.a, `/${teamA}/messages/${staffMsg.body.message.id}/report`)).send({ reason: "testing ids" })).status).toBe(404);

    // Messages never leak to the other team.
    const owls = (await famB.a.get(api(famB.a, `/${teamB}/messages?view=chat`))).body.items;
    expect(owls).toEqual([]);
  });

  it("an alert pins itself, replaces the last one, and emails every family", async () => {
    mail.clear?.();
    const first = await coach.a.post(api(coach.a, `/${teamA}/messages`)).send({ view: "feed", body: "Practice moved to 6 PM", alert: true });
    expect(first.status).toBe(201);
    expect(first.body.message.pinned).toBe(true);
    const second = await coach.a.post(api(coach.a, `/${teamA}/messages`)).send({ view: "feed", body: "Rained out tonight\n\nSee you Thursday.", alert: true });
    const [old] = await db.select().from(teamMessages).where(eq(teamMessages.id, first.body.message.id));
    expect(old!.pinned).toBe(false);

    await drain();
    const to = mail.sent.filter((m) => m.subject.startsWith("Chat Hawks: Rained out tonight")).map((m) => m.to);
    expect(to.sort()).toEqual([famA.email, mom.email, split.email].sort());
    expect(to).not.toContain(famB.email);
    expect(to).not.toContain(coach.email);

    const list = (await split.a.get(api(split.a, ""))).body.items;
    expect(list.find((s: { teamName: string }) => s.teamName === "Chat Hawks").pinned.id).toBe(second.body.message.id);
    expect(list.find((s: { teamName: string }) => s.teamName === "Chat Owls").pinned).toBeNull();
  });

  it("unread counts clear when read", async () => {
    const before = (await famA.a.get(api(famA.a, ""))).body.items[0].unread;
    expect(before.feed).toBeGreaterThan(0);
    await famA.a.post(api(famA.a, `/${teamA}/read`)).send({ view: "feed" });
    expect((await famA.a.get(api(famA.a, ""))).body.items[0].unread.feed).toBe(0);
  });

  it("admins read and remove, but can't post; parents remove only their own", async () => {
    const msg = await split.a.post(api(split.a, `/${teamA}/messages`)).send({ view: "chat", body: "Not nice" });
    expect((await famA.a.delete(api(famA.a, `/${teamA}/messages/${msg.body.message.id}`))).status).toBe(403);
    expect((await admin.a.post(api(admin.a, `/${teamA}/messages`)).send({ view: "chat", body: "hi" })).status).toBe(403);
    expect((await admin.a.get(api(admin.a, `/${teamA}/messages?view=staff`))).status).toBe(200);

    expect((await famA.a.post(api(famA.a, `/${teamA}/messages/${msg.body.message.id}/report`)).send({ reason: "Unkind to a kid" })).status).toBe(204);
    const reports = (await admin.a.get("/api/v1/admin/team-chat/reports")).body.items;
    const r = reports.find((x: { messageId: string }) => x.messageId === msg.body.message.id);
    expect(r).toMatchObject({ teamName: "Chat Hawks", authorName: "Sam Person" });
    expect((await famA.a.get("/api/v1/admin/team-chat/reports")).status).toBe(403);
    expect((await admin.a.post(`/api/v1/admin/team-chat/reports/${r.id}`).send({ remove: true })).status).toBe(204);
    const chat = (await famA.a.get(api(famA.a, `/${teamA}/messages?view=chat`))).body.items;
    expect(chat.map((m: { id: string }) => m.id)).not.toContain(msg.body.message.id);
  });
});

describe("RSVPs", () => {
  it("families answer for their own child only; coaches see every answer and can nudge the rest", async () => {
    const ok = await famA.a.put(api(famA.a, `/${teamA}/rsvp`)).send({ eventType: "practice", eventId: practiceA, playerId: famA.kids[0], status: "yes" });
    expect(ok.status).toBe(204);
    // Someone else's child on the same team.
    expect((await famA.a.put(api(famA.a, `/${teamA}/rsvp`)).send({ eventType: "practice", eventId: practiceA, playerId: split.kids[0], status: "no" })).status).toBe(403);
    // Sam's Owls child can't be answered for on the Hawks page.
    expect((await split.a.put(api(split.a, `/${teamA}/rsvp`)).send({ eventType: "practice", eventId: practiceA, playerId: split.kids[1], status: "no" })).status).toBe(404);
    // The other team's practice isn't on this team's schedule.
    expect((await famA.a.put(api(famA.a, `/${teamA}/rsvp`)).send({ eventType: "practice", eventId: practiceB, playerId: famA.kids[0], status: "yes" })).status).toBe(404);

    expect((await famA.a.get(api(famA.a, `/${teamA}/events/practice/${practiceA}/rsvps`))).status).toBe(403);
    const ev = (await famA.a.get(api(famA.a, `/${teamA}/events`))).body.items[0];
    expect(ev.counts).toEqual({ yes: 1, maybe: 0, no: 0, none: 1 });
    expect(ev.myRsvps).toEqual([{ playerId: famA.kids[0], name: "Ava1", status: "yes", note: null }]);

    const all = (await coach.a.get(api(coach.a, `/${teamA}/events/practice/${practiceA}/rsvps`))).body.players;
    expect(all.map((p: { name: string; status: string | null }) => [p.name, p.status])).toEqual([
      ["Ava1 K.", "yes"],
      ["Sam1 K.", null],
    ]);

    mail.clear?.();
    const nudge = await coach.a.post(api(coach.a, `/${teamA}/events/practice/${practiceA}/remind`));
    expect(nudge.body).toEqual({ families: 1 });
    await drain();
    expect(mail.sent.filter((m) => m.subject.startsWith("Chat Hawks: are you coming")).map((m) => m.to)).toEqual([split.email]);
  });
});

describe("old seasons", () => {
  it("become read-only when the season isn't current", async () => {
    await db.update(seasons).set({ isCurrent: null }).where(eq(seasons.id, seasonId));
    const s = (await famA.a.get(api(famA.a, `/${teamA}`))).body;
    expect(s.readOnly).toBe(true);
    expect(s.can.chat).toBe(false);
    expect((await famA.a.post(api(famA.a, `/${teamA}/messages`)).send({ view: "chat", body: "late" })).status).toBe(409);
    await db.update(seasons).set({ isCurrent: "current" }).where(eq(seasons.id, seasonId));
  });
});
