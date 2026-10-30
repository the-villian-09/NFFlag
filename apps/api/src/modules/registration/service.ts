/**
 * Registration and payment rules (R1b).
 *
 * Lifecycle: pending_payment (spot held for `holdMinutes`) → processing (card
 * being charged) → paid (awaiting eligibility review) → approved | rejected.
 * Also: expired (hold ran out unpaid), cancelled.
 *
 * Capacity is enforced by locking the division row while counting, so two
 * families can't take the last spot at the same time.
 */
import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { db, type DbOrTx } from "../../db/client.js";
import {
  contentPages,
  divisions,
  payments,
  players,
  refunds,
  registrations,
  seasons,
} from "../../db/schema/index.js";
import { HttpError } from "../../http/errors.js";
import { logger } from "../../lib/logger.js";
import { WAIVER_SLUGS } from "../content/defaults.js";
import { writeAudit } from "../platform/audit.js";
import { publish } from "../platform/outbox.js";
import {
  createPayment,
  friendlyPaymentError,
  getCredentials,
  refundPayment,
  SquareError,
  type SquarePayment,
} from "../square/client.js";
import { getPaymentSettings, quote } from "./settings.js";

type Registration = typeof registrations.$inferSelect;
type Division = typeof divisions.$inferSelect;
type Season = typeof seasons.$inferSelect;
type Player = typeof players.$inferSelect;

export interface Actor {
  userId: string | null;
  requestId?: string | null;
  ip?: string | null;
}

/* ---------------- eligibility & capacity ---------------- */

export function registrationWindow(season: Season, now = new Date()) {
  if (season.isCurrent !== "current") return { open: false, reason: "This season isn't open for registration." };
  if (!season.registrationOpensAt || season.registrationOpensAt > now) {
    return { open: false, reason: "Registration hasn't opened yet." };
  }
  if (season.registrationClosesAt && season.registrationClosesAt <= now) {
    return { open: false, reason: "Registration has closed for this season." };
  }
  return { open: true as const, reason: null };
}

/** Why a player can't register for a division, or null if they can. Admins still review every registration. */
export function ineligibleReason(player: Pick<Player, "birthDate" | "gender">, d: Division): string | null {
  if (d.genderPolicy === "boys" && player.gender !== "boy") return "This division is for boys.";
  if (d.genderPolicy === "girls" && player.gender !== "girl") return "This division is for girls.";
  if (d.birthDateFrom && player.birthDate < d.birthDateFrom) return "Your child is too old for this division.";
  if (d.birthDateTo && player.birthDate > d.birthDateTo) return "Your child is too young for this division.";
  return null;
}

/** Spots taken: paid/approved/processing, plus unexpired holds. Pass `excludeId` to ignore one registration. */
export async function spotsTaken(conn: DbOrTx, divisionId: string, excludeId?: string) {
  const [row] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(registrations)
    .where(
      and(
        eq(registrations.divisionId, divisionId),
        or(
          inArray(registrations.status, ["processing", "paid", "approved"]),
          and(eq(registrations.status, "pending_payment"), gt(registrations.holdExpiresAt, sql`now()`)),
        ),
        excludeId ? sql`${registrations.id} <> ${excludeId}` : undefined,
      ),
    );
  return row?.n ?? 0;
}

async function lockDivision(tx: DbOrTx, divisionId: string) {
  const [d] = await tx.select().from(divisions).where(eq(divisions.id, divisionId)).for("update");
  if (!d) throw new HttpError(404, "NOT_FOUND", "Division not found.");
  return d;
}

/* ---------------- waivers ---------------- */

export async function currentWaivers(conn: DbOrTx = db) {
  const rows = await conn.select().from(contentPages).where(inArray(contentPages.slug, [...WAIVER_SLUGS]));
  return WAIVER_SLUGS.map((slug) => rows.find((r) => r.slug === slug)).filter((r): r is NonNullable<typeof r> => !!r);
}

/* ---------------- start ---------------- */

export async function startRegistration(
  actor: Actor & { userId: string },
  householdId: string,
  input: { playerId: string; divisionId: string; signerName: string; acceptedWaivers: string[] },
) {
  const settings = await getPaymentSettings();
  const waivers = await currentWaivers();
  const missing = waivers.filter((w) => !input.acceptedWaivers.includes(w.slug));
  if (missing.length) {
    throw new HttpError(400, "VALIDATION_FAILED", `Please accept: ${missing.map((w) => w.title).join(", ")}.`);
  }

  try {
    return await db.transaction(async (tx) => {
      const [player] = await tx
        .select()
        .from(players)
        .where(and(eq(players.id, input.playerId), eq(players.householdId, householdId)));
      if (!player) throw new HttpError(404, "NOT_FOUND", "Player not found.");

      const d = await lockDivision(tx, input.divisionId);
      const [season] = await tx.select().from(seasons).where(eq(seasons.id, d.seasonId));
      const window = registrationWindow(season!);
      if (!window.open) throw new HttpError(409, "CONFLICT", window.reason!);
      if (d.status !== "open") throw new HttpError(409, "CONFLICT", "This division isn't taking registrations.");
      const why = ineligibleReason(player, d);
      if (why) throw new HttpError(409, "CONFLICT", why);

      // A previous unpaid attempt for this child in this season is replaced.
      await tx
        .update(registrations)
        .set({ status: "cancelled", holdExpiresAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(registrations.seasonId, d.seasonId),
            eq(registrations.playerId, player.id),
            eq(registrations.status, "pending_payment"),
          ),
        );

      if ((await spotsTaken(tx, d.id)) >= d.capacity) {
        throw new HttpError(409, "DIVISION_FULL", "Sorry, this division is full.");
      }

      const q = quote(d.priceCents, settings);
      const acceptedAt = new Date().toISOString();
      const [reg] = await tx
        .insert(registrations)
        .values({
          seasonId: d.seasonId,
          divisionId: d.id,
          playerId: player.id,
          householdId,
          submittedBy: actor.userId,
          status: "pending_payment",
          holdExpiresAt: new Date(Date.now() + settings.holdMinutes * 60_000),
          ...q,
          waivers: waivers.map((w) => ({
            slug: w.slug,
            title: w.title,
            version: w.updatedAt.toISOString(),
            sha256: createHash("sha256").update(w.body).digest("hex"),
            signerName: input.signerName,
            acceptedAt,
          })),
        })
        .returning();
      await writeAudit(tx, {
        actorUserId: actor.userId,
        action: "registration.start",
        targetType: "registration",
        targetId: reg!.id,
        after: reg,
        requestId: actor.requestId,
        ipAddress: actor.ip,
      });
      await publish(tx, { name: "registration.submitted", aggregateType: "registration", aggregateId: reg!.id });
      return reg!;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError(409, "CONFLICT", "This child is already registered for this season.");
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown) {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/* ---------------- pay ---------------- */

/**
 * Charges the card token from the Square Web Payments SDK. The registration is
 * moved to `processing` first so a double-click can't charge twice.
 */
export async function payRegistration(
  actor: Actor & { userId: string },
  householdId: string,
  registrationId: string,
  input: { sourceId: string; verificationToken?: string },
  buyerEmail: string,
) {
  const creds = await getCredentials();
  if (!creds) {
    throw new HttpError(503, "PAYMENTS_UNAVAILABLE", "Online payment is temporarily unavailable. Please try again later.");
  }
  const settings = await getPaymentSettings();

  const reg = await db
    .transaction(async (tx) => {
    const [r] = await tx
      .select()
      .from(registrations)
      .where(and(eq(registrations.id, registrationId), eq(registrations.householdId, householdId)))
      .for("update");
    if (!r) throw new HttpError(404, "NOT_FOUND", "Registration not found.");
    if (r.status === "processing") throw new HttpError(409, "CONFLICT", "This payment is already being processed.");
    if (r.status !== "pending_payment" && r.status !== "expired") {
      throw new HttpError(409, "CONFLICT", "This registration doesn't need a payment.");
    }
    // The hold ran out: take the spot again if there's still room (D-05).
    if (!r.holdExpiresAt || r.holdExpiresAt <= new Date()) {
      const d = await lockDivision(tx, r.divisionId);
      if ((await spotsTaken(tx, d.id, r.id)) >= d.capacity) {
        await tx.update(registrations).set({ status: "expired", updatedAt: new Date() }).where(eq(registrations.id, r.id));
        throw new HttpError(409, "DIVISION_FULL", "Your hold expired and the division has filled up. No payment was taken.");
      }
    }
    const [updated] = await tx
      .update(registrations)
      .set({
        status: "processing",
        paymentError: null,
        holdExpiresAt: new Date(Date.now() + settings.holdMinutes * 60_000),
        updatedAt: new Date(),
      })
      .where(eq(registrations.id, r.id))
      .returning();
    return updated!;
  })
    .catch((err) => {
      if (isUniqueViolation(err)) throw new HttpError(409, "CONFLICT", "This child already has another registration this season.");
      throw err;
    });

  let payment: SquarePayment;
  try {
    const [p] = await db.select({ firstName: players.firstName, lastName: players.lastName }).from(players).where(eq(players.id, reg.playerId));
    payment = await createPayment(creds, {
      sourceId: input.sourceId,
      verificationToken: input.verificationToken,
      idempotencyKey: randomUUID(),
      amountCents: reg.totalCents,
      referenceId: reg.id,
      note: `NFFL registration: ${p?.firstName ?? ""} ${p?.lastName ?? ""}`.trim(),
      buyerEmail,
    });
  } catch (err) {
    const definite = err instanceof SquareError && err.status >= 400 && err.status < 500;
    if (definite) {
      const message = friendlyPaymentError(err);
      await db
        .update(registrations)
        .set({ status: "pending_payment", paymentError: message, updatedAt: new Date() })
        .where(eq(registrations.id, reg.id));
      logger.info({ registrationId: reg.id, code: (err as SquareError).code }, "card payment declined");
      throw new HttpError(402, "PAYMENT_FAILED", message);
    }
    // Unknown outcome (network/5xx): leave it in `processing`; the Square webhook settles it.
    logger.error({ registrationId: reg.id, err: err instanceof Error ? err.message : String(err) }, "payment outcome unknown");
    throw new HttpError(
      502,
      "PAYMENT_PENDING",
      "We couldn't confirm your payment yet. Please don't pay again; check your registrations in a few minutes.",
    );
  }

  if (payment.status !== "COMPLETED" && payment.status !== "APPROVED") {
    await db
      .update(registrations)
      .set({ status: "pending_payment", paymentError: "The payment didn't go through.", updatedAt: new Date() })
      .where(eq(registrations.id, reg.id));
    throw new HttpError(402, "PAYMENT_FAILED", "The payment didn't go through. Please try again.");
  }
  return recordCompletedPayment(payment, { environment: creds.environment, merchantId: creds.merchantId }, actor);
}

/**
 * Records a completed Square payment against its registration (from checkout or
 * the webhook; safe to call twice). A payment for a registration that lost its
 * spot is refunded automatically (D-05 default).
 */
export async function recordCompletedPayment(
  payment: SquarePayment,
  source: { environment: string; merchantId: string | null },
  actor: Actor,
) {
  const outcome = await db.transaction(async (tx) => {
    const [r] = await tx.select().from(registrations).where(eq(registrations.id, payment.reference_id ?? "")).for("update");
    if (!r) return { reg: null, refund: false };
    await tx
      .insert(payments)
      .values({
        registrationId: r.id,
        providerEnvironment: source.environment,
        providerPaymentId: payment.id,
        merchantId: source.merchantId,
        locationId: payment.location_id ?? null,
        status: payment.status,
        amountCents: payment.amount_money?.amount ?? r.totalCents,
        cardBrand: payment.card_details?.card?.card_brand ?? null,
        cardLast4: payment.card_details?.card?.last_4 ?? null,
        receiptUrl: payment.receipt_url ?? null,
      })
      .onConflictDoUpdate({ target: payments.providerPaymentId, set: { status: payment.status, updatedAt: new Date() } });

    if (r.status === "paid" || r.status === "approved" || r.status === "rejected") return { reg: r, refund: false };

    let lostSpot = r.status === "cancelled";
    if (r.status === "expired") {
      const d = await lockDivision(tx, r.divisionId);
      lostSpot = (await spotsTaken(tx, d.id, r.id)) >= d.capacity;
    }
    if (lostSpot) return { reg: r, refund: true };

    const [after] = await tx
      .update(registrations)
      .set({ status: "paid", paidAt: new Date(), holdExpiresAt: null, paymentError: null, updatedAt: new Date() })
      .where(eq(registrations.id, r.id))
      .returning();
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "registration.paid",
      targetType: "registration",
      targetId: r.id,
      before: { status: r.status },
      after: { status: "paid", paymentId: payment.id, amountCents: payment.amount_money?.amount },
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    await publish(tx, {
      name: "registration.paid",
      aggregateType: "registration",
      aggregateId: r.id,
      dedupeKey: `registration.paid:${r.id}`,
    });
    return { reg: after!, refund: false };
  });

  if (outcome.refund && outcome.reg) {
    await refundRegistration(outcome.reg.id, { reason: "Payment arrived after the spot was released" }, { userId: null });
  }
  return outcome.reg;
}

/* ---------------- refunds ---------------- */

/** Refunds part or all of what's left on a registration's payment. */
export async function refundRegistration(
  registrationId: string,
  input: { amountCents?: number; reason: string },
  actor: Actor,
) {
  const creds = await getCredentials();
  if (!creds) throw new HttpError(503, "PAYMENTS_UNAVAILABLE", "Square isn't connected, so refunds can't be issued right now.");
  const [p] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.registrationId, registrationId), inArray(payments.status, ["COMPLETED", "APPROVED"])))
    .orderBy(sql`${payments.createdAt} desc`)
    .limit(1);
  if (!p) throw new HttpError(409, "CONFLICT", "There's no completed payment to refund.");
  const remaining = p.amountCents - p.refundedCents;
  const amount = input.amountCents ?? remaining;
  if (amount <= 0 || amount > remaining) {
    throw new HttpError(400, "VALIDATION_FAILED", `You can refund up to $${(remaining / 100).toFixed(2)}.`);
  }
  if (p.providerEnvironment !== creds.environment) {
    throw new HttpError(409, "CONFLICT", "This payment was taken in a different Square environment.");
  }

  let refund: { id: string; status: string };
  try {
    refund = await refundPayment(creds, {
      paymentId: p.providerPaymentId,
      amountCents: amount,
      idempotencyKey: randomUUID(),
      reason: input.reason,
    });
  } catch (err) {
    throw new HttpError(502, "PAYMENT_FAILED", `Square refused the refund: ${err instanceof Error ? err.message : "unknown error"}`);
  }

  await db.transaction(async (tx) => {
    await tx.insert(refunds).values({
      paymentId: p.id,
      providerRefundId: refund.id,
      status: refund.status,
      amountCents: amount,
      reason: input.reason,
      issuedBy: actor.userId,
    });
    await tx
      .update(payments)
      .set({ refundedCents: sql`${payments.refundedCents} + ${amount}`, updatedAt: new Date() })
      .where(eq(payments.id, p.id));
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "registration.refund",
      targetType: "registration",
      targetId: registrationId,
      after: { refundId: refund.id, amountCents: amount, status: refund.status },
      reason: input.reason,
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    await publish(tx, {
      name: "registration.refunded",
      aggregateType: "registration",
      aggregateId: registrationId,
      payload: { amountCents: amount },
      dedupeKey: `registration.refunded:${refund.id}`,
    });
  });
  return { refundId: refund.id, amountCents: amount, status: refund.status };
}

/* ---------------- admin decisions ---------------- */

export async function decideRegistration(
  registrationId: string,
  input: { decision: "approved" | "rejected"; reason?: string; refund: boolean },
  actor: Actor & { userId: string },
) {
  const reg = await db.transaction(async (tx) => {
    const [r] = await tx.select().from(registrations).where(eq(registrations.id, registrationId)).for("update");
    if (!r) throw new HttpError(404, "NOT_FOUND", "Registration not found.");
    if (r.status !== "paid" && !(r.status === "approved" && input.decision === "rejected")) {
      throw new HttpError(409, "CONFLICT", "Only paid registrations can be approved or rejected.");
    }
    const [after] = await tx
      .update(registrations)
      .set({
        status: input.decision,
        decision: input.decision,
        decisionReason: input.reason ?? null,
        decidedBy: actor.userId,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(registrations.id, r.id))
      .returning();
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: `registration.${input.decision === "approved" ? "approve" : "reject"}`,
      targetType: "registration",
      targetId: r.id,
      before: { status: r.status },
      after: { status: input.decision },
      reason: input.reason ?? null,
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    await publish(tx, {
      name: "eligibility.decided",
      aggregateType: "registration",
      aggregateId: r.id,
      payload: { decision: input.decision, reason: input.reason ?? null },
    });
    return after!;
  });
  let refund = null;
  if (input.decision === "rejected" && input.refund) {
    refund = await refundRegistration(reg.id, { reason: input.reason || "Registration not accepted" }, actor);
  }
  return { registration: reg, refund };
}

export async function cancelRegistration(
  registrationId: string,
  input: { reason: string; refund: boolean; householdId?: string },
  actor: Actor,
) {
  const reg = await db.transaction(async (tx) => {
    const [r] = await tx
      .select()
      .from(registrations)
      .where(
        and(
          eq(registrations.id, registrationId),
          input.householdId ? eq(registrations.householdId, input.householdId) : undefined,
        ),
      )
      .for("update");
    if (!r) throw new HttpError(404, "NOT_FOUND", "Registration not found.");
    // Families can only drop an unpaid registration; paid ones go through the league.
    const allowed = input.householdId ? ["pending_payment", "expired"] : ["pending_payment", "expired", "paid", "approved", "rejected"];
    if (!allowed.includes(r.status)) {
      throw new HttpError(
        409,
        "CONFLICT",
        input.householdId ? "Paid registrations can only be cancelled by the league. Please contact us." : "This registration can't be cancelled.",
      );
    }
    const [after] = await tx
      .update(registrations)
      .set({ status: "cancelled", holdExpiresAt: null, updatedAt: new Date() })
      .where(eq(registrations.id, r.id))
      .returning();
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "registration.cancel",
      targetType: "registration",
      targetId: r.id,
      before: { status: r.status },
      after: { status: "cancelled" },
      reason: input.reason,
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    if (r.status !== "pending_payment" && r.status !== "expired") {
      await publish(tx, { name: "registration.cancelled", aggregateType: "registration", aggregateId: r.id });
    }
    return after!;
  });
  let refund = null;
  if (input.refund && !input.householdId) {
    const [p] = await db
      .select()
      .from(payments)
      .where(and(eq(payments.registrationId, reg.id), inArray(payments.status, ["COMPLETED", "APPROVED"])));
    if (p && p.amountCents > p.refundedCents) refund = await refundRegistration(reg.id, { reason: input.reason }, actor);
  }
  return { registration: reg, refund };
}

/** Worker: release holds that ran out without payment. */
export async function expireHolds() {
  const rows = await db
    .update(registrations)
    .set({ status: "expired", updatedAt: new Date() })
    .where(and(eq(registrations.status, "pending_payment"), sql`${registrations.holdExpiresAt} < now() - interval '1 minute'`))
    .returning({ id: registrations.id });
  return rows.length;
}

export type { Registration };
