import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import {
  announcements,
  divisions,
  drafts,
  householdMembers,
  households,
  players,
  registrations,
  rosterEntries,
  seasons,
  teams,
  teamStaff,
  user,
  userRoleAssignments,
} from "../src/db/schema/index.js";
import { leagueLocalToUtc, utcToLeagueLocal } from "../src/lib/league-time.js";
import { clearSubscribers, processOutbox } from "../src/modules/platform/outbox.js";
import { computeStandings } from "../src/modules/schedule/service.js";
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
import { agent, mail, signUp, uniqueEmail, type Agent } from "./helpers.js";

let admin: Agent;
let adminId: string;
let seasonId: string;
let divisionId: string;
let otherDivisionId: string;
let otherTeamId: string;
const team: Record<"sharks" | "jets", string> = { sharks: "", jets: "" };
let previousCurrent: string | null = null;

async function person(prefix: string) {
  const a = agent();
  const email = uniqueEmail(prefix.toLowerCase());
  await signUp(a, email, `${prefix} Person`);
  const [u] = await db.select().from(user).where(eq(user.email, email));
  return { a, email, userId: u!.id };
}

/** A family whose child is rostered on a team. */
async function rostered(prefix: string, teamId: string) {
  const p = await person(prefix);
  const [h] = await db.insert(households).values({ displayName: `${prefix} Family` }).returning();
  await db.insert(householdMembers).values({ householdId: h!.id, userId: p.userId });
  const [pl] = await db.insert(players).values({ householdId: h!.id, firstName: prefix, lastName: "Kid", birthDate: "2018-02-02", gender: "boy" }).returning();
  const [r] = await db
    .insert(registrations)
    .values({ seasonId, divisionId, playerId: pl!.id, householdId: h!.id, status: "approved", priceCents: 10000, totalCents: 10000 })
    .returning();
  await db.insert(rosterEntries).values({ teamId, divisionId, registrationId: r!.id, playerId: pl!.id, source: "draft", pickNumber: Math.floor(Math.random() * 1e6) });
  return p;
}

async function coachOf(prefix: string, teamId: string, roleKey = "head_coach") {
  const p = await person(prefix);
  const [g] = await db.insert(userRoleAssignments).values({ userId: p.userId, roleKey, scopeType: "team", scopeId: teamId }).returning();
  await db.insert(teamStaff).values({ teamId, userId: p.userId, roleKey, roleAssignmentId: g!.id });
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
  const a = await person("sched-admin");
  admin = a.a;
  adminId = a.userId;
  await db.insert(userRoleAssignments).values({ userId: adminId, roleKey: "super_admin" });
  const [cur] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.isCurrent, "current"));
  previousCurrent = cur?.id ?? null;
  if (previousCurrent) await db.update(seasons).set({ isCurrent: null }).where(eq(seasons.id, previousCurrent));
  const [s] = await db.insert(seasons).values({ name: "Schedule Season", year: 2027, isCurrent: "current" }).returning();
  seasonId = s!.id;
  const [d] = await db.insert(divisions).values({ seasonId, name: "Sched 8U", capacity: 40, priceCents: 10000, status: "open" }).returning();
  divisionId = d!.id;
  const [d2] = await db.insert(divisions).values({ seasonId, name: "Sched 10U", capacity: 40, priceCents: 10000, status: "open" }).returning();
  otherDivisionId = d2!.id;
  const ts = await db
    .insert(teams)
    .values([
      { seasonId, divisionId, name: "Sharks" },
      { seasonId, divisionId, name: "Jets" },
      { seasonId, divisionId: otherDivisionId, name: "Owls" },
    ])
    .returning();
  team.sharks = ts[0]!.id;
  team.jets = ts[1]!.id;
  otherTeamId = ts[2]!.id;
});

afterAll(async () => {
  await drainAll();
  clearSubscribers();
  await db.update(seasons).set({ isCurrent: null }).where(eq(seasons.id, seasonId));
  if (previousCurrent) await db.update(seasons).set({ isCurrent: "current" }).where(eq(seasons.id, previousCurrent));
  await db.update(userRoleAssignments).set({ revokedAt: new Date() }).where(eq(userRoleAssignments.userId, adminId));
});

describe("league time", () => {
  it("converts Jacksonville wall-clock time in winter and summer, and rejects impossible times", () => {
    expect(leagueLocalToUtc("2027-01-10T09:00")!.toISOString()).toBe("2027-01-10T14:00:00.000Z");
    expect(leagueLocalToUtc("2027-07-10T09:00")!.toISOString()).toBe("2027-07-10T13:00:00.000Z");
    expect(utcToLeagueLocal(new Date("2027-01-10T14:00:00Z"))).toBe("2027-01-10T09:00");
    expect(leagueLocalToUtc("2027-02-31T09:00")).toBeNull();
    expect(leagueLocalToUtc("2027-03-14T02:30")).toBeNull(); // skipped by daylight saving
  });

  it("ranks standings by win percentage, ties count half", () => {
    const rows = computeStandings(
      [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: "c", name: "C" },
      ],
      [
        { homeTeamId: "a", awayTeamId: "b", homeScore: 20, awayScore: 6 },
        { homeTeamId: "b", awayTeamId: "c", homeScore: 12, awayScore: 12 },
      ],
    );
    expect(rows.map((r) => `${r.team} ${r.w}-${r.l}-${r.t}`)).toEqual(["A 1-0-0", "C 0-0-1", "B 0-1-1"]);
  });
});

describe("games, scores and standings", () => {
  let gameId: string;

  it("adds a game in league time and refuses teams from different divisions", async () => {
    const bad = await admin.post("/api/v1/admin/schedule/games").send({ divisionId, homeTeamId: team.sharks, awayTeamId: otherTeamId, startsAt: "2027-01-16T09:00", location: "Field 1" });
    expect(bad.status).toBe(400);
    const same = await admin.post("/api/v1/admin/schedule/games").send({ divisionId, homeTeamId: team.sharks, awayTeamId: team.sharks, startsAt: "2027-01-16T09:00", location: "Field 1" });
    expect(same.status).toBe(400);
    const r = await admin.post("/api/v1/admin/schedule/games").send({ divisionId, homeTeamId: team.sharks, awayTeamId: team.jets, startsAt: "2027-01-16T09:00", location: "Field 1", notes: "Gate code 1234" });
    expect(r.status).toBe(201);
    gameId = r.body.game.id;
    expect(new Date(r.body.game.startsAt).toISOString()).toBe("2027-01-16T14:00:00.000Z");
  });

  it("season pass link: admins set it on the season; the public schedule shows it until the season is over", async () => {
    const body = { name: "Schedule Season", year: 2027, status: "in_season", isCurrent: true };
    expect((await admin.put(`/api/v1/admin/league/seasons/${seasonId}`).send({ ...body, seasonPassUrl: "http://tixflo.com/pass" })).status).toBe(400);
    expect((await admin.put(`/api/v1/admin/league/seasons/${seasonId}`).send({ ...body, seasonPassUrl: "https://tixflo.com/nffl/season" })).status).toBe(200);
    expect((await agent().get("/api/v1/schedule")).body.season.seasonPassUrl).toBe("https://tixflo.com/nffl/season");
    // Saving without the field leaves it alone.
    await admin.put(`/api/v1/admin/league/seasons/${seasonId}`).send(body);
    expect((await agent().get("/api/v1/schedule")).body.season.seasonPassUrl).toBe("https://tixflo.com/nffl/season");
    await admin.put(`/api/v1/admin/league/seasons/${seasonId}`).send({ ...body, status: "completed" });
    expect((await agent().get("/api/v1/schedule")).body.season.seasonPassUrl).toBeNull();
    await admin.put(`/api/v1/admin/league/seasons/${seasonId}`).send({ ...body, seasonPassUrl: "" });
    const [row] = await db.select().from(seasons).where(eq(seasons.id, seasonId));
    expect(row!.seasonPassUrl).toBeNull();
  });

  it("records a score, which shows on the public schedule and standings (without private notes)", async () => {
    const outsider = agent();
    expect((await outsider.put(`/api/v1/admin/schedule/games/${gameId}/score`).send({ homeScore: 1, awayScore: 0 })).status).toBe(401);
    const s = await admin.put(`/api/v1/admin/schedule/games/${gameId}/score`).send({ homeScore: 21, awayScore: 14 });
    expect(s.body.game.status).toBe("final");
    expect((await admin.put(`/api/v1/admin/schedule/games/${gameId}`).send({ homeTeamId: team.sharks, awayTeamId: team.jets, startsAt: "2027-01-16T10:00", location: "Field 2", status: "scheduled" })).status).toBe(409);

    const pub = await outsider.get("/api/v1/schedule");
    expect(pub.status).toBe(200);
    const div = pub.body.divisions.find((d: { id: string }) => d.id === divisionId);
    expect(div.games[0]).toMatchObject({ home: "Sharks", away: "Jets", homeScore: 21, awayScore: 14, startsAtLocal: "2027-01-16T09:00" });
    expect(div.games[0].notes).toBeUndefined();
    expect(div.standings.map((r: { team: string; w: number; l: number }) => `${r.team} ${r.w}-${r.l}`)).toEqual(["Sharks 1-0", "Jets 0-1"]);
  });

  it("imports a CSV: checks every row first, skips games already on the schedule", async () => {
    const csv = [
      "Date,Time,Division,Home,Away,Location",
      "1/16/2027,9:00 AM,Sched 8U,Sharks,Jets,Field 1", // already exists
      '1/23/2027,10:30 am,sched 8u,Jets,Sharks,"Field 2, north"',
      "2027-01-30,13:00,Sched 8U,Sharks,Dolphins,Field 1",
    ].join("\r\n");
    const dry = await admin.post(`/api/v1/admin/schedule/seasons/${seasonId}/import`).send({ csv, dryRun: false });
    expect(dry.body.errors).toBe(1);
    expect(dry.body.added).toBe(0);
    expect(dry.body.rows[2].error).toMatch(/no team "Dolphins"/);
    expect(dry.body.rows[0].duplicate).toBe(true);

    const fixed = csv.replace("Dolphins", "Jets");
    const preview = await admin.post(`/api/v1/admin/schedule/seasons/${seasonId}/import`).send({ csv: fixed, dryRun: true });
    expect(preview.body).toMatchObject({ errors: 0, duplicates: 1, ready: 2, added: 0 });
    const done = await admin.post(`/api/v1/admin/schedule/seasons/${seasonId}/import`).send({ csv: fixed, dryRun: false });
    expect(done.body.added).toBe(2);
    const again = await admin.post(`/api/v1/admin/schedule/seasons/${seasonId}/import`).send({ csv: fixed, dryRun: false });
    expect(again.body).toMatchObject({ duplicates: 3, added: 0 });

    const games = (await admin.get(`/api/v1/admin/schedule/seasons/${seasonId}`)).body.games;
    expect(games.find((g: { location: string }) => g.location === "Field 2, north").startsAtLocal).toBe("2027-01-23T10:30");
  });

  it("stores a ticket link per game (https only) and shows it on the public schedule", async () => {
    const base = { divisionId, homeTeamId: team.jets, awayTeamId: team.sharks, startsAt: "2027-02-06T09:00", location: "Field 3" };
    expect((await admin.post("/api/v1/admin/schedule/games").send({ ...base, ticketUrl: "http://tix.example.com/x" })).status).toBe(400);
    expect((await admin.post("/api/v1/admin/schedule/games").send({ ...base, ticketUrl: "javascript:alert(1)" })).status).toBe(400);
    const g = await admin.post("/api/v1/admin/schedule/games").send({ ...base, ticketUrl: "https://tixflo.example.com/e/123" });
    expect(g.status).toBe(201);
    const pub = (await agent().get("/api/v1/schedule")).body.divisions.find((d: { id: string }) => d.id === divisionId);
    expect(pub.games.find((x: { id: string }) => x.id === g.body.game.id).ticketUrl).toBe("https://tixflo.example.com/e/123");
    // Clearing the link on edit.
    const e = await admin.put(`/api/v1/admin/schedule/games/${g.body.game.id}`).send({ homeTeamId: team.jets, awayTeamId: team.sharks, startsAt: "2027-02-06T09:00", location: "Field 3", status: "scheduled", ticketUrl: "" });
    expect(e.body.game.ticketUrl).toBeNull();
    // CSV "Tickets" column.
    const csv = "Date,Time,Division,Home,Away,Location,Tickets\n2/13/2027,9:00 AM,Sched 8U,Sharks,Jets,Field 1,https://tixflo.example.com/e/456\n2/20/2027,9:00 AM,Sched 8U,Sharks,Jets,Field 1,tix.example.com";
    const bad = await admin.post(`/api/v1/admin/schedule/seasons/${seasonId}/import`).send({ csv, dryRun: true });
    expect(bad.body.rows[1].error).toMatch(/https/);
    const ok = await admin.post(`/api/v1/admin/schedule/seasons/${seasonId}/import`).send({ csv: csv.split("\n").slice(0, 2).join("\n"), dryRun: false });
    expect(ok.body.added).toBe(1);
    const games = (await admin.get(`/api/v1/admin/schedule/seasons/${seasonId}`)).body.games;
    expect(games.some((x: { ticketUrl: string | null }) => x.ticketUrl === "https://tixflo.example.com/e/456")).toBe(true);
  });

  it("emails both teams when a game is cancelled with notify", async () => {
    const fam = await rostered("Gamefam", team.jets);
    const g = (await admin.get(`/api/v1/admin/schedule/seasons/${seasonId}`)).body.games.find((x: { status: string }) => x.status === "scheduled");
    const r = await admin.put(`/api/v1/admin/schedule/games/${g.id}`).send({ homeTeamId: g.homeTeamId, awayTeamId: g.awayTeamId, startsAt: g.startsAtLocal, location: g.location, status: "cancelled", notify: true });
    expect(r.body.game.status).toBe("cancelled");
    await drainAll();
    expect(mail.last(fam.email, "announcement")!.subject).toMatch(/Game cancelled: (Sharks vs Jets|Jets vs Sharks)/);
  });
});

describe("practices, announcements and family schedules", () => {
  let coach: Awaited<ReturnType<typeof coachOf>>;
  let assistant: Awaited<ReturnType<typeof coachOf>>;
  let otherCoach: Awaited<ReturnType<typeof coachOf>>;
  let sharkFam: Awaited<ReturnType<typeof rostered>>;
  let jetFam: Awaited<ReturnType<typeof rostered>>;
  let practiceId: string;

  it("keeps coaches out until rosters are published", async () => {
    coach = await coachOf("Sharkcoach", team.sharks);
    assistant = await coachOf("Sharkasst", team.sharks, "assistant_coach");
    otherCoach = await coachOf("Jetcoach", team.jets);
    sharkFam = await rostered("Sharkfam", team.sharks);
    jetFam = await rostered("Jetfam", team.jets);
    const p = { startsAt: "2027-01-12T18:00", durationMinutes: 90, location: "Park field 3" };
    expect((await coach.a.post(`/api/v1/teams/${team.sharks}/practices`).send(p)).status).toBe(403);
    await db.insert(drafts).values({ divisionId, status: "complete", publishedAt: new Date() });
    const r = await coach.a.post(`/api/v1/teams/${team.sharks}/practices`).send(p);
    expect(r.status).toBe(201);
    practiceId = r.body.practice.id;
  });

  it("only lets a team's own coaches manage its practices", async () => {
    const p = { startsAt: "2027-01-13T18:00", durationMinutes: 60, location: "Park" };
    expect((await otherCoach.a.post(`/api/v1/teams/${team.sharks}/practices`).send(p)).status).toBe(403);
    expect((await sharkFam.a.post(`/api/v1/teams/${team.sharks}/practices`).send(p)).status).toBe(403);
    // A practice id from another team can't be edited through your own team.
    expect((await otherCoach.a.delete(`/api/v1/teams/${team.jets}/practices/${practiceId}`)).status).toBe(404);
    expect((await assistant.a.post(`/api/v1/teams/${team.sharks}/practices`).send(p)).status).toBe(201);
  });

  it("adds weekly practices (Tue + Wed at 6 PM) and deletes the rest of a series", async () => {
    const body = { startDate: "2027-02-01", endDate: "2027-02-14", weekdays: [2, 3], time: "18:00", durationMinutes: 75, location: "Field 4" };
    expect((await otherCoach.a.post(`/api/v1/teams/${team.sharks}/practices/series`).send(body)).status).toBe(403);
    const r = await coach.a.post(`/api/v1/teams/${team.sharks}/practices/series`).send(body);
    expect(r.status).toBe(201);
    expect(r.body.count).toBe(4); // Feb 2, 3, 9, 10
    const list = (await coach.a.get(`/api/v1/teams/${team.sharks}/practices`)).body.items.filter((p: { seriesId: string }) => p.seriesId === r.body.seriesId);
    expect(list.map((p: { startsAtLocal: string }) => p.startsAtLocal)).toEqual(["2027-02-02T18:00", "2027-02-03T18:00", "2027-02-09T18:00", "2027-02-10T18:00"]);
    expect(new Date(list[0].startsAt).toISOString()).toBe("2027-02-02T23:00:00.000Z");

    expect((await coach.a.post(`/api/v1/teams/${team.sharks}/practices/series`).send({ ...body, endDate: "2027-01-01" })).status).toBe(400);
    expect((await coach.a.post(`/api/v1/teams/${team.sharks}/practices/series`).send({ ...body, endDate: "2028-12-31", weekdays: [0, 1, 2, 3, 4, 5, 6] })).status).toBe(400);

    const del = await coach.a.delete(`/api/v1/teams/${team.sharks}/practices/${list[2].id}/series`);
    expect(del.body.deleted).toBe(2);
    const left = (await coach.a.get(`/api/v1/teams/${team.sharks}/practices`)).body.items.filter((p: { seriesId: string }) => p.seriesId === r.body.seriesId);
    expect(left).toHaveLength(2);
  });

  it("shows each family their own team's games and practices", async () => {
    const mine = (await sharkFam.a.get("/api/v1/my-schedule")).body.items;
    expect(mine).toHaveLength(1);
    expect(mine[0].team.name).toBe("Sharks");
    expect(mine[0].practices.map((p: { location: string }) => p.location)).toContain("Park field 3");
    expect(mine[0].games.length).toBeGreaterThan(0);
    const jets = (await jetFam.a.get("/api/v1/my-schedule")).body.items;
    expect(jets[0].practices).toHaveLength(0);
  });

  it("sends a team announcement to that team's families and staff only; replies go to the coach", async () => {
    const r = await coach.a.post(`/api/v1/teams/${team.sharks}/announcements`).send({ subject: "Bring water", body: "Hot day.\n\nSee you at 6." });
    expect(r.status).toBe(201);
    expect(r.body.announcement.recipientCount).toBe(3); // family, head coach, assistant
    expect((await otherCoach.a.post(`/api/v1/teams/${team.sharks}/announcements`).send({ subject: "x", body: "y" })).status).toBe(403);
    await drainAll();
    const m = mail.last(sharkFam.email, "announcement")!;
    expect(m.subject).toBe("Sharks: Bring water");
    expect(m.replyTo).toBe(coach.email);
    expect(m.html).toContain("See you at 6.");
    expect(mail.last(jetFam.email, "announcement")?.subject ?? "").not.toContain("Bring water");
    const list = (await assistant.a.get(`/api/v1/teams/${team.sharks}/announcements`)).body.items;
    expect(list[0].subject).toBe("Bring water");
  });

  it("escapes announcement HTML", async () => {
    await coach.a.post(`/api/v1/teams/${team.sharks}/announcements`).send({ subject: "Snacks", body: "<script>alert(1)</script>" });
    await drainAll();
    const m = mail.last(sharkFam.email, "announcement")!;
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
  });

  it("emails the team when a practice is cancelled with notify", async () => {
    const r = await coach.a
      .put(`/api/v1/teams/${team.sharks}/practices/${practiceId}`)
      .send({ startsAt: "2027-01-12T18:00", durationMinutes: 90, location: "Park field 3", status: "cancelled", notify: true });
    expect(r.body.practice.status).toBe("cancelled");
    await drainAll();
    expect(mail.last(sharkFam.email, "announcement")!.subject).toBe("Sharks: Practice cancelled");
  });

  it("limits how many announcements one person sends per hour", async () => {
    const sent = await db.select().from(announcements).where(eq(announcements.sentBy, coach.userId));
    const statuses: number[] = [];
    for (let i = sent.length; i < 12; i++) statuses.push((await coach.a.post(`/api/v1/teams/${team.sharks}/announcements`).send({ subject: `Note ${i}`, body: "Hi" })).status);
    expect(statuses.at(-1)).toBe(429);
  });

  it("lets an admin email a whole division or the league", async () => {
    const r = await admin.post("/api/v1/admin/schedule/announcements").send({ audience: "division", divisionId, subject: "Picture day", body: "Saturday at 9." });
    expect(r.status).toBe(201);
    const ids = (await db.select({ id: user.id }).from(user).where(inArray(user.email, [sharkFam.email, jetFam.email, coach.email]))).map((u) => u.id);
    expect(ids).toHaveLength(3);
    expect(r.body.announcement.recipientCount).toBeGreaterThanOrEqual(5);
    expect((await coach.a.post("/api/v1/admin/schedule/announcements").send({ audience: "league", subject: "x", body: "y" })).status).toBe(403);
    const audit = await db.select().from(announcements).where(and(eq(announcements.audience, "division"), eq(announcements.divisionId, divisionId)));
    expect(audit).toHaveLength(1);
  });
});

describe("release switches", () => {
  it("hides practices, games and coach announcements from families and coaches while off; admins still work", async () => {
    const c = await coachOf("Switchcoach", team.sharks, "assistant_coach");
    const fam = await rostered("Switchfam", team.sharks);
    await setFlags(false, ["r3.practices", "r4.games", "r4.announcements"]);
    try {
      const p = { startsAt: "2027-02-20T18:00", durationMinutes: 60, location: "Park" };
      const blocked = await c.a.post(`/api/v1/teams/${team.sharks}/practices`).send(p);
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe("FEATURE_DISABLED");
      expect((await c.a.post(`/api/v1/teams/${team.sharks}/announcements`).send({ subject: "x", body: "y" })).body.error.code).toBe("FEATURE_DISABLED");
      expect((await admin.post(`/api/v1/teams/${team.sharks}/practices`).send(p)).status).toBe(201);
      const mine = (await fam.a.get("/api/v1/my-schedule")).body.items[0];
      expect(mine.games).toHaveLength(0);
      expect(mine.practices).toHaveLength(0);
      expect((await agent().get("/api/v1/schedule")).body.divisions).toHaveLength(0);

      await setFlags(false, ["r3.teams_draft"]);
      expect((await fam.a.get("/api/v1/my-schedule")).body.items).toHaveLength(0);
      expect((await c.a.get("/api/v1/my-teams")).body.items).toHaveLength(0);
      expect((await c.a.get(`/api/v1/my-teams/${team.sharks}`)).status).toBe(403);
    } finally {
      await setFlags(true);
    }
    expect((await fam.a.get("/api/v1/my-schedule")).body.items[0].practices.length).toBeGreaterThan(0);
  });
});
