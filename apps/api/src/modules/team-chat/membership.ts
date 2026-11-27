/**
 * Who belongs to which team space. Never stored: worked out from the rosters
 * and team staff every time, so access follows roster changes at once.
 *
 *   staff   head coach, assistant coaches and team mom (team_staff)
 *   family  every guardian in the household of a rostered player, once the
 *           division's rosters are published
 *   admin   league admins with teams.manage: may open any team to moderate,
 *           but are not members (no unread counts, never listed)
 *
 * A team from a season that isn't the current one is read-only.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { divisions, drafts, householdMembers, players, rosterEntries, seasons, teamStaff, teams } from "../../db/schema/index.js";

export type SpaceRole = "staff" | "family" | "admin";

export interface Space {
  teamId: string;
  teamName: string;
  color: string | null;
  divisionName: string;
  seasonName: string;
  readOnly: boolean;
  role: SpaceRole;
  /** head_coach | assistant_coach | team_manager, when staff. */
  staffRole: string | null;
  /** The signed-in person's own children on this team. */
  playerIds: string[];
}

const teamCols = {
  teamId: teams.id,
  teamName: teams.name,
  color: teams.color,
  divisionName: divisions.name,
  seasonName: seasons.name,
  isCurrent: seasons.isCurrent,
};

/** Every team space this person belongs to (staff or family), current season first. */
export async function spacesFor(userId: string): Promise<Space[]> {
  const staff = await db
    .select({ ...teamCols, staffRole: teamStaff.roleKey })
    .from(teamStaff)
    .innerJoin(teams, eq(teams.id, teamStaff.teamId))
    .innerJoin(divisions, eq(divisions.id, teams.divisionId))
    .innerJoin(seasons, eq(seasons.id, teams.seasonId))
    .where(eq(teamStaff.userId, userId));

  const family = await db
    .select({ ...teamCols, playerId: rosterEntries.playerId })
    .from(householdMembers)
    .innerJoin(players, eq(players.householdId, householdMembers.householdId))
    .innerJoin(rosterEntries, eq(rosterEntries.playerId, players.id))
    .innerJoin(teams, eq(teams.id, rosterEntries.teamId))
    .innerJoin(divisions, eq(divisions.id, teams.divisionId))
    .innerJoin(seasons, eq(seasons.id, teams.seasonId))
    .innerJoin(drafts, and(eq(drafts.divisionId, teams.divisionId), isNotNull(drafts.publishedAt)))
    .where(eq(householdMembers.userId, userId));

  const byTeam = new Map<string, Space>();
  const base = (r: (typeof staff)[number] | (typeof family)[number]) => ({
    teamId: r.teamId,
    teamName: r.teamName,
    color: r.color,
    divisionName: r.divisionName,
    seasonName: r.seasonName,
    readOnly: r.isCurrent !== "current",
  });
  for (const r of staff) byTeam.set(r.teamId, { ...base(r), role: "staff", staffRole: r.staffRole, playerIds: [] });
  for (const r of family) {
    const s = byTeam.get(r.teamId) ?? { ...base(r), role: "family" as const, staffRole: null, playerIds: [] };
    if (!s.playerIds.includes(r.playerId)) s.playerIds.push(r.playerId);
    byTeam.set(r.teamId, s);
  }
  return [...byTeam.values()].sort((a, b) => Number(a.readOnly) - Number(b.readOnly) || a.divisionName.localeCompare(b.divisionName) || a.teamName.localeCompare(b.teamName));
}

/** This person's place in one team space, or null if they can't open it. */
export async function spaceFor(userId: string, teamId: string, isAdmin: boolean): Promise<Space | null> {
  const mine = (await spacesFor(userId)).find((s) => s.teamId === teamId);
  if (mine) return mine;
  if (!isAdmin) return null;
  const [t] = await db
    .select(teamCols)
    .from(teams)
    .innerJoin(divisions, eq(divisions.id, teams.divisionId))
    .innerJoin(seasons, eq(seasons.id, teams.seasonId))
    .where(eq(teams.id, teamId));
  if (!t) return null;
  return { teamId: t.teamId, teamName: t.teamName, color: t.color, divisionName: t.divisionName, seasonName: t.seasonName, readOnly: t.isCurrent !== "current", role: "admin", staffRole: null, playerIds: [] };
}

/** Everyone in a team space (for alerts, pushes and "seen by" counts). */
export async function teamMembers(teamId: string): Promise<{ userId: string; role: "staff" | "family" }[]> {
  const staff = await db.select({ userId: teamStaff.userId }).from(teamStaff).where(eq(teamStaff.teamId, teamId));
  const fam = await db
    .selectDistinct({ userId: householdMembers.userId })
    .from(rosterEntries)
    .innerJoin(teams, eq(teams.id, rosterEntries.teamId))
    .innerJoin(drafts, and(eq(drafts.divisionId, teams.divisionId), isNotNull(drafts.publishedAt)))
    .innerJoin(players, eq(players.id, rosterEntries.playerId))
    .innerJoin(householdMembers, eq(householdMembers.householdId, players.householdId))
    .where(eq(rosterEntries.teamId, teamId));
  const out = new Map<string, "staff" | "family">();
  for (const f of fam) out.set(f.userId, "family");
  for (const s of staff) out.set(s.userId, "staff");
  return [...out].map(([userId, role]) => ({ userId, role }));
}

/** The players on a team (for RSVPs). */
export async function teamPlayerIds(teamId: string): Promise<string[]> {
  const rows = await db.select({ id: rosterEntries.playerId }).from(rosterEntries).where(eq(rosterEntries.teamId, teamId));
  return rows.map((r) => r.id);
}

/** Team ids a person may receive live updates for, with whether they see the staff channel. */
export async function liveScopes(userId: string): Promise<Map<string, { staff: boolean }>> {
  const spaces = await spacesFor(userId);
  return new Map(spaces.filter((s) => !s.readOnly).map((s) => [s.teamId, { staff: s.role === "staff" }]));
}

