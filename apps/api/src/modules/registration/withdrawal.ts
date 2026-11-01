/**
 * Withdrawal requests: a family asks the league to withdraw a paid
 * registration. The league decides: cancel it (with or without a refund, from
 * the registration page) or decline with a note. The family can take the
 * request back while it's open.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "../../db/client.js";
import { registrations, withdrawalRequests } from "../../db/schema/index.js";
import { HttpError } from "../../http/errors.js";
import { writeAudit } from "../platform/audit.js";
import { publish } from "../platform/outbox.js";
import type { Actor } from "./service.js";

const WITHDRAWABLE = ["paid", "approved"];

export async function requestWithdrawal(actor: Actor & { userId: string }, householdId: string, registrationId: string, reason: string | null) {
  try {
    return await db.transaction(async (tx) => {
      const [r] = await tx
        .select()
        .from(registrations)
        .where(and(eq(registrations.id, registrationId), eq(registrations.householdId, householdId)))
        .for("update");
      if (!r) throw new HttpError(404, "NOT_FOUND", "Registration not found.");
      if (!WITHDRAWABLE.includes(r.status)) {
        throw new HttpError(409, "CONFLICT", r.status === "pending_payment" || r.status === "expired" ? "This registration isn't paid; you can cancel it yourself." : "This registration can't be withdrawn.");
      }
      const [w] = await tx.insert(withdrawalRequests).values({ registrationId: r.id, requestedBy: actor.userId, reason: reason || null }).returning();
      await writeAudit(tx, {
        actorUserId: actor.userId,
        action: "registration.withdrawal_requested",
        targetType: "registration",
        targetId: r.id,
        after: { requestId: w!.id, reason: w!.reason },
        requestId: actor.requestId,
        ipAddress: actor.ip,
      });
      await publish(tx, { name: "registration.withdrawal_requested", aggregateType: "withdrawal_request", aggregateId: w!.id });
      return w!;
    });
  } catch (err) {
    if ((err as { cause?: { code?: string } }).cause?.code === "23505") throw new HttpError(409, "CONFLICT", "You've already asked to withdraw this registration.");
    throw err;
  }
}

/** The family takes back an open request. */
export async function takeBackWithdrawal(actor: Actor & { userId: string }, householdId: string, registrationId: string) {
  return db.transaction(async (tx) => {
    const [r] = await tx.select({ id: registrations.id }).from(registrations).where(and(eq(registrations.id, registrationId), eq(registrations.householdId, householdId)));
    if (!r) throw new HttpError(404, "NOT_FOUND", "Registration not found.");
    const [w] = await tx
      .update(withdrawalRequests)
      .set({ status: "withdrawn", resolvedBy: actor.userId, resolvedAt: new Date() })
      .where(and(eq(withdrawalRequests.registrationId, r.id), eq(withdrawalRequests.status, "open")))
      .returning();
    if (!w) throw new HttpError(409, "CONFLICT", "There's no open request to take back.");
    await writeAudit(tx, { actorUserId: actor.userId, action: "registration.withdrawal_taken_back", targetType: "registration", targetId: r.id, requestId: actor.requestId, ipAddress: actor.ip });
    return w;
  });
}

/** League declines an open request; the family is emailed the note. */
export async function declineWithdrawal(actor: Actor & { userId: string }, registrationId: string, note: string) {
  return db.transaction(async (tx) => {
    const [w] = await tx
      .update(withdrawalRequests)
      .set({ status: "declined", adminNote: note, resolvedBy: actor.userId, resolvedAt: new Date() })
      .where(and(eq(withdrawalRequests.registrationId, registrationId), eq(withdrawalRequests.status, "open")))
      .returning();
    if (!w) throw new HttpError(409, "CONFLICT", "There's no open withdrawal request.");
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "registration.withdrawal_declined",
      targetType: "registration",
      targetId: registrationId,
      after: { note },
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    await publish(tx, { name: "registration.withdrawal_declined", aggregateType: "withdrawal_request", aggregateId: w.id });
    return w;
  });
}

/** When the league cancels a registration, its open request is done. */
export async function completeWithdrawal(tx: Tx, registrationId: string, actorUserId: string | null) {
  await tx
    .update(withdrawalRequests)
    .set({ status: "completed", resolvedBy: actorUserId, resolvedAt: new Date() })
    .where(and(eq(withdrawalRequests.registrationId, registrationId), eq(withdrawalRequests.status, "open")));
}

/** Latest request per registration (open, or the most recent resolved one). */
export async function latestWithdrawals(registrationIds: string[]) {
  if (!registrationIds.length) return new Map<string, typeof withdrawalRequests.$inferSelect>();
  const rows = await db.select().from(withdrawalRequests).where(inArray(withdrawalRequests.registrationId, registrationIds)).orderBy(desc(withdrawalRequests.createdAt));
  const map = new Map<string, typeof withdrawalRequests.$inferSelect>();
  for (const w of rows) if (!map.has(w.registrationId)) map.set(w.registrationId, w);
  return map;
}

export async function openWithdrawalCount() {
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(withdrawalRequests).where(eq(withdrawalRequests.status, "open"))) as [{ n: number }];
  return n;
}
