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
import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { db, type DbOrTx, type Tx } from "../../db/client.js";
import {
  contentPages,
  divisions,
  payments,
  players,
  refunds,
  registrations,
  seasons,
  waitlistEntries,
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

/**
 * Spots taken: paid/approved/processing registrations, unexpired holds, and
 * unexpired waitlist offers (a spot is held for the family it's offered to).
 * Pass `excludeId` to ignore one registration.
 */
export async function spotsTaken(conn: DbOrTx, divisionId: string, excludeId?: string) {
  const [offers] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.divisionId, divisionId), eq(waitlistEntries.status, "offered"), gt(waitlistEntries.offerExpiresAt, sql`now()`)));
  return (offers?.n ?? 0) + (await registrationsTaken(conn, divisionId, excludeId));
}

/** Families waiting (not yet offered) for a division. */
export async function waitingCount(conn: DbOrTx, divisionId: string) {
  const [row] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.divisionId, divisionId), eq(waitlistEntries.status, "waiting")));
  return row?.n ?? 0;
}

async function registrationsTaken(conn: DbOrTx, divisionId: string, excludeId?: string) {
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

export async function lockDivision(tx: DbOrTx, divisionId: string) {
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
  /** Claiming a waitlist offer: the spot is already held, so the open/full checks are skipped. */
  offer?: { entryId: string },
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
      let holdExpiresAt = new Date(Date.now() + settings.holdMinutes * 60_000);
      if (offer) {
        const [entry] = await tx
          .select()
          .from(waitlistEntries)
          .where(and(eq(waitlistEntries.id, offer.entryId), eq(waitlistEntries.householdId, householdId)))
          .for("update");
        if (!entry || entry.playerId !== player.id || entry.divisionId !== d.id) throw new HttpError(404, "NOT_FOUND", "Offer not found.");
        if (entry.status !== "offered" || !entry.offerExpiresAt || entry.offerExpiresAt <= new Date()) {
          throw new HttpError(409, "CONFLICT", "This offer has expired.");
        }
        // The family keeps the rest of their offer window to pay (at least the normal hold).
        if (entry.offerExpiresAt > holdExpiresAt) holdExpiresAt = entry.offerExpiresAt;
        // Release the offer's hold; the registration below takes the spot.
        await tx.update(waitlistEntries).set({ status: "accepted", updatedAt: new Date() }).where(eq(waitlistEntries.id, entry.id));
      } else {
        const [season] = await tx.select().from(seasons).where(eq(seasons.id, d.seasonId));
        const window = registrationWindow(season!);
        if (!window.open) throw new HttpError(409, "CONFLICT", window.reason!);
        if (d.status !== "open") throw new HttpError(409, "CONFLICT", "This division isn't taking registrations.");
        // Fair play: while families are waiting, new registrations join the waitlist instead.
        if ((await waitingCount(tx, d.id)) > 0) {
          throw new HttpError(409, "DIVISION_FULL", "This division is full. You can join the waitlist.");
        }
      }
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
          holdExpiresAt,
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
      if (offer) {
        await tx.update(waitlistEntries).set({ registrationId: reg!.id }).where(eq(waitlistEntries.id, offer.entryId));
      }
      await writeAudit(tx, {
        actorUserId: actor.userId,
        action: offer ? "waitlist.accept" : "registration.start",
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

export function isUniqueViolation(err: unknown) {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/* ---------------- pay ---------------- */

/** What was sent to Square, kept until the outcome is known so the worker can re-ask with the same idempotency key. */
interface PaymentRequest {
  idempotencyKey: string;
  sourceId: string;
  verificationToken?: string;
  amountCents: number;
  note: string;
  buyerEmail?: string;
}

const COMPLETED = ["COMPLETED", "APPROVED"];

/**
 * Locks the division, then the registration (same order as startRegistration,
 * so the two can't deadlock), and checks it can be paid now. A lapsed hold is
 * re-taken only if registration is still open and there's still room (D-05).
 */
async function claimForPayment(tx: Tx, registrationId: string, householdId: string, divisionId: string, holdMinutes: number) {
  const d = await lockDivision(tx, divisionId);
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
  let holdExpiresAt = r.holdExpiresAt;
  if (!holdExpiresAt || holdExpiresAt <= new Date()) {
    const [season] = await tx.select().from(seasons).where(eq(seasons.id, r.seasonId));
    const window = registrationWindow(season!);
    if (!window.open) throw new HttpError(409, "CONFLICT", window.reason!);
    if (d.status !== "open") throw new HttpError(409, "CONFLICT", "This division isn't taking registrations any more.");
    if ((await spotsTaken(tx, d.id, r.id)) >= d.capacity) {
      throw new HttpError(409, "DIVISION_FULL", "Your hold expired and the division has filled up. No payment was taken.");
    }
    // Only a lapsed hold is renewed; retrying a declined card doesn't extend a live one.
    holdExpiresAt = new Date(Date.now() + holdMinutes * 60_000);
  }
  return { r, holdExpiresAt };
}

function uniqueAsConflict(err: unknown): never {
  if (isUniqueViolation(err)) throw new HttpError(409, "CONFLICT", "This child already has another registration this season.");
  throw err;
}

/**
 * Charges the card token from the Square Web Payments SDK. The registration is
 * moved to `processing` first (with the exact request, so the outcome can be
 * recovered if the connection drops) so a double-click can't charge twice.
 */
export async function payRegistration(
  actor: Actor & { userId: string },
  householdId: string,
  registrationId: string,
  input: { sourceId: string; verificationToken?: string },
  buyerEmail: string,
) {
  const [peek] = await db
    .select({ divisionId: registrations.divisionId, totalCents: registrations.totalCents, playerId: registrations.playerId })
    .from(registrations)
    .where(and(eq(registrations.id, registrationId), eq(registrations.householdId, householdId)));
  if (!peek) throw new HttpError(404, "NOT_FOUND", "Registration not found.");
  const settings = await getPaymentSettings();

  // Free divisions: nothing to charge.
  if (peek.totalCents === 0) {
    return db
      .transaction(async (tx) => {
        const { r } = await claimForPayment(tx, registrationId, householdId, peek.divisionId, settings.holdMinutes);
        return markPaid(tx, r, null, actor);
      })
      .catch(uniqueAsConflict);
  }

  const creds = await getCredentials().catch(() => null);
  if (!creds) {
    throw new HttpError(503, "PAYMENTS_UNAVAILABLE", "Online payment is temporarily unavailable. Please try again later.");
  }
  const [p] = await db.select({ firstName: players.firstName, lastName: players.lastName }).from(players).where(eq(players.id, peek.playerId));
  const request: PaymentRequest = {
    idempotencyKey: randomUUID(),
    sourceId: input.sourceId,
    verificationToken: input.verificationToken,
    amountCents: peek.totalCents,
    note: `NFFL registration: ${p?.firstName ?? ""} ${p?.lastName ?? ""}`.trim(),
    buyerEmail,
  };

  await db
    .transaction(async (tx) => {
      const { r, holdExpiresAt } = await claimForPayment(tx, registrationId, householdId, peek.divisionId, settings.holdMinutes);
      await tx
        .update(registrations)
        .set({
          status: "processing",
          paymentError: null,
          holdExpiresAt,
          paymentRequest: { ...request, amountCents: r.totalCents },
          processingStartedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(registrations.id, r.id));
      request.amountCents = r.totalCents;
    })
    .catch(uniqueAsConflict);

  return chargeAndSettle(registrationId, request, actor);
}

/** Sends the payment to Square (or re-sends it with the same key) and settles the registration. */
async function chargeAndSettle(registrationId: string, request: PaymentRequest, actor: Actor) {
  const creds = await getCredentials().catch(() => null);
  if (!creds) throw new HttpError(503, "PAYMENTS_UNAVAILABLE", "Online payment is temporarily unavailable. Please try again later.");
  let payment: SquarePayment;
  try {
    payment = await createPayment(creds, { ...request, referenceId: registrationId });
  } catch (err) {
    if (err instanceof SquareError && err.status >= 400 && err.status < 500) {
      // Square's own reason, for the logs (no card data in it).
      const squareErrors = err.errors.map((e) => ({ code: e.code, category: e.category, field: e.field, detail: e.detail }));
      if (isCardProblem(err)) {
        const message = friendlyPaymentError(err);
        await revertToPending(registrationId, message);
        logger.info({ registrationId, squareErrors }, "card payment declined");
        throw new HttpError(402, "PAYMENT_FAILED", message);
      }
      // Our setup (token, location, app id) or request is wrong: not the family's card.
      await revertToPending(registrationId, "Payment setup problem (not the card).");
      logger.error({ registrationId, status: err.status, squareErrors }, "Square rejected the payment request: check Square settings");
      throw new HttpError(
        503,
        "PAYMENTS_UNAVAILABLE",
        "We couldn't process payments just now because of a problem on our side. Your card was not charged. Please try again later.",
      );
    }
    logger.error({ registrationId, err: err instanceof Error ? err.message : String(err) }, "payment outcome unknown");
    throw new HttpError(502, "PAYMENT_PENDING", "We couldn't confirm your payment yet. Please don't pay again; check your registrations in a few minutes.");
  }
  if (COMPLETED.includes(payment.status)) {
    const reg = await recordCompletedPayment(payment, { environment: creds.environment, merchantId: creds.merchantId }, actor);
    if (!reg || reg.status !== "paid") {
      throw new HttpError(409, "DIVISION_FULL", "The division filled up before your payment finished. Your payment is being refunded.");
    }
    return reg;
  }
  if (payment.status === "FAILED" || payment.status === "CANCELED") {
    await revertToPending(registrationId, "The payment didn't go through.");
    throw new HttpError(402, "PAYMENT_FAILED", "The payment didn't go through. Please try again.");
  }
  // PENDING: Square hasn't finished; the webhook or the worker settles it.
  throw new HttpError(502, "PAYMENT_PENDING", "Your payment is still being confirmed. Please don't pay again; check your registrations in a few minutes.");
}

/** A decline the family can fix (card, CVV, ZIP, funds), as opposed to a problem with our Square setup. */
function isCardProblem(err: SquareError) {
  return err.errors.some((e) => e.category === "PAYMENT_METHOD_ERROR") || err.status === 402;
}

/** A charge that definitely didn't happen: the family can try again. */
export async function revertToPending(registrationId: string, message: string) {
  await db
    .update(registrations)
    .set({ status: "pending_payment", paymentError: message, paymentRequest: null, processingStartedAt: null, updatedAt: new Date() })
    .where(and(eq(registrations.id, registrationId), eq(registrations.status, "processing")));
}

/**
 * Worker: registrations stuck in `processing` (connection dropped, server
 * restarted) are re-sent to Square with the same idempotency key. Square
 * returns the original result if it charged, or an error if it never did.
 */
export async function reconcileProcessing(olderThanMinutes = 5) {
  const stuck = await db
    .select({ id: registrations.id, paymentRequest: registrations.paymentRequest })
    .from(registrations)
    .where(
      and(
        eq(registrations.status, "processing"),
        sql`${registrations.processingStartedAt} < now() - make_interval(mins => ${olderThanMinutes})`,
      ),
    )
    .limit(25);
  let settled = 0;
  for (const s of stuck) {
    if (!s.paymentRequest) continue;
    try {
      await chargeAndSettle(s.id, s.paymentRequest as PaymentRequest, { userId: null });
      settled++;
    } catch (err) {
      if (err instanceof HttpError && err.code !== "PAYMENT_PENDING" && err.code !== "PAYMENTS_UNAVAILABLE") settled++;
      else logger.warn({ registrationId: s.id }, "payment still unconfirmed");
    }
  }
  return settled;
}

async function markPaid(tx: Tx, r: Registration, paymentId: string | null, actor: Actor) {
  const [after] = await tx
    .update(registrations)
    .set({
      status: "paid",
      paidAt: new Date(),
      holdExpiresAt: null,
      paymentError: null,
      paymentRequest: null,
      processingStartedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(registrations.id, r.id))
    .returning();
  await writeAudit(tx, {
    actorUserId: actor.userId,
    action: "registration.paid",
    targetType: "registration",
    targetId: r.id,
    before: { status: r.status },
    after: { status: "paid", paymentId, amountCents: r.totalCents },
    requestId: actor.requestId,
    ipAddress: actor.ip,
  });
  await publish(tx, { name: "registration.paid", aggregateType: "registration", aggregateId: r.id, dedupeKey: `registration.paid:${r.id}` });
  return after!;
}

/**
 * Records a completed Square payment against its registration (from checkout,
 * the worker or the webhook; safe to repeat). Refunds it automatically when it
 * can't be kept: the spot was released (D-05) or it duplicates an earlier payment.
 */
export async function recordCompletedPayment(
  payment: SquarePayment,
  source: { environment: string; merchantId: string | null },
  actor: Actor,
) {
  const outcome = await db.transaction(async (tx) => {
    const [r] = await tx.select().from(registrations).where(eq(registrations.id, payment.reference_id ?? "")).for("update");
    if (!r) return { reg: null, refundPaymentId: null as string | null, reason: "" };
    const [row] = await tx
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
      .onConflictDoUpdate({ target: payments.providerPaymentId, set: { status: payment.status, updatedAt: new Date() } })
      .returning();
    const [anyRefund] = await tx.select({ id: refunds.id }).from(refunds).where(eq(refunds.paymentId, row!.id)).limit(1);
    const refunding = row!.refundedCents > 0 || !!anyRefund;
    const keep = { reg: r, refundPaymentId: null as string | null, reason: "" };

    if (r.paidAt) {
      // Already paid: only a different, later payment is a duplicate to give back.
      const [first] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(and(eq(payments.registrationId, r.id), inArray(payments.status, COMPLETED)))
        .orderBy(asc(payments.createdAt), asc(payments.id))
        .limit(1);
      if (first && first.id !== row!.id && !refunding) return { ...keep, refundPaymentId: row!.id, reason: "Duplicate payment" };
      return keep;
    }

    let lostSpot = r.status === "cancelled" || r.status === "rejected";
    if (r.status === "expired") {
      const d = await lockDivision(tx, r.divisionId);
      lostSpot = (await spotsTaken(tx, d.id, r.id)) >= d.capacity;
    }
    if (!lostSpot) {
      try {
        const after = await tx.transaction((sp) => markPaid(sp, r, payment.id, actor));
        return { ...keep, reg: after };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        lostSpot = true; // the child got another registration meanwhile
      }
    }
    return refunding ? keep : { ...keep, refundPaymentId: row!.id, reason: "Payment arrived after the spot was released" };
  });

  if (outcome.refundPaymentId && outcome.reg) {
    try {
      await refundRegistration(outcome.reg.id, { reason: outcome.reason, paymentId: outcome.refundPaymentId }, { userId: null });
    } catch (err) {
      logger.error({ registrationId: outcome.reg.id, err: err instanceof Error ? err.message : String(err) }, "automatic refund failed");
    }
  }
  return outcome.reg;
}

/* ---------------- refunds ---------------- */

/**
 * Refunds part or all of what's left on a payment (the registration's most
 * recent one with money left, unless `paymentId` is given). The amount is
 * reserved under a row lock before calling Square, so two clicks can't both
 * refund the same money.
 */
export async function refundRegistration(
  registrationId: string,
  input: { amountCents?: number; reason: string; paymentId?: string },
  actor: Actor,
) {
  const creds = await getCredentials().catch(() => null);
  if (!creds) throw new HttpError(503, "PAYMENTS_UNAVAILABLE", "Square isn't connected, so refunds can't be issued right now.");

  const { p, amount } = await db.transaction(async (tx) => {
    const [p] = await tx
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.registrationId, registrationId),
          inArray(payments.status, COMPLETED),
          input.paymentId ? eq(payments.id, input.paymentId) : sql`${payments.amountCents} > ${payments.refundedCents}`,
        ),
      )
      .orderBy(desc(payments.createdAt))
      .limit(1)
      .for("update");
    if (!p) throw new HttpError(409, "CONFLICT", "There's no completed payment to refund.");
    const remaining = p.amountCents - p.refundedCents;
    const amount = input.amountCents ?? remaining;
    if (amount <= 0 || amount > remaining) {
      throw new HttpError(400, "VALIDATION_FAILED", `You can refund up to $${(remaining / 100).toFixed(2)}.`);
    }
    if (p.providerEnvironment !== creds.environment) {
      throw new HttpError(409, "CONFLICT", "This payment was taken in a different Square environment.");
    }
    await tx
      .update(payments)
      .set({ refundedCents: sql`${payments.refundedCents} + ${amount}`, updatedAt: new Date() })
      .where(eq(payments.id, p.id));
    return { p, amount };
  });
  const release = () =>
    db
      .update(payments)
      .set({ refundedCents: sql`greatest(0, ${payments.refundedCents} - ${amount})`, updatedAt: new Date() })
      .where(eq(payments.id, p.id));

  let refund: { id: string; status: string };
  try {
    refund = await refundPayment(creds, { paymentId: p.providerPaymentId, amountCents: amount, idempotencyKey: randomUUID(), reason: input.reason });
  } catch (err) {
    await release();
    throw new HttpError(502, "PAYMENT_FAILED", `Square refused the refund: ${err instanceof Error ? err.message : "unknown error"}`);
  }

  await db.transaction(async (tx) => {
    // The webhook may have recorded (and counted) this refund already; then give back our reservation.
    const [saved] = await tx
      .insert(refunds)
      .values({ paymentId: p.id, providerRefundId: refund.id, status: refund.status, amountCents: amount, reason: input.reason, issuedBy: actor.userId })
      .onConflictDoUpdate({ target: refunds.providerRefundId, set: { reason: input.reason, issuedBy: actor.userId, updatedAt: new Date() } })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    if (!saved?.inserted) {
      await tx
        .update(payments)
        .set({ refundedCents: sql`greatest(0, ${payments.refundedCents} - ${amount})`, updatedAt: new Date() })
        .where(eq(payments.id, p.id));
    }
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "registration.refund",
      targetType: "registration",
      targetId: registrationId,
      after: { refundId: refund.id, paymentId: p.providerPaymentId, amountCents: amount, status: refund.status },
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
    // Admins can also cancel one stuck in "processing"; if Square later reports it charged, it's refunded automatically.
    const allowed = input.householdId
      ? ["pending_payment", "expired"]
      : ["pending_payment", "processing", "expired", "paid", "approved", "rejected"];
    if (!allowed.includes(r.status)) {
      throw new HttpError(
        409,
        "CONFLICT",
        input.householdId ? "Paid registrations can only be cancelled by the league. Please contact us." : "This registration can't be cancelled.",
      );
    }
    const [after] = await tx
      .update(registrations)
      .set({ status: "cancelled", holdExpiresAt: null, paymentRequest: null, processingStartedAt: null, updatedAt: new Date() })
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
    if (r.paidAt) {
      await publish(tx, { name: "registration.cancelled", aggregateType: "registration", aggregateId: r.id });
    }
    return after!;
  });
  let refund = null;
  if (input.refund && !input.householdId) {
    const [p] = await db
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.registrationId, reg.id), inArray(payments.status, COMPLETED), sql`${payments.amountCents} > ${payments.refundedCents}`))
      .limit(1);
    if (p) refund = await refundRegistration(reg.id, { reason: input.reason }, actor);
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
