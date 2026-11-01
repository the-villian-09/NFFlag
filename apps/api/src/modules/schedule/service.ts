/**
 * R4: games (admin entry + CSV import), scores and standings, team practices,
 * and email announcements to a team, a division or the whole league.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, type DbOrTx } from "../../db/client.js";
import {
  announcements,
  divisions,
  drafts,
  games,
  householdMembers,
  players,
  practices,
  registrations,
  rosterEntries,
  seasons,
  teams,
  teamStaff,
  user,
} from "../../db/schema/index.js";
import { HttpError } from "../../http/errors.js";
import { parseCsv } from "../../lib/csv.js";
import { leagueLabel, leagueLocalToUtc, utcToLeagueLocal } from "../../lib/league-time.js";
import { writeAudit } from "../platform/audit.js";
import { publish } from "../platform/outbox.js";

export interface Actor {
  userId: string;
  name: string;
  requestId?: string;
  ip?: string | null;
}

export const GAME_STATUSES = ["scheduled", "final", "cancelled", "postponed"] as const;
export type GameStatus = (typeof GAME_STATUSES)[number];

function when(local: string) {
  const d = leagueLocalToUtc(local);
  if (!d) throw new HttpError(400, "VALIDATION_FAILED", "Enter a valid date and time.");
  return d;
}

/* ---------------- games ---------------- */

/** Ticket links must be https web addresses (shown to the public as a button). */
export function isTicketUrl(v: string) {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !!u.hostname && v.length <= 500;
  } catch {
    return false;
  }
}

async function teamsInDivision(conn: DbOrTx, divisionId: string, homeTeamId: string, awayTeamId: string) {
  if (homeTeamId === awayTeamId) throw new HttpError(400, "VALIDATION_FAILED", "Pick two different teams.");
  const rows = await conn.select().from(teams).where(inArray(teams.id, [homeTeamId, awayTeamId]));
  if (rows.length !== 2 || rows.some((t) => t.divisionId !== divisionId)) {
    throw new HttpError(400, "VALIDATION_FAILED", "Both teams must be in the same division.");
  }
  return rows[0]!.seasonId;
}

export interface GameInput {
  divisionId: string;
  homeTeamId: string;
  awayTeamId: string;
  startsAt: string; // league local "YYYY-MM-DDTHH:mm"
  location: string;
  notes?: string | null;
  ticketUrl?: string | null;
}

export async function createGame(actor: Actor, input: GameInput) {
  const startsAt = when(input.startsAt);
  return db.transaction(async (tx) => {
    const seasonId = await teamsInDivision(tx, input.divisionId, input.homeTeamId, input.awayTeamId);
    const [g] = await tx
      .insert(games)
      .values({
        seasonId,
        divisionId: input.divisionId,
        homeTeamId: input.homeTeamId,
        awayTeamId: input.awayTeamId,
        startsAt,
        location: input.location,
        notes: input.notes || null,
        ticketUrl: input.ticketUrl || null,
        createdBy: actor.userId,
      })
      .returning();
    await writeAudit(tx, { actorUserId: actor.userId, action: "game.create", targetType: "game", targetId: g!.id, after: g, requestId: actor.requestId, ipAddress: actor.ip });
    return g!;
  });
}

export interface GameUpdate {
  homeTeamId: string;
  awayTeamId: string;
  startsAt: string;
  location: string;
  notes?: string | null;
  ticketUrl?: string | null;
  status: "scheduled" | "cancelled" | "postponed";
  /** Email both teams about the change. */
  notify?: boolean;
}

export async function updateGame(actor: Actor, id: string, input: GameUpdate) {
  const startsAt = when(input.startsAt);
  const { before, after } = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(games).where(eq(games.id, id)).for("update");
    if (!before) throw new HttpError(404, "NOT_FOUND", "Game not found.");
    if (before.status === "final") throw new HttpError(409, "CONFLICT", "Clear the score before changing a final game.");
    await teamsInDivision(tx, before.divisionId, input.homeTeamId, input.awayTeamId);
    const [after] = await tx
      .update(games)
      .set({
        homeTeamId: input.homeTeamId,
        awayTeamId: input.awayTeamId,
        startsAt,
        location: input.location,
        notes: input.notes || null,
        ticketUrl: input.ticketUrl || null,
        status: input.status,
        updatedAt: new Date(),
      })
      .where(eq(games.id, id))
      .returning();
    await writeAudit(tx, { actorUserId: actor.userId, action: "game.update", targetType: "game", targetId: id, before, after, requestId: actor.requestId, ipAddress: actor.ip });
    return { before, after: after! };
  });
  if (input.notify) await notifyGameChange(actor, before, after);
  return after;
}

async function notifyGameChange(actor: Actor, before: typeof games.$inferSelect, g: typeof games.$inferSelect) {
  const ts = await db.select().from(teams).where(inArray(teams.id, [g.homeTeamId, g.awayTeamId]));
  const name = (id: string) => ts.find((t) => t.id === id)?.name ?? "TBD";
  const matchup = `${name(g.homeTeamId)} vs ${name(g.awayTeamId)}`;
  const lines =
    g.status === "cancelled"
      ? [`The game ${matchup} on ${leagueLabel(before.startsAt)} is cancelled.`]
      : g.status === "postponed"
        ? [`The game ${matchup} on ${leagueLabel(before.startsAt)} is postponed. We'll send the new date when it's set.`]
        : [`Game update: ${matchup}.`, `When: ${leagueLabel(g.startsAt)}`, `Where: ${g.location}`];
  if (g.notes) lines.push(g.notes);
  const subject = g.status === "cancelled" ? `Game cancelled: ${matchup}` : g.status === "postponed" ? `Game postponed: ${matchup}` : `Game update: ${matchup}`;
  const teamIds = [...new Set([before.homeTeamId, before.awayTeamId, g.homeTeamId, g.awayTeamId])];
  for (const teamId of teamIds) {
    await sendAnnouncement(actor, { audience: "team", teamId, subject, body: lines.join("\n\n") }, { skipRateLimit: true });
  }
}

export async function recordScore(actor: Actor, id: string, homeScore: number, awayScore: number) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(games).where(eq(games.id, id)).for("update");
    if (!before) throw new HttpError(404, "NOT_FOUND", "Game not found.");
    if (before.status === "cancelled") throw new HttpError(409, "CONFLICT", "This game is cancelled.");
    const [after] = await tx.update(games).set({ homeScore, awayScore, status: "final", updatedAt: new Date() }).where(eq(games.id, id)).returning();
    await writeAudit(tx, { actorUserId: actor.userId, action: "game.score", targetType: "game", targetId: id, before, after, requestId: actor.requestId, ipAddress: actor.ip });
    return after!;
  });
}

export async function clearScore(actor: Actor, id: string) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(games).where(eq(games.id, id)).for("update");
    if (!before) throw new HttpError(404, "NOT_FOUND", "Game not found.");
    const [after] = await tx.update(games).set({ homeScore: null, awayScore: null, status: "scheduled", updatedAt: new Date() }).where(eq(games.id, id)).returning();
    await writeAudit(tx, { actorUserId: actor.userId, action: "game.score_cleared", targetType: "game", targetId: id, before, after, requestId: actor.requestId, ipAddress: actor.ip });
    return after!;
  });
}

export async function deleteGame(actor: Actor, id: string) {
  await db.transaction(async (tx) => {
    const [before] = await tx.delete(games).where(eq(games.id, id)).returning();
    if (!before) throw new HttpError(404, "NOT_FOUND", "Game not found.");
    await writeAudit(tx, { actorUserId: actor.userId, action: "game.delete", targetType: "game", targetId: id, before, requestId: actor.requestId, ipAddress: actor.ip });
  });
}

function gameRow(g: typeof games.$inferSelect, teamName: (id: string) => string) {
  return {
    id: g.id,
    divisionId: g.divisionId,
    homeTeamId: g.homeTeamId,
    awayTeamId: g.awayTeamId,
    home: teamName(g.homeTeamId),
    away: teamName(g.awayTeamId),
    startsAt: g.startsAt,
    startsAtLocal: utcToLeagueLocal(g.startsAt),
    location: g.location,
    status: g.status,
    homeScore: g.homeScore,
    awayScore: g.awayScore,
    notes: g.notes,
    ticketUrl: g.ticketUrl,
  };
}

/** Games for a season (optionally one division), oldest first. */
export async function listGames(seasonId: string, divisionId?: string) {
  const rows = await db
    .select()
    .from(games)
    .where(and(eq(games.seasonId, seasonId), divisionId ? eq(games.divisionId, divisionId) : undefined))
    .orderBy(asc(games.startsAt));
  const ts = await db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.seasonId, seasonId));
  const name = (id: string) => ts.find((t) => t.id === id)?.name ?? "—";
  return rows.map((g) => gameRow(g, name));
}

/* ---------------- CSV import ---------------- */

const HEADER_ALIASES: Record<string, string> = {
  date: "date",
  day: "date",
  time: "time",
  "start time": "time",
  division: "division",
  home: "home",
  "home team": "home",
  away: "away",
  "away team": "away",
  visitor: "away",
  location: "location",
  field: "location",
  notes: "notes",
  tickets: "tickets",
  "ticket link": "tickets",
  "ticket url": "tickets",
};

function parseDate(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${y}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  }
  return null;
}

function parseTime(s: string): string | null {
  const t = s.trim().toLowerCase().replace(/\s+/g, "");
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm|a|p)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2] ?? "0");
  const ap = m[3];
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap.startsWith("p") && h !== 12) h += 12;
    if (ap.startsWith("a") && h === 12) h = 0;
  } else if (!m[2]) return null; // "9" alone is ambiguous
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

export interface ImportRow {
  line: number;
  date: string;
  time: string;
  division: string;
  home: string;
  away: string;
  location: string;
  notes: string;
  tickets: string;
  error?: string;
  duplicate?: boolean;
}

/**
 * Checks every row, then (unless dryRun) adds them all in one transaction.
 * Rows that exactly match an existing game (same teams and time) are skipped.
 * Any error means nothing is added.
 */
export async function importGames(actor: Actor, seasonId: string, csv: string, dryRun: boolean) {
  const table = parseCsv(csv);
  if (table.length < 2) throw new HttpError(400, "VALIDATION_FAILED", "The file needs a header row and at least one game.");
  if (table.length > 1001) throw new HttpError(400, "VALIDATION_FAILED", "Import up to 1,000 games at a time.");
  const header = table[0]!.map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? "");
  const missing = ["date", "time", "division", "home", "away", "location"].filter((k) => !header.includes(k));
  if (missing.length) throw new HttpError(400, "VALIDATION_FAILED", `Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`);

  const divs = await db.select().from(divisions).where(eq(divisions.seasonId, seasonId));
  const ts = await db.select().from(teams).where(eq(teams.seasonId, seasonId));
  const existing = await db.select().from(games).where(eq(games.seasonId, seasonId));
  const norm = (s: string) => s.trim().toLowerCase();

  const rows: (ImportRow & { values?: typeof games.$inferInsert })[] = [];
  const seen = new Set<string>();
  table.slice(1).forEach((cells, i) => {
    const get = (k: string) => (cells[header.indexOf(k)] ?? "").trim();
    const r: ImportRow & { values?: typeof games.$inferInsert } = {
      line: i + 2,
      date: get("date"),
      time: get("time"),
      division: get("division"),
      home: get("home"),
      away: get("away"),
      location: get("location"),
      notes: header.includes("notes") ? get("notes") : "",
      tickets: header.includes("tickets") ? get("tickets") : "",
    };
    const errs: string[] = [];
    const div = divs.find((d) => norm(d.name) === norm(r.division));
    if (!div) errs.push(`unknown division "${r.division}"`);
    const team = (n: string) => (div ? ts.find((t) => t.divisionId === div.id && norm(t.name) === norm(n)) : undefined);
    const home = team(r.home);
    const away = team(r.away);
    if (div && !home) errs.push(`no team "${r.home}" in ${div.name}`);
    if (div && !away) errs.push(`no team "${r.away}" in ${div.name}`);
    if (home && away && home.id === away.id) errs.push("home and away are the same team");
    const date = parseDate(r.date);
    const time = parseTime(r.time);
    if (!date) errs.push(`date "${r.date}" (use 1/10/2027 or 2027-01-10)`);
    if (!time) errs.push(`time "${r.time}" (use 9:00 AM or 13:30)`);
    const startsAt = date && time ? leagueLocalToUtc(`${date}T${time}`) : null;
    if (date && time && !startsAt) errs.push("that date and time doesn't exist");
    if (!r.location) errs.push("location is empty");
    if (r.location.length > 200 || r.notes.length > 500) errs.push("location or notes too long");
    if (r.tickets && !isTicketUrl(r.tickets)) errs.push("ticket link must start with https://");
    if (errs.length) r.error = errs.join("; ");
    else {
      const key = `${home!.id}|${away!.id}|${startsAt!.getTime()}`;
      const dup =
        seen.has(key) ||
        existing.some((g) => g.homeTeamId === home!.id && g.awayTeamId === away!.id && g.startsAt.getTime() === startsAt!.getTime());
      seen.add(key);
      if (dup) r.duplicate = true;
      else
        r.values = {
          seasonId,
          divisionId: div!.id,
          homeTeamId: home!.id,
          awayTeamId: away!.id,
          startsAt: startsAt!,
          location: r.location,
          notes: r.notes || null,
          ticketUrl: r.tickets || null,
          createdBy: actor.userId,
        };
    }
    rows.push(r);
  });

  const errors = rows.filter((r) => r.error).length;
  const toAdd = rows.filter((r) => r.values);
  let added = 0;
  if (!dryRun && errors === 0 && toAdd.length) {
    await db.transaction(async (tx) => {
      await tx.insert(games).values(toAdd.map((r) => r.values!));
      await writeAudit(tx, {
        actorUserId: actor.userId,
        action: "game.import",
        targetType: "season",
        targetId: seasonId,
        after: { games: toAdd.length },
        requestId: actor.requestId,
        ipAddress: actor.ip,
      });
    });
    added = toAdd.length;
  }
  return {
    rows: rows.map(({ values: _v, ...r }) => r),
    errors,
    duplicates: rows.filter((r) => r.duplicate).length,
    ready: toAdd.length,
    added,
  };
}

/* ---------------- public schedule + standings ---------------- */

export async function currentSeasonId() {
  const [s] = await db.select({ id: seasons.id, name: seasons.name }).from(seasons).where(eq(seasons.isCurrent, "current")).limit(1);
  return s ?? null;
}

export interface StandingRow {
  teamId: string;
  team: string;
  gp: number;
  w: number;
  l: number;
  t: number;
  pf: number;
  pa: number;
  pct: number;
}

export function computeStandings(ts: { id: string; name: string }[], finals: { homeTeamId: string; awayTeamId: string; homeScore: number | null; awayScore: number | null }[]) {
  const rows = new Map<string, StandingRow>(ts.map((t) => [t.id, { teamId: t.id, team: t.name, gp: 0, w: 0, l: 0, t: 0, pf: 0, pa: 0, pct: 0 }]));
  for (const g of finals) {
    const h = rows.get(g.homeTeamId);
    const a = rows.get(g.awayTeamId);
    if (!h || !a || g.homeScore === null || g.awayScore === null) continue;
    h.gp++;
    a.gp++;
    h.pf += g.homeScore;
    h.pa += g.awayScore;
    a.pf += g.awayScore;
    a.pa += g.homeScore;
    if (g.homeScore > g.awayScore) {
      h.w++;
      a.l++;
    } else if (g.homeScore < g.awayScore) {
      a.w++;
      h.l++;
    } else {
      h.t++;
      a.t++;
    }
  }
  for (const r of rows.values()) r.pct = r.gp ? (r.w + r.t / 2) / r.gp : 0;
  return [...rows.values()].sort((x, y) => y.pct - x.pct || y.w - x.w || y.pf - y.pa - (x.pf - x.pa) || x.team.localeCompare(y.team));
}

/** Public: every division in the season with its games and standings. */
export async function publicSchedule(seasonId: string) {
  const divs = await db
    .select({ id: divisions.id, name: divisions.name })
    .from(divisions)
    .where(and(eq(divisions.seasonId, seasonId), sql`${divisions.status} <> 'draft'`))
    .orderBy(asc(divisions.sortOrder), asc(divisions.name));
  const ts = await db.select({ id: teams.id, name: teams.name, divisionId: teams.divisionId }).from(teams).where(eq(teams.seasonId, seasonId)).orderBy(asc(teams.name));
  const gs = await db.select().from(games).where(eq(games.seasonId, seasonId)).orderBy(asc(games.startsAt));
  const name = (id: string) => ts.find((t) => t.id === id)?.name ?? "—";
  return divs.map((d) => {
    const dg = gs.filter((g) => g.divisionId === d.id);
    return {
      id: d.id,
      name: d.name,
      games: dg.map((g) => {
        const { notes: _n, ...row } = gameRow(g, name);
        return row;
      }),
      standings: computeStandings(
        ts.filter((t) => t.divisionId === d.id),
        dg.filter((g) => g.status === "final"),
      ),
    };
  });
}

/* ---------------- practices ---------------- */

export interface PracticeInput {
  startsAt: string;
  durationMinutes: number;
  location: string;
  notes?: string | null;
}

export async function listPractices(teamId: string) {
  const rows = await db.select().from(practices).where(eq(practices.teamId, teamId)).orderBy(asc(practices.startsAt));
  return rows.map((p) => ({ ...p, startsAtLocal: utcToLeagueLocal(p.startsAt) }));
}

export async function createPractice(actor: Actor, teamId: string, input: PracticeInput) {
  const startsAt = when(input.startsAt);
  const [p] = await db
    .insert(practices)
    .values({ teamId, startsAt, durationMinutes: input.durationMinutes, location: input.location, notes: input.notes || null, createdBy: actor.userId })
    .returning();
  return p!;
}

async function practiceOnTeam(conn: DbOrTx, teamId: string, id: string) {
  const [p] = await conn.select().from(practices).where(and(eq(practices.id, id), eq(practices.teamId, teamId)));
  if (!p) throw new HttpError(404, "NOT_FOUND", "Practice not found.");
  return p;
}

export async function updatePractice(actor: Actor, teamId: string, id: string, input: PracticeInput & { status: "scheduled" | "cancelled"; notify?: boolean }) {
  const startsAt = when(input.startsAt);
  const before = await practiceOnTeam(db, teamId, id);
  const [after] = await db
    .update(practices)
    .set({ startsAt, durationMinutes: input.durationMinutes, location: input.location, notes: input.notes || null, status: input.status, updatedAt: new Date() })
    .where(eq(practices.id, id))
    .returning();
  if (input.notify) {
    const cancelled = after!.status === "cancelled";
    const lines = cancelled
      ? [`Practice on ${leagueLabel(before.startsAt)} is cancelled.`]
      : [`Practice update.`, `When: ${leagueLabel(after!.startsAt)} (${after!.durationMinutes} min)`, `Where: ${after!.location}`];
    if (after!.notes) lines.push(after!.notes);
    await sendAnnouncement(actor, { audience: "team", teamId, subject: cancelled ? "Practice cancelled" : "Practice update", body: lines.join("\n\n") }, { skipRateLimit: true });
  }
  return after!;
}

export async function deletePractice(teamId: string, id: string) {
  await practiceOnTeam(db, teamId, id);
  await db.delete(practices).where(eq(practices.id, id));
}

export interface PracticeSeriesInput {
  startDate: string; // YYYY-MM-DD
  endDate: string;
  weekdays: number[]; // 0 = Sunday … 6 = Saturday
  time: string; // HH:mm
  durationMinutes: number;
  location: string;
  notes?: string | null;
}

const MAX_SERIES = 100;

/** Every date (league calendar) from start to end that falls on one of the weekdays. */
export function seriesDates(startDate: string, endDate: string, weekdays: number[]) {
  const [sy, sm, sd] = startDate.split("-").map(Number) as [number, number, number];
  const [ey, em, ed] = endDate.split("-").map(Number) as [number, number, number];
  const start = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  const out: string[] = [];
  for (let t = start; t <= end; t += 86400_000) {
    if (weekdays.includes(new Date(t).getUTCDay())) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Weekly practices on the chosen days between two dates, each saved as its own practice. */
export async function createPracticeSeries(actor: Actor, teamId: string, input: PracticeSeriesInput) {
  if (input.endDate < input.startDate) throw new HttpError(400, "VALIDATION_FAILED", "The end date is before the start date.");
  const dates = seriesDates(input.startDate, input.endDate, input.weekdays);
  if (!dates.length) throw new HttpError(400, "VALIDATION_FAILED", "None of those days fall between the start and end dates.");
  if (dates.length > MAX_SERIES) throw new HttpError(400, "VALIDATION_FAILED", `That's ${dates.length} practices. Add up to ${MAX_SERIES} at a time.`);
  const times = dates.map((d) => leagueLocalToUtc(`${d}T${input.time}`));
  if (times.some((t) => !t)) throw new HttpError(400, "VALIDATION_FAILED", "Enter a valid time.");
  const seriesId = randomUUID();
  const rows = await db
    .insert(practices)
    .values(
      times.map((startsAt) => ({
        teamId,
        startsAt: startsAt!,
        durationMinutes: input.durationMinutes,
        location: input.location,
        notes: input.notes || null,
        seriesId,
        createdBy: actor.userId,
      })),
    )
    .returning({ id: practices.id });
  return { seriesId, count: rows.length };
}

/** Deletes this practice and every later one in its series (earlier ones stay). */
export async function deletePracticeSeriesFrom(teamId: string, id: string) {
  const p = await practiceOnTeam(db, teamId, id);
  if (!p.seriesId) {
    await db.delete(practices).where(eq(practices.id, id));
    return 1;
  }
  const gone = await db
    .delete(practices)
    .where(and(eq(practices.teamId, teamId), eq(practices.seriesId, p.seriesId), gte(practices.startsAt, p.startsAt)))
    .returning({ id: practices.id });
  return gone.length;
}

/* ---------------- announcements ---------------- */

export interface AnnouncementInput {
  audience: "team" | "division" | "league";
  teamId?: string;
  divisionId?: string;
  subject: string;
  body: string;
}

const ACTIVE = ["paid", "approved"];

/** Distinct user ids who should get an announcement. */
async function recipients(seasonId: string, a: AnnouncementInput): Promise<string[]> {
  const ids = new Set<string>();
  if (a.audience === "team") {
    const fam = await db
      .selectDistinct({ id: householdMembers.userId })
      .from(rosterEntries)
      .innerJoin(players, eq(players.id, rosterEntries.playerId))
      .innerJoin(householdMembers, eq(householdMembers.householdId, players.householdId))
      .where(eq(rosterEntries.teamId, a.teamId!));
    const staff = await db.select({ id: teamStaff.userId }).from(teamStaff).where(eq(teamStaff.teamId, a.teamId!));
    for (const r of [...fam, ...staff]) ids.add(r.id);
  } else {
    const scope = a.audience === "division" ? eq(registrations.divisionId, a.divisionId!) : eq(registrations.seasonId, seasonId);
    const fam = await db
      .selectDistinct({ id: householdMembers.userId })
      .from(registrations)
      .innerJoin(householdMembers, eq(householdMembers.householdId, registrations.householdId))
      .where(and(scope, inArray(registrations.status, ACTIVE)));
    const staff = await db
      .selectDistinct({ id: teamStaff.userId })
      .from(teamStaff)
      .innerJoin(teams, eq(teams.id, teamStaff.teamId))
      .where(a.audience === "division" ? eq(teams.divisionId, a.divisionId!) : eq(teams.seasonId, seasonId));
    for (const r of [...fam, ...staff]) ids.add(r.id);
  }
  return [...ids];
}

const HOURLY_LIMIT = 10;

export async function sendAnnouncement(actor: Actor, a: AnnouncementInput, opts: { skipRateLimit?: boolean } = {}) {
  let seasonId: string;
  if (a.audience === "team") {
    const [t] = await db.select({ seasonId: teams.seasonId, divisionId: teams.divisionId }).from(teams).where(eq(teams.id, a.teamId!));
    if (!t) throw new HttpError(404, "NOT_FOUND", "Team not found.");
    seasonId = t.seasonId;
    a = { ...a, divisionId: t.divisionId };
  } else if (a.audience === "division") {
    const [d] = await db.select({ seasonId: divisions.seasonId }).from(divisions).where(eq(divisions.id, a.divisionId!));
    if (!d) throw new HttpError(404, "NOT_FOUND", "Division not found.");
    seasonId = d.seasonId;
  } else {
    const s = await currentSeasonId();
    if (!s) throw new HttpError(409, "CONFLICT", "There's no current season.");
    seasonId = s.id;
  }
  if (!opts.skipRateLimit) {
    const [{ n }] = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(announcements)
      .where(and(eq(announcements.sentBy, actor.userId), gte(announcements.createdAt, new Date(Date.now() - 3600_000))))) as [{ n: number }];
    if (n >= HOURLY_LIMIT) throw new HttpError(429, "RATE_LIMITED", "You've sent several announcements in the last hour. Try again later.");
  }
  const ids = await recipients(seasonId, a);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(announcements)
      .values({
        seasonId,
        audience: a.audience,
        teamId: a.audience === "team" ? a.teamId! : null,
        divisionId: a.audience === "league" ? null : (a.divisionId ?? null),
        subject: a.subject,
        body: a.body,
        sentBy: actor.userId,
        recipientCount: ids.length,
      })
      .returning();
    for (const userId of ids) {
      await publish(tx, {
        name: "announcement.sent",
        aggregateType: "announcement",
        aggregateId: row!.id,
        payload: { userId },
        dedupeKey: `announcement:${row!.id}:${userId}`,
      });
    }
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "announcement.send",
      targetType: a.audience,
      targetId: a.teamId ?? a.divisionId ?? seasonId,
      after: { id: row!.id, subject: a.subject, recipients: ids.length },
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    return row!;
  });
}

export async function listAnnouncements(filter: { teamId?: string; seasonId?: string }, limit = 30) {
  return db
    .select({
      id: announcements.id,
      audience: announcements.audience,
      teamId: announcements.teamId,
      divisionId: announcements.divisionId,
      subject: announcements.subject,
      body: announcements.body,
      recipientCount: announcements.recipientCount,
      createdAt: announcements.createdAt,
      sentBy: user.name,
    })
    .from(announcements)
    .leftJoin(user, eq(user.id, announcements.sentBy))
    .where(filter.teamId ? eq(announcements.teamId, filter.teamId) : filter.seasonId ? eq(announcements.seasonId, filter.seasonId) : undefined)
    .orderBy(desc(announcements.createdAt))
    .limit(limit);
}

/* ---------------- a family's / staff member's schedule ---------------- */

/**
 * Teams the signed-in person follows: their children's teams (rosters
 * published) and teams they coach. Each with the season's games and practices.
 */
export async function mySchedule(userId: string) {
  const kids = await db
    .select({ teamId: rosterEntries.teamId, player: players.firstName })
    .from(rosterEntries)
    .innerJoin(players, eq(players.id, rosterEntries.playerId))
    .innerJoin(householdMembers, and(eq(householdMembers.householdId, players.householdId), eq(householdMembers.userId, userId)))
    .innerJoin(drafts, and(eq(drafts.divisionId, rosterEntries.divisionId), isNotNull(drafts.publishedAt)));
  const coached = await db
    .select({ teamId: teamStaff.teamId })
    .from(teamStaff)
    .innerJoin(teams, eq(teams.id, teamStaff.teamId))
    .innerJoin(drafts, and(eq(drafts.divisionId, teams.divisionId), isNotNull(drafts.publishedAt)))
    .where(eq(teamStaff.userId, userId));
  const teamIds = [...new Set([...kids.map((k) => k.teamId), ...coached.map((c) => c.teamId)])];
  if (!teamIds.length) return [];
  const ts = await db
    .select({ id: teams.id, name: teams.name, divisionName: divisions.name, seasonId: teams.seasonId })
    .from(teams)
    .innerJoin(divisions, eq(divisions.id, teams.divisionId))
    .where(inArray(teams.id, teamIds));
  const gs = await db
    .select()
    .from(games)
    .where(or(inArray(games.homeTeamId, teamIds), inArray(games.awayTeamId, teamIds)))
    .orderBy(asc(games.startsAt));
  const opp = gs.length
    ? await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, [...new Set(gs.flatMap((g) => [g.homeTeamId, g.awayTeamId]))]))
    : [];
  const name = (id: string) => opp.find((t) => t.id === id)?.name ?? "—";
  const ps = await db
    .select()
    .from(practices)
    .where(inArray(practices.teamId, teamIds))
    .orderBy(asc(practices.startsAt));
  return ts.map((t) => ({
    team: { id: t.id, name: t.name, divisionName: t.divisionName },
    players: kids.filter((k) => k.teamId === t.id).map((k) => k.player),
    coaching: coached.some((c) => c.teamId === t.id),
    games: gs.filter((g) => g.homeTeamId === t.id || g.awayTeamId === t.id).map((g) => gameRow(g, name)),
    practices: ps.filter((p) => p.teamId === t.id).map(({ createdBy: _c, ...p }) => p),
  }));
}
