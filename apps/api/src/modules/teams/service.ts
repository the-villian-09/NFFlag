/**
 * Teams, staff assignment, the in-person draft and rosters (R3).
 *
 * Draft: an admin runs it live. Round 1 follows `drafts.order`; later rounds
 * snake. Children of a team's staff (coaches, team mom) are placed on that
 * team beforehand and fill its earliest slots ("coach_child"). Every pick
 * locks the division row, so two clicks can't take the same slot.
 */
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db, type Tx } from "../../db/client.js";
import {
  divisions,
  drafts,
  householdMembers,
  players,
  registrations,
  rosterEntries,
  teams,
  teamStaff,
  user,
  userRoleAssignments,
  volunteerApplications,
} from "../../db/schema/index.js";
import { HttpError } from "../../http/errors.js";
import { writeAudit } from "../platform/audit.js";
import { publish } from "../platform/outbox.js";
import { lockDivision, type Actor } from "../registration/service.js";

const STAFF_ROLES = ["head_coach", "assistant_coach", "team_manager"] as const;

/* ---------------- board ---------------- */

export interface Slot {
  pick: number;
  round: number;
  teamId: string;
  /** coach_child | draft | null (open) */
  kind: "coach_child" | "draft" | null;
  registrationId: string | null;
}

/** Snake order slots, with coaches' children filling each team's first rounds. */
export function buildSlots(order: string[], rounds: number, coachKids: Map<string, number>, picks: Map<number, string>): Slot[] {
  const slots: Slot[] = [];
  let pick = 0;
  const seenRounds = new Map<string, number>();
  for (let round = 1; round <= rounds; round++) {
    const ids = round % 2 === 1 ? order : [...order].reverse();
    for (const teamId of ids) {
      pick++;
      const teamRound = (seenRounds.get(teamId) ?? 0) + 1;
      seenRounds.set(teamId, teamRound);
      const isKid = teamRound <= (coachKids.get(teamId) ?? 0);
      const reg = picks.get(pick) ?? null;
      slots.push({ pick, round, teamId, kind: isKid ? "coach_child" : reg ? "draft" : null, registrationId: isKid ? null : reg });
    }
  }
  return slots;
}

async function draftOf(conn: Tx | typeof db, divisionId: string) {
  const [d] = await conn.select().from(drafts).where(eq(drafts.divisionId, divisionId));
  return d ?? { divisionId, status: "setup", order: [] as string[], startedAt: null, completedAt: null, publishedAt: null, updatedAt: new Date() };
}

/** Approved registrations in a division not yet on a team. */
async function pool(conn: Tx | typeof db, divisionId: string) {
  const rostered = conn.select({ id: rosterEntries.registrationId }).from(rosterEntries).where(eq(rosterEntries.divisionId, divisionId));
  return conn
    .select({
      registrationId: registrations.id,
      playerId: players.id,
      firstName: players.firstName,
      lastName: players.lastName,
      preferredName: players.preferredName,
      birthDate: players.birthDate,
      gender: players.gender,
      school: players.school,
      householdId: registrations.householdId,
    })
    .from(registrations)
    .innerJoin(players, eq(players.id, registrations.playerId))
    .where(and(eq(registrations.divisionId, divisionId), eq(registrations.status, "approved"), notInArray(registrations.id, rostered)))
    .orderBy(asc(players.lastName), asc(players.firstName));
}

export async function draftBoard(divisionId: string, conn: Tx | typeof db = db) {
  const [division] = await conn.select().from(divisions).where(eq(divisions.id, divisionId));
  if (!division) throw new HttpError(404, "NOT_FOUND", "Division not found.");
  const d = await draftOf(conn, divisionId);
  const ts = await conn.select().from(teams).where(eq(teams.divisionId, divisionId)).orderBy(asc(teams.sortOrder), asc(teams.name));
  const roster = await conn
    .select({
      id: rosterEntries.id,
      teamId: rosterEntries.teamId,
      source: rosterEntries.source,
      pickNumber: rosterEntries.pickNumber,
      registrationId: rosterEntries.registrationId,
      firstName: players.firstName,
      lastName: players.lastName,
      birthDate: players.birthDate,
    })
    .from(rosterEntries)
    .innerJoin(players, eq(players.id, rosterEntries.playerId))
    .where(eq(rosterEntries.divisionId, divisionId));
  const available = await pool(conn, divisionId);
  const [waiting] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(registrations)
    .where(and(eq(registrations.divisionId, divisionId), inArray(registrations.status, ["paid", "processing"])));

  const order = ((d.order as string[]) ?? []).filter((id) => ts.some((t) => t.id === id));
  const fullOrder = [...order, ...ts.filter((t) => !order.includes(t.id)).map((t) => t.id)];
  const coachKids = new Map<string, number>();
  for (const r of roster) if (r.source === "coach_child") coachKids.set(r.teamId, (coachKids.get(r.teamId) ?? 0) + 1);
  const picks = new Map<number, string>();
  for (const r of roster) if (r.source === "draft" && r.pickNumber) picks.set(r.pickNumber, r.registrationId);
  const totalPlayers = roster.length + available.length;
  const rounds = fullOrder.length ? Math.max(1, Math.ceil(totalPlayers / fullOrder.length), ...[...coachKids.values()]) + 1 : 0;
  const slots = buildSlots(fullOrder, rounds, coachKids, picks);
  const current = d.status === "live" && available.length ? (slots.find((s) => s.kind === null) ?? null) : null;

  return {
    division: { id: division.id, name: division.name, seasonId: division.seasonId },
    draft: { status: d.status, order: fullOrder, startedAt: d.startedAt, completedAt: d.completedAt, publishedAt: d.publishedAt },
    teams: ts,
    roster,
    available,
    awaitingReview: waiting?.n ?? 0,
    slots,
    current,
  };
}

/* ---------------- teams ---------------- */

export async function createTeam(actor: Actor & { userId: string }, divisionId: string, input: { name: string; color?: string }) {
  const [d] = await db.select().from(divisions).where(eq(divisions.id, divisionId));
  if (!d) throw new HttpError(404, "NOT_FOUND", "Division not found.");
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(teams).where(eq(teams.divisionId, divisionId))) as [{ n: number }];
  try {
    const [t] = await db
      .insert(teams)
      .values({ seasonId: d.seasonId, divisionId, name: input.name, color: input.color ?? null, sortOrder: n })
      .returning();
    await writeAudit(db, { actorUserId: actor.userId, action: "team.create", targetType: "team", targetId: t!.id, after: t, requestId: actor.requestId, ipAddress: actor.ip });
    return t!;
  } catch (err) {
    if ((err as { cause?: { code?: string } }).cause?.code === "23505") throw new HttpError(409, "CONFLICT", "There's already a team with that name in this division.");
    throw err;
  }
}

export async function updateTeam(actor: Actor & { userId: string }, teamId: string, input: { name: string; color?: string }) {
  const [t] = await db.update(teams).set({ name: input.name, color: input.color ?? null, updatedAt: new Date() }).where(eq(teams.id, teamId)).returning();
  if (!t) throw new HttpError(404, "NOT_FOUND", "Team not found.");
  await writeAudit(db, { actorUserId: actor.userId, action: "team.update", targetType: "team", targetId: teamId, after: t, requestId: actor.requestId, ipAddress: actor.ip });
  return t;
}

export async function deleteTeam(actor: Actor & { userId: string }, teamId: string) {
  return db.transaction(async (tx) => {
    const [t] = await tx.select().from(teams).where(eq(teams.id, teamId));
    if (!t) throw new HttpError(404, "NOT_FOUND", "Team not found.");
    const d = await draftOf(tx, t.divisionId);
    if (d.status !== "setup") throw new HttpError(409, "CONFLICT", "Teams can't be deleted once the draft has started.");
    const [onTeam] = await tx.select({ n: sql<number>`count(*)::int` }).from(rosterEntries).where(eq(rosterEntries.teamId, teamId));
    if ((onTeam?.n ?? 0) > 0) throw new HttpError(409, "CONFLICT", "Move this team's players first.");
    const staff = await tx.select().from(teamStaff).where(eq(teamStaff.teamId, teamId));
    for (const s of staff) await revokeTeamRole(tx, s);
    await tx.delete(teams).where(eq(teams.id, teamId));
    await writeAudit(tx, { actorUserId: actor.userId, action: "team.delete", targetType: "team", targetId: teamId, before: t, requestId: actor.requestId, ipAddress: actor.ip });
  });
}

/* ---------------- staff ---------------- */

/** Approved coaches and team moms for a season, with the team they're on (if any). */
export async function staffPool(seasonId: string) {
  const apps = await db
    .select({ userId: volunteerApplications.userId, roleKey: volunteerApplications.roleKey, name: user.name, email: user.email, phone: volunteerApplications.phone })
    .from(volunteerApplications)
    .innerJoin(user, eq(user.id, volunteerApplications.userId))
    .where(and(eq(volunteerApplications.seasonId, seasonId), eq(volunteerApplications.status, "approved")))
    .orderBy(asc(user.name));
  const assigned = await db
    .select({ userId: teamStaff.userId, roleKey: teamStaff.roleKey, teamId: teamStaff.teamId, teamName: teams.name })
    .from(teamStaff)
    .innerJoin(teams, eq(teams.id, teamStaff.teamId))
    .where(eq(teams.seasonId, seasonId));
  return apps.map((a) => ({ ...a, assignments: assigned.filter((x) => x.userId === a.userId).map((x) => ({ teamId: x.teamId, teamName: x.teamName, roleKey: x.roleKey })) }));
}

async function revokeTeamRole(tx: Tx, s: { teamId: string; userId: string; roleKey: string }) {
  await tx
    .update(userRoleAssignments)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(userRoleAssignments.userId, s.userId),
        eq(userRoleAssignments.roleKey, s.roleKey),
        eq(userRoleAssignments.scopeType, "team"),
        eq(userRoleAssignments.scopeId, s.teamId),
        isNull(userRoleAssignments.revokedAt),
      ),
    );
}

/**
 * Puts an approved coach / team mom on a team: grants their role for that team
 * only, and (before the draft starts) places their own children who are
 * approved in this division on the team.
 */
export async function assignStaff(actor: Actor & { userId: string }, teamId: string, input: { userId: string; roleKey: (typeof STAFF_ROLES)[number] }) {
  return db.transaction(async (tx) => {
    const [t] = await tx.select().from(teams).where(eq(teams.id, teamId));
    if (!t) throw new HttpError(404, "NOT_FOUND", "Team not found.");
    const [app] = await tx
      .select({ id: volunteerApplications.id })
      .from(volunteerApplications)
      .where(
        and(
          eq(volunteerApplications.userId, input.userId),
          eq(volunteerApplications.seasonId, t.seasonId),
          eq(volunteerApplications.roleKey, input.roleKey),
          eq(volunteerApplications.status, "approved"),
        ),
      );
    if (!app) throw new HttpError(409, "CONFLICT", "That person isn't approved for this role this season.");
    if (input.roleKey === "head_coach") {
      const [other] = await tx
        .select({ userId: teamStaff.userId })
        .from(teamStaff)
        .where(and(eq(teamStaff.teamId, teamId), eq(teamStaff.roleKey, "head_coach")));
      if (other && other.userId !== input.userId) throw new HttpError(409, "CONFLICT", "This team already has a head coach.");
    }
    const [ura] = await tx
      .insert(userRoleAssignments)
      .values({ userId: input.userId, roleKey: input.roleKey, scopeType: "team", scopeId: teamId, grantedBy: actor.userId })
      .onConflictDoNothing()
      .returning({ id: userRoleAssignments.id });
    await tx
      .insert(teamStaff)
      .values({ teamId, userId: input.userId, roleKey: input.roleKey, roleAssignmentId: ura?.id ?? null })
      .onConflictDoUpdate({ target: [teamStaff.teamId, teamStaff.userId], set: { roleKey: input.roleKey } });

    // Their own children go on this team before the draft.
    const d = await draftOf(tx, t.divisionId);
    const placed: string[] = [];
    if (d.status === "setup") {
      await lockDivision(tx, t.divisionId);
      const kids = await tx
        .select({ registrationId: registrations.id, playerId: registrations.playerId })
        .from(registrations)
        .innerJoin(householdMembers, eq(householdMembers.householdId, registrations.householdId))
        .where(and(eq(householdMembers.userId, input.userId), eq(registrations.divisionId, t.divisionId), eq(registrations.status, "approved")));
      for (const k of kids) {
        const [row] = await tx
          .insert(rosterEntries)
          .values({ teamId, divisionId: t.divisionId, registrationId: k.registrationId, playerId: k.playerId, source: "coach_child", createdBy: actor.userId })
          .onConflictDoNothing()
          .returning({ id: rosterEntries.id });
        if (row) placed.push(k.playerId);
      }
    }
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "team.staff.assign",
      targetType: "team",
      targetId: teamId,
      after: { userId: input.userId, roleKey: input.roleKey, childrenPlaced: placed.length },
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    return { childrenPlaced: placed.length };
  });
}

export async function removeStaff(actor: Actor & { userId: string }, teamId: string, userId: string) {
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(teamStaff).where(and(eq(teamStaff.teamId, teamId), eq(teamStaff.userId, userId)));
    if (!s) throw new HttpError(404, "NOT_FOUND", "Not on this team.");
    await revokeTeamRole(tx, s);
    await tx.delete(teamStaff).where(and(eq(teamStaff.teamId, teamId), eq(teamStaff.userId, userId)));
    await writeAudit(tx, { actorUserId: actor.userId, action: "team.staff.remove", targetType: "team", targetId: teamId, before: s, requestId: actor.requestId, ipAddress: actor.ip });
  });
}

/* ---------------- draft ---------------- */

async function lockDraft(tx: Tx, divisionId: string) {
  await lockDivision(tx, divisionId);
  return draftOf(tx, divisionId);
}

export async function setDraftOrder(actor: Actor & { userId: string }, divisionId: string, order: string[]) {
  return db.transaction(async (tx) => {
    const d = await lockDraft(tx, divisionId);
    if (d.status !== "setup") throw new HttpError(409, "CONFLICT", "The order can't change once the draft has started.");
    const ts = await tx.select({ id: teams.id }).from(teams).where(eq(teams.divisionId, divisionId));
    const ids = new Set(ts.map((t) => t.id));
    if (order.length !== ids.size || order.some((id) => !ids.has(id)) || new Set(order).size !== order.length) {
      throw new HttpError(400, "VALIDATION_FAILED", "The order must list every team in this division once.");
    }
    await tx
      .insert(drafts)
      .values({ divisionId, order, status: "setup" })
      .onConflictDoUpdate({ target: drafts.divisionId, set: { order, updatedAt: new Date() } });
    await writeAudit(tx, { actorUserId: actor.userId, action: "draft.order", targetType: "division", targetId: divisionId, after: { order }, requestId: actor.requestId, ipAddress: actor.ip });
  });
}

export async function startDraft(actor: Actor & { userId: string }, divisionId: string) {
  return db.transaction(async (tx) => {
    const d = await lockDraft(tx, divisionId);
    if (d.status !== "setup") throw new HttpError(409, "CONFLICT", "The draft has already started.");
    const ts = await tx.select({ id: teams.id }).from(teams).where(eq(teams.divisionId, divisionId));
    if (ts.length < 2) throw new HttpError(409, "CONFLICT", "Add at least two teams first.");
    const order = (d.order as string[]).filter((id) => ts.some((t) => t.id === id));
    const full = [...order, ...ts.map((t) => t.id).filter((id) => !order.includes(id))];
    await tx
      .insert(drafts)
      .values({ divisionId, order: full, status: "live", startedAt: new Date() })
      .onConflictDoUpdate({ target: drafts.divisionId, set: { order: full, status: "live", startedAt: new Date(), updatedAt: new Date() } });
    await writeAudit(tx, { actorUserId: actor.userId, action: "draft.start", targetType: "division", targetId: divisionId, after: { order: full }, requestId: actor.requestId, ipAddress: actor.ip });
  });
}

export async function makePick(actor: Actor & { userId: string }, divisionId: string, input: { registrationId: string; expectedPick?: number }) {
  return db.transaction(async (tx) => {
    const d = await lockDraft(tx, divisionId);
    if (d.status !== "live") throw new HttpError(409, "CONFLICT", "The draft isn't live.");
    const board = await draftBoard(divisionId, tx);
    const slot = board.current;
    if (!slot) throw new HttpError(409, "CONFLICT", "There are no players left to pick.");
    // Guards against a stale screen picking for the wrong team.
    if (input.expectedPick && input.expectedPick !== slot.pick) throw new HttpError(409, "CONFLICT", "The board changed. Refresh and try again.");
    const p = board.available.find((a) => a.registrationId === input.registrationId);
    if (!p) throw new HttpError(409, "CONFLICT", "That player isn't available.");
    const [row] = await tx
      .insert(rosterEntries)
      .values({ teamId: slot.teamId, divisionId, registrationId: p.registrationId, playerId: p.playerId, source: "draft", pickNumber: slot.pick, createdBy: actor.userId })
      .returning();
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "draft.pick",
      targetType: "division",
      targetId: divisionId,
      after: { pick: slot.pick, round: slot.round, teamId: slot.teamId, playerId: p.playerId },
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    return { pick: slot.pick, round: slot.round, teamId: slot.teamId, entryId: row!.id };
  });
}

export async function undoPick(actor: Actor & { userId: string }, divisionId: string) {
  return db.transaction(async (tx) => {
    const d = await lockDraft(tx, divisionId);
    if (d.status !== "live") throw new HttpError(409, "CONFLICT", "The draft isn't live.");
    const [last] = await tx
      .select()
      .from(rosterEntries)
      .where(and(eq(rosterEntries.divisionId, divisionId), eq(rosterEntries.source, "draft")))
      .orderBy(sql`${rosterEntries.pickNumber} desc`)
      .limit(1);
    if (!last) throw new HttpError(409, "CONFLICT", "No picks to undo.");
    await tx.delete(rosterEntries).where(eq(rosterEntries.id, last.id));
    await writeAudit(tx, { actorUserId: actor.userId, action: "draft.undo", targetType: "division", targetId: divisionId, before: { pick: last.pickNumber, playerId: last.playerId, teamId: last.teamId }, requestId: actor.requestId, ipAddress: actor.ip });
    return { undone: last.pickNumber };
  });
}

export async function completeDraft(actor: Actor & { userId: string }, divisionId: string) {
  return db.transaction(async (tx) => {
    const d = await lockDraft(tx, divisionId);
    if (d.status !== "live") throw new HttpError(409, "CONFLICT", "The draft isn't live.");
    await tx.update(drafts).set({ status: "complete", completedAt: new Date(), updatedAt: new Date() }).where(eq(drafts.divisionId, divisionId));
    await writeAudit(tx, { actorUserId: actor.userId, action: "draft.complete", targetType: "division", targetId: divisionId, requestId: actor.requestId, ipAddress: actor.ip });
  });
}

/** Rosters become visible to coaches and families; each family is emailed their child's team. */
export async function publishRosters(actor: Actor & { userId: string }, divisionId: string) {
  return db.transaction(async (tx) => {
    const d = await lockDraft(tx, divisionId);
    if (d.status !== "complete") throw new HttpError(409, "CONFLICT", "Finish the draft before publishing rosters.");
    if (d.publishedAt) throw new HttpError(409, "CONFLICT", "Rosters are already published.");
    await tx.update(drafts).set({ publishedAt: new Date(), updatedAt: new Date() }).where(eq(drafts.divisionId, divisionId));
    const entries = await tx.select({ id: rosterEntries.id }).from(rosterEntries).where(eq(rosterEntries.divisionId, divisionId));
    for (const e of entries) {
      await publish(tx, { name: "roster.published", aggregateType: "roster_entry", aggregateId: e.id, dedupeKey: `roster.published:${e.id}` });
    }
    await writeAudit(tx, { actorUserId: actor.userId, action: "draft.publish", targetType: "division", targetId: divisionId, after: { players: entries.length }, requestId: actor.requestId, ipAddress: actor.ip });
    return { players: entries.length };
  });
}

/* ---------------- roster changes after the draft ---------------- */

export async function addToTeam(actor: Actor & { userId: string }, teamId: string, registrationId: string) {
  return db.transaction(async (tx) => {
    const [t] = await tx.select().from(teams).where(eq(teams.id, teamId));
    if (!t) throw new HttpError(404, "NOT_FOUND", "Team not found.");
    await lockDivision(tx, t.divisionId);
    const [r] = await tx.select().from(registrations).where(eq(registrations.id, registrationId));
    if (!r || r.divisionId !== t.divisionId || r.status !== "approved") throw new HttpError(409, "CONFLICT", "Only approved players in this division can be added.");
    try {
      const [row] = await tx
        .insert(rosterEntries)
        .values({ teamId, divisionId: t.divisionId, registrationId, playerId: r.playerId, source: "admin", createdBy: actor.userId })
        .returning();
      await writeAudit(tx, { actorUserId: actor.userId, action: "roster.add", targetType: "team", targetId: teamId, after: { playerId: r.playerId }, requestId: actor.requestId, ipAddress: actor.ip });
      const d = await draftOf(tx, t.divisionId);
      if (d.publishedAt) await publish(tx, { name: "roster.published", aggregateType: "roster_entry", aggregateId: row!.id, dedupeKey: `roster.published:${row!.id}` });
      return row!;
    } catch (err) {
      if ((err as { cause?: { code?: string } }).cause?.code === "23505") throw new HttpError(409, "CONFLICT", "That player is already on a team.");
      throw err;
    }
  });
}

export async function moveRosterEntry(actor: Actor & { userId: string }, entryId: string, teamId: string) {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(rosterEntries).where(eq(rosterEntries.id, entryId)).for("update");
    if (!e) throw new HttpError(404, "NOT_FOUND", "Roster entry not found.");
    const [t] = await tx.select().from(teams).where(eq(teams.id, teamId));
    if (!t || t.divisionId !== e.divisionId) throw new HttpError(400, "VALIDATION_FAILED", "Choose a team in the same division.");
    const d = await draftOf(tx, e.divisionId);
    if (d.status === "live") throw new HttpError(409, "CONFLICT", "Use undo during the draft; move players after it's finished.");
    const [after] = await tx.update(rosterEntries).set({ teamId, source: "admin" }).where(eq(rosterEntries.id, entryId)).returning();
    await writeAudit(tx, { actorUserId: actor.userId, action: "roster.move", targetType: "roster_entry", targetId: entryId, before: { teamId: e.teamId }, after: { teamId }, requestId: actor.requestId, ipAddress: actor.ip });
    if (d.publishedAt) await publish(tx, { name: "roster.published", aggregateType: "roster_entry", aggregateId: entryId, dedupeKey: `roster.moved:${entryId}:${teamId}` });
    return after!;
  });
}

export async function removeRosterEntry(actor: Actor & { userId: string }, entryId: string) {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(rosterEntries).where(eq(rosterEntries.id, entryId)).for("update");
    if (!e) throw new HttpError(404, "NOT_FOUND", "Roster entry not found.");
    const d = await draftOf(tx, e.divisionId);
    if (d.status === "live" && e.source === "draft") throw new HttpError(409, "CONFLICT", "Use undo during the draft.");
    await tx.delete(rosterEntries).where(eq(rosterEntries.id, entryId));
    await writeAudit(tx, { actorUserId: actor.userId, action: "roster.remove", targetType: "roster_entry", targetId: entryId, before: e, requestId: actor.requestId, ipAddress: actor.ip });
  });
}
