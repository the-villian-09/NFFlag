/** R4 routes: public schedule/standings, family schedule, coach practices + announcements, admin games. */
import { asc, eq } from "drizzle-orm";
import { Router, type Request } from "express";
import { z } from "zod";
import { db } from "../../db/client.js";
import { divisions, drafts, seasons, teams } from "../../db/schema/index.js";
import { adminIdleTimeout, handler, requireAuth, requireMfa, requirePermission } from "../../http/context.js";
import { HttpError } from "../../http/errors.js";
import { FLAG, isEnabled, requireFlag } from "../platform/flags.js";
import {
  clearScore,
  createGame,
  createPractice,
  createPracticeSeries,
  currentSeasonId,
  deleteGame,
  deletePractice,
  deletePracticeSeriesFrom,
  importGames,
  isTicketUrl,
  SEASON_PUBLIC,
  listAnnouncements,
  listGames,
  listPractices,
  mySchedule,
  publicSchedule,
  recordScore,
  sendAnnouncement,
  updateGame,
  updatePractice,
  type Actor,
} from "./service.js";

const actorOf = (req: Request): Actor => ({ userId: req.ctx.auth!.user.id, name: req.ctx.auth!.user.name, requestId: req.ctx.requestId, ip: req.ctx.ip });
const local = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Enter a date and time.");
const text = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().max(max).optional().nullable();
const uuid = z.uuid();

/* ---------------- public + signed-in ---------------- */

export const scheduleRouter = Router();

/** Public: games and standings for the current (or given) season. */
scheduleRouter.get(
  "/schedule",
  handler(async (req, res) => {
    const { seasonId } = z.object({ seasonId: uuid.optional() }).parse(req.query);
    let found: Awaited<ReturnType<typeof currentSeasonId>>;
    if (seasonId) {
      const [s] = await db.select(SEASON_PUBLIC).from(seasons).where(eq(seasons.id, seasonId));
      found = s ?? null;
    } else found = await currentSeasonId();
    if (!found) throw new HttpError(404, "NOT_FOUND", "No current season.");
    res.set("cache-control", "public, max-age=60");
    // Season passes are on sale until the season is over.
    const season = { id: found.id, name: found.name, seasonPassUrl: found.status === "completed" || found.status === "archived" ? null : found.seasonPassUrl };
    // Until games are switched on, the public page says the schedule is coming.
    res.json({ season, divisions: (await isEnabled(FLAG.games)) ? await publicSchedule(season.id) : [] });
  }),
);

/** Games and practices for the signed-in person's teams. */
scheduleRouter.get(
  "/my-schedule",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    res.set("cache-control", "no-store");
    const [teamsOn, gamesOn, practicesOn] = await Promise.all([isEnabled(FLAG.teams), isEnabled(FLAG.games), isEnabled(FLAG.practices)]);
    if (!teamsOn) return void res.json({ items: [] });
    const items = await mySchedule(req.ctx.auth!.user.id);
    res.json({ items: items.map((t) => ({ ...t, games: gamesOn ? t.games : [], practices: practicesOn ? t.practices : [] })) });
  }),
);

const teamScope = (req: Request) => ({ type: "team" as const, id: String(req.params.teamId) });

/** Coaches work on their team once rosters are published; league admins any time. */
async function teamOpen(req: Request) {
  const teamId = String(req.params.teamId);
  const [t] = await db
    .select({ id: teams.id, publishedAt: drafts.publishedAt })
    .from(teams)
    .leftJoin(drafts, eq(drafts.divisionId, teams.divisionId))
    .where(eq(teams.id, teamId));
  if (!t) throw new HttpError(404, "NOT_FOUND", "Team not found.");
  if (!t.publishedAt && !req.ctx.access!.leagueWide.has("roster.read")) throw new HttpError(403, "FORBIDDEN", "Rosters aren't published yet.");
  return teamId;
}

const practiceInput = z.object({
  startsAt: local,
  durationMinutes: z.number().int().min(15).max(300).default(60),
  location: text(200),
  notes: optText(500),
});

scheduleRouter.get(
  "/teams/:teamId/practices",
  requireAuth,
  requireMfa,
  requireFlag(FLAG.practices, "practices.manage"),
  requirePermission("roster.read", teamScope),
  handler(async (req, res) => {
    res.json({ items: await listPractices(await teamOpen(req)) });
  }),
);

scheduleRouter.post(
  "/teams/:teamId/practices",
  requireAuth,
  requireMfa,
  requireFlag(FLAG.practices, "practices.manage"),
  requirePermission("practices.manage", teamScope),
  handler(async (req, res) => {
    const input = practiceInput.parse(req.body);
    res.status(201).json({ practice: await createPractice(actorOf(req), await teamOpen(req), input) });
  }),
);

scheduleRouter.put(
  "/teams/:teamId/practices/:id",
  requireAuth,
  requireMfa,
  requireFlag(FLAG.practices, "practices.manage"),
  requirePermission("practices.manage", teamScope),
  handler(async (req, res) => {
    const input = practiceInput.extend({ status: z.enum(["scheduled", "cancelled"]), notify: z.boolean().optional() }).parse(req.body);
    const teamId = await teamOpen(req);
    res.json({ practice: await updatePractice(actorOf(req), teamId, uuid.parse(req.params.id), input) });
  }),
);

scheduleRouter.delete(
  "/teams/:teamId/practices/:id",
  requireAuth,
  requireMfa,
  requireFlag(FLAG.practices, "practices.manage"),
  requirePermission("practices.manage", teamScope),
  handler(async (req, res) => {
    await deletePractice(await teamOpen(req), uuid.parse(req.params.id));
    res.status(204).end();
  }),
);

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date.");

/** Weekly practices: every chosen weekday from startDate to endDate at the same time. */
scheduleRouter.post(
  "/teams/:teamId/practices/series",
  requireAuth,
  requireMfa,
  requireFlag(FLAG.practices, "practices.manage"),
  requirePermission("practices.manage", teamScope),
  handler(async (req, res) => {
    const input = z
      .object({
        startDate: day,
        endDate: day,
        weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
        time: z.string().regex(/^\d{2}:\d{2}$/, "Enter a time."),
        durationMinutes: z.number().int().min(15).max(300).default(60),
        location: text(200),
        notes: optText(500),
      })
      .parse(req.body);
    res.status(201).json(await createPracticeSeries(actorOf(req), await teamOpen(req), input));
  }),
);

/** Delete this practice and the rest of its weekly series. */
scheduleRouter.delete(
  "/teams/:teamId/practices/:id/series",
  requireAuth,
  requireMfa,
  requireFlag(FLAG.practices, "practices.manage"),
  requirePermission("practices.manage", teamScope),
  handler(async (req, res) => {
    res.json({ deleted: await deletePracticeSeriesFrom(await teamOpen(req), uuid.parse(req.params.id)) });
  }),
);

const announcementBody = z.object({ subject: text(120), body: text(5000) });

scheduleRouter.get(
  "/teams/:teamId/announcements",
  requireAuth,
  requireMfa,
  requireFlag(FLAG.announcements, "announcements.send"),
  requirePermission("roster.read", teamScope),
  handler(async (req, res) => {
    res.json({ items: await listAnnouncements({ teamId: await teamOpen(req) }) });
  }),
);

scheduleRouter.post(
  "/teams/:teamId/announcements",
  requireAuth,
  requireMfa,
  requireFlag(FLAG.announcements, "announcements.send"),
  requirePermission("announcements.send", teamScope),
  handler(async (req, res) => {
    const input = announcementBody.parse(req.body);
    const teamId = await teamOpen(req);
    const a = await sendAnnouncement(actorOf(req), { audience: "team", teamId, ...input });
    res.status(201).json({ announcement: a });
  }),
);

/* ---------------- admin ---------------- */

export const adminScheduleRouter = Router();
adminScheduleRouter.use(requireAuth, requireMfa, adminIdleTimeout);

/** Divisions + teams + games for a season (the admin schedule screen). */
adminScheduleRouter.get(
  "/seasons/:seasonId",
  requirePermission("games.manage"),
  handler(async (req, res) => {
    const seasonId = uuid.parse(req.params.seasonId);
    const divs = await db
      .select({ id: divisions.id, name: divisions.name })
      .from(divisions)
      .where(eq(divisions.seasonId, seasonId))
      .orderBy(asc(divisions.sortOrder), asc(divisions.name));
    const ts = await db.select({ id: teams.id, name: teams.name, divisionId: teams.divisionId }).from(teams).where(eq(teams.seasonId, seasonId)).orderBy(asc(teams.name));
    res.json({
      divisions: divs.map((d) => ({ ...d, teams: ts.filter((t) => t.divisionId === d.id) })),
      games: await listGames(seasonId),
    });
  }),
);

const ticketUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || isTicketUrl(v), "Ticket links must start with https://")
  .optional()
  .nullable();

const gameInput = z.object({
  divisionId: uuid,
  homeTeamId: uuid,
  awayTeamId: uuid,
  startsAt: local,
  location: text(200),
  notes: optText(500),
  ticketUrl,
});

adminScheduleRouter.post(
  "/games",
  requirePermission("games.manage"),
  handler(async (req, res) => {
    res.status(201).json({ game: await createGame(actorOf(req), gameInput.parse(req.body)) });
  }),
);

adminScheduleRouter.put(
  "/games/:id",
  requirePermission("games.manage"),
  handler(async (req, res) => {
    const input = gameInput
      .omit({ divisionId: true })
      .extend({ status: z.enum(["scheduled", "cancelled", "postponed"]), notify: z.boolean().optional() })
      .parse(req.body);
    res.json({ game: await updateGame(actorOf(req), uuid.parse(req.params.id), input) });
  }),
);

adminScheduleRouter.delete(
  "/games/:id",
  requirePermission("games.manage"),
  handler(async (req, res) => {
    await deleteGame(actorOf(req), uuid.parse(req.params.id));
    res.status(204).end();
  }),
);

const score = z.number().int().min(0).max(199);

adminScheduleRouter.put(
  "/games/:id/score",
  requirePermission("scores.enter"),
  handler(async (req, res) => {
    const { homeScore, awayScore } = z.object({ homeScore: score, awayScore: score }).parse(req.body);
    res.json({ game: await recordScore(actorOf(req), uuid.parse(req.params.id), homeScore, awayScore) });
  }),
);

adminScheduleRouter.delete(
  "/games/:id/score",
  requirePermission("scores.enter"),
  handler(async (req, res) => {
    res.json({ game: await clearScore(actorOf(req), uuid.parse(req.params.id)) });
  }),
);

adminScheduleRouter.post(
  "/seasons/:seasonId/import",
  requirePermission("games.manage"),
  handler(async (req, res) => {
    const { csv, dryRun } = z.object({ csv: z.string().min(1).max(500_000), dryRun: z.boolean().default(true) }).parse(req.body);
    res.json(await importGames(actorOf(req), uuid.parse(req.params.seasonId), csv, dryRun));
  }),
);

adminScheduleRouter.get(
  "/announcements",
  requirePermission("announcements.send"),
  handler(async (req, res) => {
    const { seasonId } = z.object({ seasonId: uuid }).parse(req.query);
    res.json({ items: await listAnnouncements({ seasonId }, 100) });
  }),
);

/** League-wide sends: everyone this season, one division, or one team. */
adminScheduleRouter.post(
  "/announcements",
  requirePermission("announcements.send"),
  handler(async (req, res) => {
    const input = z
      .discriminatedUnion("audience", [
        announcementBody.extend({ audience: z.literal("league") }),
        announcementBody.extend({ audience: z.literal("division"), divisionId: uuid }),
        announcementBody.extend({ audience: z.literal("team"), teamId: uuid }),
      ])
      .parse(req.body);
    res.status(201).json({ announcement: await sendAnnouncement(actorOf(req), input) });
  }),
);
