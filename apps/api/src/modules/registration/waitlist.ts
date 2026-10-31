/**
 * Waitlist (R2). When a division is full, families join its waitlist. When a
 * spot opens (a hold lapses, a registration is cancelled or rejected, or an
 * admin raises capacity), the worker offers it to the next family by email.
 * The offer holds the spot for `offerHours`; claiming it becomes a normal
 * registration (waivers, then payment). Unclaimed offers pass to the next family.
 */
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { divisions, players, registrations, seasons, waitlistEntries } from "../../db/schema/index.js";
import { HttpError } from "../../http/errors.js";
import { logger } from "../../lib/logger.js";
import { writeAudit } from "../platform/audit.js";
import { isEnabled } from "../platform/flags.js";
import { publish } from "../platform/outbox.js";
import { ineligibleReason, isUniqueViolation, lockDivision, spotsTaken, startRegistration, waitingCount, type Actor } from "./service.js";
import { getPaymentSettings } from "./settings.js";

export const WAITLIST_FLAG = "r2.waitlist_offers";

/** Places ahead of an entry (0 = next in line). */
export async function positionOf(entry: { divisionId: string; createdAt: Date; id: string }) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.divisionId, entry.divisionId),
        eq(waitlistEntries.status, "waiting"),
        sql`(${waitlistEntries.createdAt}, ${waitlistEntries.id}) < (${entry.createdAt}, ${entry.id})`,
      ),
    );
  return row?.n ?? 0;
}

export async function joinWaitlist(actor: Actor & { userId: string }, householdId: string, input: { playerId: string; divisionId: string }) {
  if (!(await isEnabled(WAITLIST_FLAG))) throw new HttpError(403, "FEATURE_DISABLED", "The waitlist isn't open.");
  try {
    const entry = await db.transaction(async (tx) => {
      const [player] = await tx
        .select()
        .from(players)
        .where(and(eq(players.id, input.playerId), eq(players.householdId, householdId)));
      if (!player) throw new HttpError(404, "NOT_FOUND", "Player not found.");
      const d = await lockDivision(tx, input.divisionId);
      const [season] = await tx.select().from(seasons).where(eq(seasons.id, d.seasonId));
      if (season?.isCurrent !== "current") throw new HttpError(409, "CONFLICT", "This season isn't open.");
      if (d.status === "draft" || d.status === "closed") throw new HttpError(409, "CONFLICT", "This division isn't taking registrations.");
      const why = ineligibleReason(player, d);
      if (why) throw new HttpError(409, "CONFLICT", why);
      const full = d.status === "full" || (await spotsTaken(tx, d.id)) >= d.capacity || (await waitingCount(tx, d.id)) > 0;
      if (!full) throw new HttpError(409, "CONFLICT", "This division still has room. You can register now.");
      const [active] = await tx
        .select({ id: registrations.id })
        .from(registrations)
        .where(
          and(
            eq(registrations.seasonId, d.seasonId),
            eq(registrations.playerId, player.id),
            inArray(registrations.status, ["processing", "paid", "approved"]),
          ),
        )
        .limit(1);
      if (active) throw new HttpError(409, "CONFLICT", "This child is already registered this season.");
      const [e] = await tx
        .insert(waitlistEntries)
        .values({ seasonId: d.seasonId, divisionId: d.id, playerId: player.id, householdId, createdBy: actor.userId })
        .returning();
      await writeAudit(tx, {
        actorUserId: actor.userId,
        action: "waitlist.join",
        targetType: "waitlist_entry",
        targetId: e!.id,
        after: { divisionId: d.id, playerId: player.id },
        requestId: actor.requestId,
        ipAddress: actor.ip,
      });
      await publish(tx, { name: "waitlist.joined", aggregateType: "waitlist_entry", aggregateId: e!.id });
      return e!;
    });
    return { entry, position: (await positionOf(entry)) + 1 };
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "CONFLICT", "This child is already on a waitlist this season.");
    throw err;
  }
}

export async function listMyWaitlist(householdId: string) {
  const rows = await db
    .select({
      id: waitlistEntries.id,
      status: waitlistEntries.status,
      divisionId: waitlistEntries.divisionId,
      playerId: waitlistEntries.playerId,
      offerExpiresAt: waitlistEntries.offerExpiresAt,
      createdAt: waitlistEntries.createdAt,
      playerName: players.firstName,
      playerLastName: players.lastName,
      divisionName: divisions.name,
    })
    .from(waitlistEntries)
    .innerJoin(players, eq(players.id, waitlistEntries.playerId))
    .innerJoin(divisions, eq(divisions.id, waitlistEntries.divisionId))
    .where(and(eq(waitlistEntries.householdId, householdId), inArray(waitlistEntries.status, ["waiting", "offered", "expired"])))
    .orderBy(asc(waitlistEntries.createdAt));
  return Promise.all(rows.map(async (r) => ({ ...r, position: r.status === "waiting" ? (await positionOf(r)) + 1 : null })));
}

/** Family leaves (or turns down an offer); an offered spot goes to the next family. */
export async function leaveWaitlist(actor: Actor & { userId: string }, householdId: string, entryId: string) {
  const [e] = await db
    .update(waitlistEntries)
    .set({ status: "declined", updatedAt: new Date() })
    .where(and(eq(waitlistEntries.id, entryId), eq(waitlistEntries.householdId, householdId), inArray(waitlistEntries.status, ["waiting", "offered"])))
    .returning();
  if (!e) throw new HttpError(404, "NOT_FOUND", "Waitlist entry not found.");
  await writeAudit(db, { actorUserId: actor.userId, action: "waitlist.leave", targetType: "waitlist_entry", targetId: e.id, requestId: actor.requestId, ipAddress: actor.ip });
  return e;
}

/** Claim an offered spot: becomes a registration held until the offer deadline, ready to pay. */
export async function acceptOffer(
  actor: Actor & { userId: string },
  householdId: string,
  entryId: string,
  input: { signerName: string; acceptedWaivers: string[] },
) {
  const [e] = await db.select().from(waitlistEntries).where(and(eq(waitlistEntries.id, entryId), eq(waitlistEntries.householdId, householdId)));
  if (!e) throw new HttpError(404, "NOT_FOUND", "Offer not found.");
  return startRegistration(actor, householdId, { playerId: e.playerId, divisionId: e.divisionId, ...input }, { entryId });
}

export async function removeFromWaitlist(actor: Actor & { userId: string }, entryId: string, reason: string) {
  const [e] = await db
    .update(waitlistEntries)
    .set({ status: "removed", removedReason: reason, updatedAt: new Date() })
    .where(and(eq(waitlistEntries.id, entryId), inArray(waitlistEntries.status, ["waiting", "offered"])))
    .returning();
  if (!e) throw new HttpError(404, "NOT_FOUND", "Waitlist entry not found or already closed.");
  await writeAudit(db, {
    actorUserId: actor.userId,
    action: "waitlist.remove",
    targetType: "waitlist_entry",
    targetId: e.id,
    reason,
    requestId: actor.requestId,
    ipAddress: actor.ip,
  });
  return e;
}

/**
 * Worker: expire unclaimed offers, then offer every free spot to the next
 * family in line. Runs every minute; safe to run concurrently (division lock).
 */
export async function processWaitlist() {
  const expired = await db
    .update(waitlistEntries)
    .set({ status: "expired", updatedAt: new Date() })
    .where(and(eq(waitlistEntries.status, "offered"), lt(waitlistEntries.offerExpiresAt, sql`now()`)))
    .returning({ id: waitlistEntries.id });
  for (const e of expired) {
    await publish(db, { name: "waitlist.offer_expired", aggregateType: "waitlist_entry", aggregateId: e.id, dedupeKey: `waitlist.expired:${e.id}` });
  }

  if (!(await isEnabled(WAITLIST_FLAG))) return { expired: expired.length, offered: 0 };
  const { offerHours } = await getPaymentSettings();
  const withWaiting = await db
    .selectDistinct({ divisionId: waitlistEntries.divisionId })
    .from(waitlistEntries)
    .where(eq(waitlistEntries.status, "waiting"));

  let offered = 0;
  for (const { divisionId } of withWaiting) {
    try {
      offered += await db.transaction(async (tx) => {
        const d = await lockDivision(tx, divisionId);
        if (d.status === "closed" || d.status === "draft") return 0;
        const free = d.capacity - (await spotsTaken(tx, d.id));
        if (free <= 0) return 0;
        const next = await tx
          .select()
          .from(waitlistEntries)
          .where(and(eq(waitlistEntries.divisionId, d.id), eq(waitlistEntries.status, "waiting")))
          .orderBy(asc(waitlistEntries.createdAt), asc(waitlistEntries.id))
          .limit(free)
          .for("update", { skipLocked: true });
        const expiresAt = new Date(Date.now() + offerHours * 3600_000);
        for (const e of next) {
          await tx
            .update(waitlistEntries)
            .set({ status: "offered", offeredAt: new Date(), offerExpiresAt: expiresAt, updatedAt: new Date() })
            .where(eq(waitlistEntries.id, e.id));
          await writeAudit(tx, { actorUserId: null, action: "waitlist.offer", targetType: "waitlist_entry", targetId: e.id, after: { offerExpiresAt: expiresAt } });
          await publish(tx, { name: "waitlist.offered", aggregateType: "waitlist_entry", aggregateId: e.id, dedupeKey: `waitlist.offered:${e.id}:${expiresAt.getTime()}` });
        }
        return next.length;
      });
    } catch (err) {
      logger.error({ divisionId, err: err instanceof Error ? err.message : String(err) }, "waitlist offers failed for division");
    }
  }
  return { expired: expired.length, offered };
}
