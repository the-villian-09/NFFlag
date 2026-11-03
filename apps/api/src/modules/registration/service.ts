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
  householdMembers,
  payments,
  players,
  promoCodes,
  refunds,
  registrations,
  rosterEntries,
  seasons,
  waitlistEntries,
} from "../../db/schema/index.js";
import { HttpError } from "../../http/errors.js";
import { logger } from "../../lib/logger.js";
import { WAIVER_SLUGS } from "../content/defaults.js";
import { writeAudit } from "../platform/audit.js";
import { publish } from "../platform/outbox.js";
import { settleRegistrationCode } from "../promo/service.js";
import { completeWithdrawal } from "./withdrawal.js";
import { parseReference } from "../square/client.js";
import { requirePlayerDocs } from "../documents/service.js";
import {
  abandonAction,
  CardDeclinedError,
  chargeCard,
  checkoutConfig,
  GatewaySetupError,
  GatewayUnavailableError,
  refundCard,
  type GatewayPayment,
  type PaymentRequest,
} from "../payments/gateway.js";
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

export type { PaymentRequest };

export const COMPLETED = ["COMPLETED", "APPROVED"];

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
 * Charges the card (a Stripe ConfirmationToken or a Square card nonce). The registration is
 * moved to `processing` first (with the exact request, so the outcome can be
 * recovered if the connection drops) so a double-click can't charge twice.
 */
export async function payRegistration(
  actor: Actor & { userId: string },
  householdId: string,
  registrationId: string,
  input: { sourceId?: string; verificationToken?: string; expectedTotalCents?: number },
  buyerEmail: string,
) {
  const [peek] = await db
    .select({ divisionId: registrations.divisionId, playerId: registrations.playerId, seasonId: registrations.seasonId })
    .from(registrations)
    .where(and(eq(registrations.id, registrationId), eq(registrations.householdId, householdId)));
  if (!peek) throw new HttpError(404, "NOT_FOUND", "Registration not found.");
  // Birth certificate, insurance card and headshot first (while that switch is on).
  await requirePlayerDocs(peek.playerId, peek.seasonId);
  const settings = await getPaymentSettings();
  const checkout = input.sourceId ? await checkoutConfig() : null;
  const [p] = await db.select({ firstName: players.firstName, lastName: players.lastName }).from(players).where(eq(players.id, peek.playerId));

  // One locked transaction decides the amount: the promo code is re-checked under its
  // lock, and what's charged must match what the family was shown.
  const outcome = await db
    .transaction(async (tx) => {
      const { r, holdExpiresAt } = await claimForPayment(tx, registrationId, householdId, peek.divisionId, settings.holdMinutes);
      const codeChange = await settleRegistrationCode(tx, r);
      if (codeChange) return { kind: "changed" as const, message: codeChange };
      if (input.expectedTotalCents !== undefined && input.expectedTotalCents !== r.totalCents) {
        return { kind: "changed" as const, message: `The total is now $${(r.totalCents / 100).toFixed(2)}. No payment was taken; review it and pay again.` };
      }
      // Nothing to charge (free division or a 100% code).
      if (r.totalCents === 0) return { kind: "paid" as const, reg: await markPaid(tx, r, null, actor) };
      if (!input.sourceId) throw new HttpError(400, "VALIDATION_FAILED", "Enter your card details.");
      if (!checkout) throw new HttpError(503, "PAYMENTS_UNAVAILABLE", "Online payment is temporarily unavailable. Please try again later.");
      const request: PaymentRequest = {
        provider: checkout.provider,
        idempotencyKey: randomUUID(),
        sourceId: input.sourceId,
        verificationToken: input.verificationToken,
        amountCents: r.totalCents,
        note: `NFFL registration: ${p?.firstName ?? ""} ${p?.lastName ?? ""}`.trim(),
        buyerEmail,
      };
      await tx
        .update(registrations)
        .set({ status: "processing", paymentError: null, holdExpiresAt, paymentRequest: request, processingStartedAt: new Date(), updatedAt: new Date() })
        .where(eq(registrations.id, r.id));
      return { kind: "charge" as const, request };
    })
    .catch(uniqueAsConflict);

  if (outcome.kind === "changed") {
    // The code change was saved; send the new totals so the page can show them.
    const [fresh] = await db
      .select({ totalCents: registrations.totalCents, discountCents: registrations.discountCents, feeCents: registrations.feeCents, promoCode: promoCodes.code })
      .from(registrations)
      .leftJoin(promoCodes, eq(promoCodes.id, registrations.promoCodeId))
      .where(eq(registrations.id, registrationId));
    throw new HttpError(409, "CONFLICT", outcome.message, { registration: fresh ?? null });
  }
  if (outcome.kind === "paid") return outcome.reg;
  return chargeAndSettle(registrationId, outcome.request, actor);
}

/** Saves a new Stripe PaymentIntent id with the request, so it's read back (not re-sent) next time. */
async function saveIntent(registrationId: string, request: PaymentRequest, intentId: string) {
  await db
    .update(registrations)
    .set({ paymentRequest: { ...request, intentId }, updatedAt: new Date() })
    .where(and(eq(registrations.id, registrationId), eq(registrations.status, "processing")));
}

/**
 * Sends the payment (or asks again about it with the same request) and settles
 * the registration. `abandon`: a bank check (3-D Secure) left unfinished is
 * cancelled so the family can try again.
 */
async function chargeAndSettle(registrationId: string, request: PaymentRequest, actor: Actor, opts: { abandon?: boolean } = {}) {
  let payment: GatewayPayment;
  try {
    payment = await chargeCard(request, registrationId, (intentId) => saveIntent(registrationId, request, intentId));
    if (opts.abandon) payment = await abandonAction(payment);
  } catch (err) {
    if (err instanceof GatewayUnavailableError) {
      throw new HttpError(503, "PAYMENTS_UNAVAILABLE", "Online payment is temporarily unavailable. Please try again later.");
    }
    if (err instanceof CardDeclinedError) {
      await revertToPending(registrationId, err.message);
      logger.info({ registrationId, provider: request.provider ?? "square" }, "card payment declined");
      throw new HttpError(402, "PAYMENT_FAILED", err.message);
    }
    if (err instanceof GatewaySetupError) {
      // Our setup (keys, account) or request is wrong: not the family's card.
      await revertToPending(registrationId, "Payment setup problem (not the card).");
      logger.error({ registrationId, provider: request.provider ?? "square", detail: err.message }, "payment provider rejected the request: check payment settings");
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
    const reg = await recordCompletedPayment(payment, actor);
    if (!reg || reg.status !== "paid") {
      throw new HttpError(409, "DIVISION_FULL", "The division filled up before your payment finished. Your payment is being refunded.");
    }
    return reg;
  }
  if (payment.status === "ACTION_REQUIRED") {
    throw new HttpError(402, "PAYMENT_ACTION_REQUIRED", "Your bank needs you to confirm this payment.", { clientSecret: payment.clientSecret });
  }
  if (payment.status === "FAILED" || payment.status === "CANCELED") {
    const message = payment.failureMessage ?? "The payment didn't go through. Please try again.";
    await revertToPending(registrationId, message);
    throw new HttpError(402, "PAYMENT_FAILED", message);
  }
  // PENDING: the provider hasn't finished; the webhook or the worker settles it.
  throw new HttpError(502, "PAYMENT_PENDING", "Your payment is still being confirmed. Please don't pay again; check your registrations in a few minutes.");
}

/**
 * After the family finishes (or abandons) their bank's check in the browser:
 * settle the payment, or cancel it so they can try again.
 */
export async function confirmRegistrationPayment(actor: Actor & { userId: string }, householdId: string, registrationId: string) {
  const [r] = await db
    .select()
    .from(registrations)
    .where(and(eq(registrations.id, registrationId), eq(registrations.householdId, householdId)));
  if (!r) throw new HttpError(404, "NOT_FOUND", "Registration not found.");
  if (r.paidAt) return r;
  if (r.status !== "processing" || !r.paymentRequest) {
    if (r.paymentError) throw new HttpError(402, "PAYMENT_FAILED", r.paymentError);
    throw new HttpError(409, "CONFLICT", "There's no payment waiting to be confirmed.");
  }
  return chargeAndSettle(r.id, r.paymentRequest as PaymentRequest, actor, { abandon: true });
}

/** A charge that definitely didn't happen: the family can try again. */
export async function revertToPending(registrationId: string, message: string, failedPaymentCreatedAt?: Date) {
  await db
    .update(registrations)
    .set({ status: "pending_payment", paymentError: message, paymentRequest: null, processingStartedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(registrations.id, registrationId),
        eq(registrations.status, "processing"),
        // From the webhook: only if that failed payment belongs to the current attempt, not an older declined card.
        failedPaymentCreatedAt ? sql`${registrations.processingStartedAt} <= ${failedPaymentCreatedAt.toISOString()}::timestamptz + interval '2 seconds'` : undefined,
      ),
    );
}

/**
 * Worker: registrations stuck in `processing` (connection dropped, server
 * restarted, bank check never finished) are asked about again with the same
 * request: the provider returns the original result if it charged, or an error
 * if it never did. A bank check still unfinished after 30 minutes is cancelled.
 */
export async function reconcileProcessing(olderThanMinutes = 5) {
  const stuck = await db
    .select({
      id: registrations.id,
      paymentRequest: registrations.paymentRequest,
      abandon: sql<boolean>`${registrations.processingStartedAt} < now() - interval '30 minutes'`,
    })
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
      await chargeAndSettle(s.id, s.paymentRequest as PaymentRequest, { userId: null }, { abandon: s.abandon });
      settled++;
    } catch (err) {
      if (err instanceof HttpError && !["PAYMENT_PENDING", "PAYMENTS_UNAVAILABLE", "PAYMENT_ACTION_REQUIRED"].includes(err.code)) settled++;
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
 * Records a completed card payment against its registration (from checkout,
 * the worker or the webhook; safe to repeat). Refunds it automatically when it
 * can't be kept: the spot was released (D-05) or it duplicates an earlier payment.
 */
export async function recordCompletedPayment(payment: GatewayPayment, actor: Actor) {
  const outcome = await db.transaction(async (tx) => {
    const ref = parseReference(payment.referenceId);
    if (!ref || !("registrationId" in ref)) return { reg: null, refundPaymentId: null as string | null, reason: "" };
    const [r] = await tx.select().from(registrations).where(eq(registrations.id, ref.registrationId)).for("update");
    if (!r) return { reg: null, refundPaymentId: null as string | null, reason: "" };
    const [row] = await tx
      .insert(payments)
      .values({
        registrationId: r.id,
        provider: payment.provider,
        providerEnvironment: payment.environment,
        providerPaymentId: payment.id,
        merchantId: payment.merchantId,
        locationId: payment.locationId ?? null,
        status: payment.status,
        amountCents: payment.amountCents ?? r.totalCents,
        cardBrand: payment.cardBrand ?? null,
        cardLast4: payment.cardLast4 ?? null,
        receiptUrl: payment.receiptUrl ?? null,
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

    // A payment for a different amount than the registration now costs (for
    // example a promo code removed after an abandoned payment) is given back.
    if (payment.amountCents != null && payment.amountCents !== r.totalCents) {
      if (r.status === "processing") {
        await tx
          .update(registrations)
          .set({
            status: "pending_payment",
            paymentRequest: null,
            processingStartedAt: null,
            paymentError: "That payment didn't match the current total, so it's being refunded. Please pay again.",
            updatedAt: new Date(),
          })
          .where(eq(registrations.id, r.id));
      }
      return refunding ? keep : { ...keep, refundPaymentId: row!.id, reason: "Payment didn't match the registration total" };
    }

    let lostSpot = r.status === "cancelled" || r.status === "rejected";
    // The spot was held only until holdExpiresAt: once that has passed (expired,
    // or not yet swept by the worker), a late payment keeps it only if there's still room.
    if (r.status === "expired" || (r.holdExpiresAt && r.holdExpiresAt.getTime() <= Date.now())) {
      const d = await lockDivision(tx, r.divisionId);
      lostSpot = lostSpot || (await spotsTaken(tx, d.id, r.id)) >= d.capacity;
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
    await autoRefund({ registrationId: outcome.reg.id }, outcome.refundPaymentId, outcome.reason);
  }
  return outcome.reg;
}

/* ---------------- refunds ---------------- */

/** Who a payment belongs to. */
export type PaymentOwner = { registrationId: string } | { applicationId: string };

const ownerFilter = (o: PaymentOwner) =>
  "registrationId" in o ? eq(payments.registrationId, o.registrationId) : eq(payments.applicationId, o.applicationId);

/** Refunds part or all of what's left on a registration's payment (see issueRefund). */
export function refundRegistration(registrationId: string, input: { amountCents?: number; reason: string; paymentId?: string }, actor: Actor) {
  return issueRefund({ registrationId }, input, actor);
}

/**
 * Refunds part or all of what's left on a payment (the owner's most recent one
 * with money left, unless `paymentId` is given). The amount is reserved under a
 * row lock before calling the provider, so two clicks can't both refund the same money.
 * The refund goes through the provider that took the payment.
 */
export async function issueRefund(owner: PaymentOwner, input: { amountCents?: number; reason: string; paymentId?: string }, actor: Actor) {
  const target = refundTarget(owner);

  const { p, amount, refundRowId, idempotencyKey } = await db.transaction(async (tx) => {
    const [p] = await tx
      .select()
      .from(payments)
      .where(
        and(
          ownerFilter(owner),
          inArray(payments.status, COMPLETED),
          input.paymentId ? eq(payments.id, input.paymentId) : sql`${payments.amountCents} > ${payments.refundedCents}`,
        ),
      )
      .orderBy(desc(payments.createdAt))
      .limit(1)
      .for("update");
    if (!p) throw new HttpError(409, "CONFLICT", "There's no completed payment to refund.");
    const [stuck] = await tx
      .select({ id: refunds.id })
      .from(refunds)
      .where(and(eq(refunds.paymentId, p.id), eq(refunds.status, "SUBMITTING")))
      .limit(1);
    if (stuck) {
      throw new HttpError(409, "CONFLICT", "A refund of this payment is still being confirmed with the card processor. Check back in a few minutes before refunding again.");
    }
    const remaining = p.amountCents - p.refundedCents;
    const amount = input.amountCents ?? remaining;
    if (amount <= 0 || amount > remaining) {
      throw new HttpError(400, "VALIDATION_FAILED", `You can refund up to $${(remaining / 100).toFixed(2)}.`);
    }
    await tx
      .update(payments)
      .set({ refundedCents: sql`${payments.refundedCents} + ${amount}`, updatedAt: new Date() })
      .where(eq(payments.id, p.id));
    // Recorded before the card processor is asked, so an answer that never
    // arrives can be asked about again with the same key instead of refunding twice.
    const idempotencyKey = randomUUID();
    const [row] = await tx
      .insert(refunds)
      .values({ paymentId: p.id, status: "SUBMITTING", amountCents: amount, reason: input.reason, issuedBy: actor.userId, idempotencyKey })
      .returning({ id: refunds.id });
    return { p, amount, refundRowId: row!.id, idempotencyKey };
  });

  const result = await submitRefund({ refundRowId, idempotencyKey, payment: p, amountCents: amount, reason: input.reason });
  if (result.kind === "refused") {
    if (result.error instanceof GatewayUnavailableError) throw new HttpError(503, "PAYMENTS_UNAVAILABLE", result.error.message);
    if (result.error instanceof GatewaySetupError) throw new HttpError(409, "CONFLICT", result.error.message);
    const provider = p.provider === "stripe" ? "Stripe" : "Square";
    throw new HttpError(502, "PAYMENT_FAILED", `${provider} refused the refund: ${result.error instanceof Error ? result.error.message : "unknown error"}`);
  }
  if (result.kind === "unknown") {
    throw new HttpError(
      502,
      "REFUND_PENDING",
      "The card processor didn't answer in time. The refund is being confirmed automatically; don't refund again. Check back in a few minutes.",
    );
  }

  await db.transaction(async (tx) => {
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: `${target.type}.refund`,
      targetType: target.type,
      targetId: target.id,
      after: { refundId: result.refund.id, paymentId: p.providerPaymentId, amountCents: amount, status: result.refund.status },
      reason: input.reason,
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    await publish(tx, {
      name: target.event,
      aggregateType: target.type,
      aggregateId: target.id,
      payload: { amountCents: amount },
      dedupeKey: `${target.event}:${result.refund.id}`,
    });
  });
  return { refundId: result.refund.id, amountCents: amount, status: result.refund.status };
}

/** Admins can't decide, cancel or refund their own household's registrations. */
export async function refuseOwnRegistration(registrationId: string, userId: string) {
  const [mine] = await db
    .select({ id: registrations.id })
    .from(registrations)
    .innerJoin(householdMembers, eq(householdMembers.householdId, registrations.householdId))
    .where(and(eq(registrations.id, registrationId), eq(householdMembers.userId, userId)))
    .limit(1);
  if (mine) throw new HttpError(403, "FORBIDDEN", "Another admin needs to handle your own family's registration.");
}

function refundTarget(owner: PaymentOwner) {
  return "registrationId" in owner
    ? { type: "registration", id: owner.registrationId, event: "registration.refunded" as const }
    : { type: "volunteer_application", id: owner.applicationId, event: "staff.application_refunded" as const };
}

/** A provider answer that means the refund definitely didn't happen. */
function definitelyRefused(err: unknown) {
  if (err instanceof GatewayUnavailableError || err instanceof GatewaySetupError || err instanceof CardDeclinedError) return true;
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 409 && status !== 429;
}

type PaymentRow = typeof payments.$inferSelect;

/**
 * Sends (or re-sends, with the same key) a refund recorded as SUBMITTING and
 * settles our records: done → the provider's id and status; definitely
 * refused → the reservation is given back; no answer → left for the worker.
 */
async function submitRefund(r: { refundRowId: string; idempotencyKey: string; payment: PaymentRow; amountCents: number; reason: string }) {
  const release = (tx: DbOrTx) =>
    tx
      .update(payments)
      .set({ refundedCents: sql`greatest(0, ${payments.refundedCents} - ${r.amountCents})`, updatedAt: new Date() })
      .where(eq(payments.id, r.payment.id));
  let refund: { id: string; status: string };
  try {
    refund = await refundCard({
      provider: r.payment.provider,
      environment: r.payment.providerEnvironment,
      paymentId: r.payment.providerPaymentId,
      amountCents: r.amountCents,
      idempotencyKey: r.idempotencyKey,
      reason: r.reason,
    });
  } catch (err) {
    if (!definitelyRefused(err)) {
      logger.error({ refundId: r.refundRowId, err: err instanceof Error ? err.message : String(err) }, "refund outcome unknown; the worker will ask again");
      return { kind: "unknown" as const };
    }
    await db.transaction(async (tx) => {
      const [gone] = await tx.delete(refunds).where(and(eq(refunds.id, r.refundRowId), eq(refunds.status, "SUBMITTING"))).returning({ id: refunds.id });
      if (gone) await release(tx);
    });
    return { kind: "refused" as const, error: err };
  }
  await db.transaction(async (tx) => {
    // The webhook may already have recorded (and counted) this refund under the provider's id.
    const [webhookRow] = await tx.select({ id: refunds.id }).from(refunds).where(eq(refunds.providerRefundId, refund.id));
    if (webhookRow) {
      const [gone] = await tx.delete(refunds).where(and(eq(refunds.id, r.refundRowId), eq(refunds.status, "SUBMITTING"))).returning({ id: refunds.id });
      if (gone) {
        await release(tx);
        await tx.update(refunds).set({ reason: r.reason, updatedAt: new Date() }).where(eq(refunds.id, webhookRow.id));
      }
      return;
    }
    await tx
      .update(refunds)
      .set({ providerRefundId: refund.id, status: refund.status, updatedAt: new Date() })
      .where(eq(refunds.id, r.refundRowId));
    if (refund.status === "FAILED" || refund.status === "REJECTED") await release(tx);
  });
  return { kind: "done" as const, refund };
}

/** Worker: refunds whose answer never arrived are asked about again with their original key. */
export async function retrySubmittingRefunds(limit = 20) {
  const rows = await db
    .select({ refund: refunds, payment: payments })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(and(eq(refunds.status, "SUBMITTING"), sql`${refunds.createdAt} < now() - interval '2 minutes'`))
    .limit(limit);
  let settled = 0;
  for (const { refund, payment } of rows) {
    if (!refund.idempotencyKey) continue;
    const res = await submitRefund({ refundRowId: refund.id, idempotencyKey: refund.idempotencyKey, payment, amountCents: refund.amountCents, reason: refund.reason });
    if (res.kind !== "unknown") settled++;
  }
  return settled;
}

/**
 * A payment we must give back (duplicate, late, wrong amount). Marks it so the
 * worker keeps trying if the refund can't go through right now.
 */
export async function autoRefund(owner: PaymentOwner, paymentId: string, reason: string) {
  await db.update(payments).set({ autoRefundReason: reason, autoRefundAttemptAt: new Date() }).where(eq(payments.id, paymentId));
  try {
    await issueRefund(owner, { reason, paymentId }, { userId: null });
    await db.update(payments).set({ autoRefundReason: null }).where(eq(payments.id, paymentId));
  } catch (err) {
    logger.error({ paymentId, err: err instanceof Error ? err.message : String(err) }, "automatic refund didn't go through; the worker will retry");
  }
}

/** Worker: automatic refunds that didn't go through, retried every 15 minutes. */
export async function retryAutoRefunds(limit = 20) {
  const rows = await db
    .select()
    .from(payments)
    .where(
      and(
        sql`${payments.autoRefundReason} is not null`,
        sql`coalesce(${payments.autoRefundAttemptAt}, 'epoch'::timestamptz) < now() - interval '15 minutes'`,
      ),
    )
    .limit(limit);
  for (const p of rows) {
    const [open] = await db.select({ id: refunds.id }).from(refunds).where(and(eq(refunds.paymentId, p.id), eq(refunds.status, "SUBMITTING"))).limit(1);
    if (p.refundedCents >= p.amountCents && !open) {
      await db.update(payments).set({ autoRefundReason: null }).where(eq(payments.id, p.id));
      continue;
    }
    if (open) continue;
    const owner: PaymentOwner = p.registrationId ? { registrationId: p.registrationId } : { applicationId: p.applicationId! };
    await autoRefund(owner, p.id, p.autoRefundReason!);
  }
  return rows.length;
}

/**
 * Refunds every completed payment of an owner that still has money left (an
 * original and any duplicate), each by its own payment id. Returns what was
 * refunded and any failures, without throwing, so a decision that already
 * committed still reports which refunds need retrying.
 */
export async function refundAll(owner: PaymentOwner, reason: string, actor: Actor) {
  const open = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(ownerFilter(owner), inArray(payments.status, COMPLETED), sql`${payments.amountCents} > ${payments.refundedCents}`))
    .orderBy(asc(payments.createdAt));
  const refunded: Awaited<ReturnType<typeof issueRefund>>[] = [];
  const failed: string[] = [];
  for (const p of open) {
    try {
      refunded.push(await issueRefund(owner, { reason, paymentId: p.id }, actor));
    } catch (err) {
      failed.push(err instanceof Error ? err.message : String(err));
      logger.error({ owner, paymentId: p.id, err: failed.at(-1) }, "refund failed; retry from the admin portal");
    }
  }
  const amountCents = refunded.reduce((n, r) => n + r.amountCents, 0);
  return { amountCents, status: refunded[0]?.status ?? null, refunds: refunded, error: failed[0] ?? null };
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
    // Leaving the league means leaving their team.
    if (input.decision === "rejected") {
      await tx.delete(rosterEntries).where(eq(rosterEntries.registrationId, r.id));
      await completeWithdrawal(tx, r.id, actor.userId);
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
    refund = await refundAll({ registrationId: reg.id }, input.reason || "Registration not accepted", actor);
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
    // Leaving the league means leaving their team.
    await tx.delete(rosterEntries).where(eq(rosterEntries.registrationId, r.id));
    await completeWithdrawal(tx, r.id, actor.userId);
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
    if (p) refund = await refundAll({ registrationId: reg.id }, input.reason, actor);
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
