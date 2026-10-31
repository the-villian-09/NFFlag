/** Teams and the draft (admin), and "My team" for coaches and team moms. */
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { Router, type Request } from "express";
import { z } from "zod";
import { db } from "../../db/client.js";
import {
  divisions,
  drafts,
  householdMembers,
  households,
  playerMedical,
  players,
  rosterEntries,
  seasons,
  teams,
  teamStaff,
  user,
} from "../../db/schema/index.js";
import { adminIdleTimeout, handler, requireAuth, requireMfa, requirePermission } from "../../http/context.js";
import { HttpError } from "../../http/errors.js";
import { can } from "../platform/access.js";
import { writeAudit } from "../platform/audit.js";
import {
  addToTeam,
  assignStaff,
  completeDraft,
  createTeam,
  deleteTeam,
  draftBoard,
  makePick,
  moveRosterEntry,
  publishRosters,
  removeRosterEntry,
  removeStaff,
  setDraftOrder,
  staffPool,
  startDraft,
  undoPick,
  updateTeam,
} from "./service.js";

const actorOf = (req: Request) => ({ userId: req.ctx.auth!.user.id, requestId: req.ctx.requestId, ip: req.ctx.ip });
const teamInput = z.object({ name: z.string().trim().min(1).max(60), color: z.string().trim().max(30).optional() });

/* ---------------- admin ---------------- */

export const adminTeamsRouter = Router();
adminTeamsRouter.use(requireAuth, requireMfa, adminIdleTimeout);

/** Every division in a season with its teams, staff and draft status. */
adminTeamsRouter.get(
  "/seasons/:seasonId",
  requirePermission("teams.manage"),
  handler(async (req, res) => {
    const seasonId = String(req.params.seasonId);
    const divs = await db.select().from(divisions).where(eq(divisions.seasonId, seasonId)).orderBy(asc(divisions.sortOrder), asc(divisions.name));
    const ts = await db.select().from(teams).where(eq(teams.seasonId, seasonId)).orderBy(asc(teams.sortOrder), asc(teams.name));
    const staff = ts.length
      ? await db
          .select({ teamId: teamStaff.teamId, userId: teamStaff.userId, roleKey: teamStaff.roleKey, name: user.name, email: user.email })
          .from(teamStaff)
          .innerJoin(user, eq(user.id, teamStaff.userId))
          .where(inArray(teamStaff.teamId, ts.map((t) => t.id)))
      : [];
    const items = await Promise.all(
      divs.map(async (d) => {
        const board = await draftBoard(d.id);
        return {
          id: d.id,
          name: d.name,
          status: d.status,
          draft: board.draft,
          available: board.available.length,
          awaitingReview: board.awaitingReview,
          teams: ts
            .filter((t) => t.divisionId === d.id)
            .map((t) => ({ ...t, staff: staff.filter((s) => s.teamId === t.id), players: board.roster.filter((r) => r.teamId === t.id).length })),
        };
      }),
    );
    res.json({ items, staffPool: await staffPool(seasonId) });
  }),
);

adminTeamsRouter.post(
  "/divisions/:divisionId/teams",
  requirePermission("teams.manage"),
  handler(async (req, res) => {
    res.status(201).json({ team: await createTeam(actorOf(req), String(req.params.divisionId), teamInput.parse(req.body)) });
  }),
);

adminTeamsRouter.put(
  "/teams/:id",
  requirePermission("teams.manage"),
  handler(async (req, res) => {
    res.json({ team: await updateTeam(actorOf(req), String(req.params.id), teamInput.parse(req.body)) });
  }),
);

adminTeamsRouter.delete(
  "/teams/:id",
  requirePermission("teams.manage"),
  handler(async (req, res) => {
    await deleteTeam(actorOf(req), String(req.params.id));
    res.json({ ok: true });
  }),
);

adminTeamsRouter.post(
  "/teams/:id/staff",
  requirePermission("teams.manage"),
  handler(async (req, res) => {
    const input = z.object({ userId: z.string().min(1).max(100), roleKey: z.enum(["head_coach", "assistant_coach", "team_manager"]) }).parse(req.body);
    res.json(await assignStaff(actorOf(req), String(req.params.id), input));
  }),
);

adminTeamsRouter.delete(
  "/teams/:id/staff/:userId",
  requirePermission("teams.manage"),
  handler(async (req, res) => {
    await removeStaff(actorOf(req), String(req.params.id), String(req.params.userId));
    res.json({ ok: true });
  }),
);

adminTeamsRouter.post(
  "/teams/:id/roster",
  requirePermission("teams.manage"),
  handler(async (req, res) => {
    const { registrationId } = z.object({ registrationId: z.uuid() }).parse(req.body);
    res.status(201).json({ entry: await addToTeam(actorOf(req), String(req.params.id), registrationId) });
  }),
);

adminTeamsRouter.post(
  "/roster/:entryId/move",
  requirePermission("teams.manage"),
  handler(async (req, res) => {
    const { teamId } = z.object({ teamId: z.uuid() }).parse(req.body);
    res.json({ entry: await moveRosterEntry(actorOf(req), String(req.params.entryId), teamId) });
  }),
);

adminTeamsRouter.delete(
  "/roster/:entryId",
  requirePermission("teams.manage"),
  handler(async (req, res) => {
    await removeRosterEntry(actorOf(req), String(req.params.entryId));
    res.json({ ok: true });
  }),
);

/* draft */

adminTeamsRouter.get(
  "/divisions/:divisionId/draft",
  requirePermission("draft.run"),
  handler(async (req, res) => {
    res.set("cache-control", "no-store");
    res.json(await draftBoard(String(req.params.divisionId)));
  }),
);

adminTeamsRouter.put(
  "/divisions/:divisionId/draft/order",
  requirePermission("draft.run"),
  handler(async (req, res) => {
    const { order } = z.object({ order: z.array(z.uuid()).max(64) }).parse(req.body);
    await setDraftOrder(actorOf(req), String(req.params.divisionId), order);
    res.json(await draftBoard(String(req.params.divisionId)));
  }),
);

for (const [path, fn] of [
  ["start", startDraft],
  ["undo", undoPick],
  ["complete", completeDraft],
  ["publish", publishRosters],
] as const) {
  adminTeamsRouter.post(
    `/divisions/:divisionId/draft/${path}`,
    requirePermission("draft.run"),
    handler(async (req, res) => {
      await (fn as (a: ReturnType<typeof actorOf>, d: string) => Promise<unknown>)(actorOf(req), String(req.params.divisionId));
      res.json(await draftBoard(String(req.params.divisionId)));
    }),
  );
}

adminTeamsRouter.post(
  "/divisions/:divisionId/draft/pick",
  requirePermission("draft.run"),
  handler(async (req, res) => {
    const input = z.object({ registrationId: z.uuid(), expectedPick: z.number().int().min(1).optional() }).parse(req.body);
    await makePick(actorOf(req), String(req.params.divisionId), input);
    res.json(await draftBoard(String(req.params.divisionId)));
  }),
);

/* ---------------- coaches & team moms ---------------- */

export const myTeamsRouter = Router();

/** Teams the signed-in person coaches or manages (rosters must be published). */
myTeamsRouter.get(
  "/my-teams",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    const rows = await db
      .select({ id: teams.id, name: teams.name, roleKey: teamStaff.roleKey, divisionName: divisions.name, seasonName: seasons.name })
      .from(teamStaff)
      .innerJoin(teams, eq(teams.id, teamStaff.teamId))
      .innerJoin(divisions, eq(divisions.id, teams.divisionId))
      .innerJoin(seasons, eq(seasons.id, teams.seasonId))
      .innerJoin(drafts, and(eq(drafts.divisionId, teams.divisionId), isNotNull(drafts.publishedAt)))
      .where(eq(teamStaff.userId, req.ctx.auth!.user.id))
      .orderBy(asc(divisions.name));
    res.json({ items: rows });
  }),
);

myTeamsRouter.get(
  "/my-teams/:teamId",
  requireAuth,
  requireMfa,
  requirePermission("roster.read", (req) => ({ type: "team", id: String(req.params.teamId) })),
  handler(async (req, res) => {
    const teamId = String(req.params.teamId);
    const [t] = await db
      .select({ id: teams.id, name: teams.name, divisionId: teams.divisionId, divisionName: divisions.name, publishedAt: drafts.publishedAt })
      .from(teams)
      .innerJoin(divisions, eq(divisions.id, teams.divisionId))
      .leftJoin(drafts, eq(drafts.divisionId, teams.divisionId))
      .where(eq(teams.id, teamId));
    if (!t) throw new HttpError(404, "NOT_FOUND", "Team not found.");
    const admin = req.ctx.access!.leagueWide.has("roster.read");
    if (!t.publishedAt && !admin) throw new HttpError(403, "FORBIDDEN", "Rosters aren't published yet.");

    const roster = await db
      .select({
        entryId: rosterEntries.id,
        playerId: players.id,
        firstName: players.firstName,
        lastName: players.lastName,
        preferredName: players.preferredName,
        birthDate: players.birthDate,
        shirtSize: players.shirtSize,
        householdId: players.householdId,
        householdName: households.displayName,
        householdPhone: households.phone,
      })
      .from(rosterEntries)
      .innerJoin(players, eq(players.id, rosterEntries.playerId))
      .innerJoin(households, eq(households.id, players.householdId))
      .where(eq(rosterEntries.teamId, teamId))
      .orderBy(asc(players.lastName), asc(players.firstName));
    const householdIds = [...new Set(roster.map((r) => r.householdId))];
    const guardians = householdIds.length
      ? await db
          .select({ householdId: householdMembers.householdId, name: user.name, email: user.email })
          .from(householdMembers)
          .innerJoin(user, eq(user.id, householdMembers.userId))
          .where(inArray(householdMembers.householdId, householdIds))
      : [];
    const staff = await db
      .select({ userId: teamStaff.userId, roleKey: teamStaff.roleKey, name: user.name, email: user.email })
      .from(teamStaff)
      .innerJoin(user, eq(user.id, teamStaff.userId))
      .where(eq(teamStaff.teamId, teamId));

    const canMedical = can(req.ctx.access!, "medical.read", { type: "team", id: teamId });
    let medical: Record<string, unknown> = {};
    if (canMedical && roster.length) {
      const rows = await db.select().from(playerMedical).where(inArray(playerMedical.playerId, roster.map((r) => r.playerId)));
      medical = Object.fromEntries(rows.map((m) => [m.playerId, m]));
      await writeAudit(db, {
        actorUserId: req.ctx.auth!.user.id,
        action: "medical.view",
        targetType: "team",
        targetId: teamId,
        after: { players: roster.length },
        requestId: req.ctx.requestId,
        ipAddress: req.ctx.ip,
      });
    }
    res.set("cache-control", "no-store");
    res.json({
      team: { id: t.id, name: t.name, divisionName: t.divisionName },
      staff,
      roster: roster.map(({ householdId, ...r }) => ({ ...r, guardians: guardians.filter((g) => g.householdId === householdId).map(({ name, email }) => ({ name, email })), medical: medical[r.playerId] ?? null })),
      canSeeMedical: canMedical,
    });
  }),
);
