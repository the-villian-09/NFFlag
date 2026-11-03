/**
 * Coach and team staff applications (R2): Head Coach, Assistant Coach, Team Mom.
 *
 * Apply (with the code of conduct) → pay the coaching badge / team mom fee →
 * submitted → admin records the background check → approved (role granted for
 * the season) or rejected (fee refunded). Payments reuse the registration
 * safeguards: a `processing` state with the exact payment request stored, so
 * the worker can re-send it with the same idempotency key if the response is
 * lost; refunds go through the shared race-safe issueRefund.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { db } from "../../db/client.js";
import { contentPages, divisions, householdMembers, payments, players, promoCodes, refunds, seasons, userRoleAssignments, volunteerApplications } from "../../db/schema/index.js";
import { HttpError } from "../../http/errors.js";
import { logger } from "../../lib/logger.js";
import { writeAudit } from "../platform/audit.js";
import { isEnabled } from "../platform/flags.js";
import { publish } from "../platform/outbox.js";
import { autoRefund, COMPLETED, isUniqueViolation, issueRefund, refundAll, type Actor, type PaymentRequest } from "../registration/service.js";
import { PROMO_FLAG, settleApplicationCode, submitFreeApplication } from "../promo/service.js";
import { removeFromSeasonTeams } from "../teams/service.js";
import { getPaymentSettings, quote } from "../registration/settings.js";
import { parseReference } from "../square/client.js";
import { documentsRequired, requireStaffPhoto } from "../documents/service.js";
import {
  abandonAction,
  CardDeclinedError,
  chargeCard,
  checkoutConfig,
  GatewaySetupError,
  GatewayUnavailableError,
  type GatewayPayment,
} from "../payments/gateway.js";

export const STAFF_FLAG = "r2.staff_applications";
export const VOLUNTEER_ROLES = ["head_coach", "assistant_coach", "team_manager"] as const;
export type VolunteerRole = (typeof VOLUNTEER_ROLES)[number];
export const ROLE_LABELS: Record<VolunteerRole, string> = {
  head_coach: "Head Coach",
  assistant_coach: "Assistant Coach",
  team_manager: "Team Mom",
};
/** What the fee is called (the flyer's wording). */
export const feeLabel = (role: string) => (role === "team_manager" ? "Team mom fee" : "Coaching badge fee");
const AGREEMENT_SLUG = "volunteer-agreement";
/** Payment reference for an application payment (max 40 chars). */
export const appReference = (id: string) => `app:${id}`;

type Application = typeof volunteerApplications.$inferSelect;

async function currentSeason() {
  const [s] = await db.select().from(seasons).where(eq(seasons.isCurrent, "current")).limit(1);
  return s ?? null;
}

export async function volunteerOptions() {
  const enabled = await isEnabled(STAFF_FLAG);
  const season = await currentSeason();
  const settings = await getPaymentSettings();
  const [agreement] = await db.select().from(contentPages).where(eq(contentPages.slug, AGREEMENT_SLUG));
  const checkout = await checkoutConfig();
  const divs = season
    ? await db
        .select({ id: divisions.id, name: divisions.name })
        .from(divisions)
        .where(and(eq(divisions.seasonId, season.id), sql`${divisions.status} <> 'draft'`))
        .orderBy(asc(divisions.sortOrder), asc(divisions.name))
    : [];
  return {
    enabled: enabled && !!season,
    season: season ? { id: season.id, name: season.name } : null,
    roles: VOLUNTEER_ROLES.map((key) => ({ key, label: ROLE_LABELS[key], ...quote(settings.volunteerFees[key], settings) })),
    divisions: divs,
    promoCodes: await isEnabled(PROMO_FLAG),
    agreement: agreement ? { slug: agreement.slug, title: agreement.title, body: agreement.body, isPlaceholder: agreement.isPlaceholder } : null,
    // Public values for the card form; null = payments unavailable right now.
    checkout,
    // A headshot is required before paying.
    photoRequired: await documentsRequired(),
  };
}

export async function applyToVolunteer(
  actor: Actor & { userId: string },
  input: {
    roleKey: VolunteerRole;
    preferredDivisionId?: string;
    playerId?: string;
    phone: string;
    experience?: string;
    notes?: string;
    shirtSize?: string;
    signerName: string;
    acceptAgreement: boolean;
  },
) {
  if (!(await isEnabled(STAFF_FLAG))) throw new HttpError(403, "FEATURE_DISABLED", "Coach and team staff applications aren't open yet.");
  const season = await currentSeason();
  if (!season) throw new HttpError(409, "CONFLICT", "There's no current season.");
  const [agreement] = await db.select().from(contentPages).where(eq(contentPages.slug, AGREEMENT_SLUG));
  if (agreement && !input.acceptAgreement) throw new HttpError(400, "VALIDATION_FAILED", `Please accept the ${agreement.title.toLowerCase()}.`);
  if (input.preferredDivisionId) {
    const [d] = await db.select({ id: divisions.id }).from(divisions).where(and(eq(divisions.id, input.preferredDivisionId), eq(divisions.seasonId, season.id)));
    if (!d) throw new HttpError(400, "VALIDATION_FAILED", "Choose a division from this season.");
  }
  if (input.playerId) {
    const [own] = await db
      .select({ id: players.id })
      .from(players)
      .innerJoin(householdMembers, eq(householdMembers.householdId, players.householdId))
      .where(and(eq(players.id, input.playerId), eq(householdMembers.userId, actor.userId)));
    if (!own) throw new HttpError(404, "NOT_FOUND", "Player not found.");
  }
  const settings = await getPaymentSettings();
  const q = quote(settings.volunteerFees[input.roleKey], settings);
  try {
    return await db.transaction(async (tx) => {
      const [app] = await tx
        .insert(volunteerApplications)
        .values({
          seasonId: season.id,
          userId: actor.userId,
          roleKey: input.roleKey,
          preferredDivisionId: input.preferredDivisionId ?? null,
          playerId: input.playerId ?? null,
          phone: input.phone,
          experience: input.experience ?? null,
          notes: input.notes ?? null,
          shirtSize: input.shirtSize ?? null,
          agreements: agreement
            ? [
                {
                  slug: agreement.slug,
                  title: agreement.title,
                  version: agreement.updatedAt.toISOString(),
                  sha256: createHash("sha256").update(agreement.body).digest("hex"),
                  signerName: input.signerName,
                  acceptedAt: new Date().toISOString(),
                },
              ]
            : [],
          feeCents: q.priceCents,
          processingFeeCents: q.feeCents,
          totalCents: q.totalCents,
          // Free roles skip payment.
          status: q.totalCents === 0 ? "submitted" : "pending_payment",
        })
        .returning();
      await writeAudit(tx, {
        actorUserId: actor.userId,
        action: "staff.application.create",
        targetType: "volunteer_application",
        targetId: app!.id,
        after: { roleKey: app!.roleKey, seasonId: season.id },
        requestId: actor.requestId,
        ipAddress: actor.ip,
      });
      if (app!.status === "submitted") {
        await publish(tx, { name: "staff.application_submitted", aggregateType: "volunteer_application", aggregateId: app!.id });
      }
      return app!;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "CONFLICT", `You already have an application for ${ROLE_LABELS[input.roleKey].toLowerCase()} this season.`);
    throw err;
  }
}

/* ---------------- payment ---------------- */

export async function payApplication(
  actor: Actor & { userId: string },
  applicationId: string,
  input: { sourceId?: string; verificationToken?: string; expectedTotalCents?: number },
  buyerEmail: string,
) {
  const [own] = await db
    .select({ seasonId: volunteerApplications.seasonId })
    .from(volunteerApplications)
    .where(and(eq(volunteerApplications.id, applicationId), eq(volunteerApplications.userId, actor.userId)));
  if (!own) throw new HttpError(404, "NOT_FOUND", "Application not found.");
  await requireStaffPhoto(actor.userId, own.seasonId, "paying the fee");
  const checkout = input.sourceId ? await checkoutConfig() : null;
  // One locked transaction decides the amount: the promo code is re-checked under its
  // lock, and what's charged must match what the applicant was shown.
  const outcome = await db.transaction(async (tx) => {
    const [a] = await tx
      .select()
      .from(volunteerApplications)
      .where(and(eq(volunteerApplications.id, applicationId), eq(volunteerApplications.userId, actor.userId)))
      .for("update");
    if (!a) throw new HttpError(404, "NOT_FOUND", "Application not found.");
    if (a.status === "processing") throw new HttpError(409, "CONFLICT", "This payment is already being processed.");
    if (a.status !== "pending_payment") throw new HttpError(409, "CONFLICT", "This application doesn't need a payment.");
    const codeChange = await settleApplicationCode(tx, a);
    if (codeChange) return { kind: "changed" as const, message: codeChange };
    if (input.expectedTotalCents !== undefined && input.expectedTotalCents !== a.totalCents) {
      return { kind: "changed" as const, message: `The total is now $${(a.totalCents / 100).toFixed(2)}. No payment was taken; review it and pay again.` };
    }
    // Fee fully covered by a promo code: submit without a card.
    if (a.totalCents === 0) return { kind: "done" as const, app: await submitFreeApplication(tx, a, actor) };
    if (!input.sourceId) throw new HttpError(400, "VALIDATION_FAILED", "Enter your card details.");
    if (!checkout) throw new HttpError(503, "PAYMENTS_UNAVAILABLE", "Online payment is temporarily unavailable. Please try again later.");
    const request: PaymentRequest = {
      provider: checkout.provider,
      idempotencyKey: randomUUID(),
      sourceId: input.sourceId,
      verificationToken: input.verificationToken,
      amountCents: a.totalCents,
      note: `NFFL ${feeLabel(a.roleKey).toLowerCase()}: ${ROLE_LABELS[a.roleKey as VolunteerRole]}`,
      buyerEmail,
    };
    await tx
      .update(volunteerApplications)
      .set({ status: "processing", paymentError: null, paymentRequest: request, processingStartedAt: new Date(), updatedAt: new Date() })
      .where(eq(volunteerApplications.id, a.id));
    return { kind: "charge" as const, request };
  });
  if (outcome.kind === "changed") {
    const [fresh] = await db
      .select({ totalCents: volunteerApplications.totalCents, discountCents: volunteerApplications.discountCents, processingFeeCents: volunteerApplications.processingFeeCents, promoCode: promoCodes.code })
      .from(volunteerApplications)
      .leftJoin(promoCodes, eq(promoCodes.id, volunteerApplications.promoCodeId))
      .where(eq(volunteerApplications.id, applicationId));
    throw new HttpError(409, "CONFLICT", outcome.message, { application: fresh ?? null });
  }
  if (outcome.kind === "done") return outcome.app;
  return chargeApplication(applicationId, outcome.request, actor);
}

async function revertApplication(applicationId: string, message: string, failedPaymentCreatedAt?: Date) {
  await db
    .update(volunteerApplications)
    .set({ status: "pending_payment", paymentError: message, paymentRequest: null, processingStartedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(volunteerApplications.id, applicationId),
        eq(volunteerApplications.status, "processing"),
        // From the webhook: only if that failed payment belongs to the current attempt.
        failedPaymentCreatedAt ? sql`${volunteerApplications.processingStartedAt} <= ${failedPaymentCreatedAt.toISOString()}::timestamptz + interval '2 seconds'` : undefined,
      ),
    );
}

async function chargeApplication(applicationId: string, request: PaymentRequest, actor: Actor, opts: { abandon?: boolean } = {}) {
  let payment: GatewayPayment;
  try {
    payment = await chargeCard(request, appReference(applicationId), async (intentId) => {
      await db
        .update(volunteerApplications)
        .set({ paymentRequest: { ...request, intentId }, updatedAt: new Date() })
        .where(and(eq(volunteerApplications.id, applicationId), eq(volunteerApplications.status, "processing")));
    });
    if (opts.abandon) payment = await abandonAction(payment);
  } catch (err) {
    if (err instanceof GatewayUnavailableError) {
      throw new HttpError(503, "PAYMENTS_UNAVAILABLE", "Online payment is temporarily unavailable. Please try again later.");
    }
    if (err instanceof CardDeclinedError) {
      await revertApplication(applicationId, err.message);
      throw new HttpError(402, "PAYMENT_FAILED", err.message);
    }
    if (err instanceof GatewaySetupError) {
      await revertApplication(applicationId, "Payment setup problem (not the card).");
      logger.error({ applicationId, provider: request.provider ?? "square", detail: err.message }, "payment provider rejected the volunteer fee request: check payment settings");
      throw new HttpError(503, "PAYMENTS_UNAVAILABLE", "We couldn't process payments just now because of a problem on our side. Your card was not charged.");
    }
    logger.error({ applicationId, err: err instanceof Error ? err.message : String(err) }, "volunteer fee outcome unknown");
    throw new HttpError(502, "PAYMENT_PENDING", "We couldn't confirm your payment yet. Please don't pay again; check back in a few minutes.");
  }
  if (COMPLETED.includes(payment.status)) {
    const app = await recordApplicationPayment(payment, actor);
    if (!app || app.status !== "submitted") throw new HttpError(409, "CONFLICT", "This application was closed before your payment finished. It's being refunded.");
    return app;
  }
  if (payment.status === "ACTION_REQUIRED") {
    throw new HttpError(402, "PAYMENT_ACTION_REQUIRED", "Your bank needs you to confirm this payment.", { clientSecret: payment.clientSecret });
  }
  if (payment.status === "FAILED" || payment.status === "CANCELED") {
    const message = payment.failureMessage ?? "The payment didn't go through. Please try again.";
    await revertApplication(applicationId, message);
    throw new HttpError(402, "PAYMENT_FAILED", message);
  }
  throw new HttpError(502, "PAYMENT_PENDING", "Your payment is still being confirmed. Please don't pay again; check back in a few minutes.");
}

/** After the applicant finishes (or abandons) their bank's check: settle the payment, or cancel it so they can try again. */
export async function confirmApplicationPayment(actor: Actor & { userId: string }, applicationId: string) {
  const [a] = await db
    .select()
    .from(volunteerApplications)
    .where(and(eq(volunteerApplications.id, applicationId), eq(volunteerApplications.userId, actor.userId)));
  if (!a) throw new HttpError(404, "NOT_FOUND", "Application not found.");
  if (a.paidAt) return a;
  if (a.status !== "processing" || !a.paymentRequest) {
    if (a.paymentError) throw new HttpError(402, "PAYMENT_FAILED", a.paymentError);
    throw new HttpError(409, "CONFLICT", "There's no payment waiting to be confirmed.");
  }
  return chargeApplication(a.id, a.paymentRequest as PaymentRequest, actor, { abandon: true });
}

/**
 * Records a completed fee payment (checkout, worker or webhook; safe to repeat).
 * Refunds it automatically if the application was withdrawn or rejected
 * meanwhile, or if it duplicates an earlier payment.
 */
export async function recordApplicationPayment(payment: GatewayPayment, actor: Actor) {
  const ref = parseReference(payment.referenceId);
  if (!ref || !("applicationId" in ref)) return null;
  const id = ref.applicationId;
  const outcome = await db.transaction(async (tx) => {
    const [a] = await tx.select().from(volunteerApplications).where(eq(volunteerApplications.id, id)).for("update");
    if (!a) return { app: null as Application | null, refundPaymentId: null as string | null, reason: "" };
    const [row] = await tx
      .insert(payments)
      .values({
        applicationId: a.id,
        provider: payment.provider,
        providerEnvironment: payment.environment,
        providerPaymentId: payment.id,
        merchantId: payment.merchantId,
        locationId: payment.locationId ?? null,
        status: payment.status,
        amountCents: payment.amountCents ?? a.totalCents,
        cardBrand: payment.cardBrand ?? null,
        cardLast4: payment.cardLast4 ?? null,
        receiptUrl: payment.receiptUrl ?? null,
      })
      .onConflictDoUpdate({ target: payments.providerPaymentId, set: { status: payment.status, updatedAt: new Date() } })
      .returning();
    const [anyRefund] = await tx.select({ id: refunds.id }).from(refunds).where(eq(refunds.paymentId, row!.id)).limit(1);
    const refunding = row!.refundedCents > 0 || !!anyRefund;
    const keep = { app: a, refundPaymentId: null as string | null, reason: "" };
    if (a.paidAt) {
      const [first] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(and(eq(payments.applicationId, a.id), inArray(payments.status, COMPLETED)))
        .orderBy(asc(payments.createdAt), asc(payments.id))
        .limit(1);
      if (first && first.id !== row!.id && !refunding) return { ...keep, refundPaymentId: row!.id, reason: "Duplicate payment" };
      return keep;
    }
    if (a.status === "withdrawn" || a.status === "rejected") {
      return refunding ? keep : { ...keep, refundPaymentId: row!.id, reason: "Application was closed before payment finished" };
    }
    // A payment for a different amount than the fee now is (e.g. a promo code
    // removed after an abandoned payment) is given back; they can pay again.
    if (payment.amountCents != null && payment.amountCents !== a.totalCents) {
      if (a.status === "processing") {
        await tx
          .update(volunteerApplications)
          .set({
            status: "pending_payment",
            paymentRequest: null,
            processingStartedAt: null,
            paymentError: "That payment didn't match the current fee, so it's being refunded. Please pay again.",
            updatedAt: new Date(),
          })
          .where(eq(volunteerApplications.id, a.id));
      }
      return refunding ? keep : { ...keep, refundPaymentId: row!.id, reason: "Payment didn't match the fee" };
    }
    const [after] = await tx
      .update(volunteerApplications)
      .set({ status: "submitted", paidAt: new Date(), paymentError: null, paymentRequest: null, processingStartedAt: null, updatedAt: new Date() })
      .where(eq(volunteerApplications.id, a.id))
      .returning();
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "staff.application.paid",
      targetType: "volunteer_application",
      targetId: a.id,
      after: { paymentId: payment.id, amountCents: payment.amountCents },
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    await publish(tx, { name: "staff.application_submitted", aggregateType: "volunteer_application", aggregateId: a.id, dedupeKey: `staff.submitted:${a.id}` });
    return { ...keep, app: after! };
  });
  if (outcome.refundPaymentId && outcome.app) {
    await autoRefund({ applicationId: outcome.app.id }, outcome.refundPaymentId, outcome.reason);
  }
  return outcome.app;
}

/** Webhook: a FAILED/CANCELED fee payment frees the application to try again (only for the current attempt). */
export async function failApplicationPayment(payment: GatewayPayment) {
  const ref = parseReference(payment.referenceId);
  if (!ref || !("applicationId" in ref) || !payment.createdAt) return;
  await revertApplication(ref.applicationId, payment.failureMessage ?? "The payment didn't go through.", payment.createdAt);
}

/** What an applicant may see about their own application (no screening notes or admin fields). */
export function publicApplication(a: Application) {
  return {
    id: a.id,
    roleKey: a.roleKey,
    roleLabel: ROLE_LABELS[a.roleKey as VolunteerRole],
    status: a.status,
    totalCents: a.totalCents,
    feeCents: a.feeCents,
    processingFeeCents: a.processingFeeCents,
    discountCents: a.discountCents,
    paymentError: a.paymentError,
    decisionReason: a.decisionReason,
    createdAt: a.createdAt,
  };
}

/** Worker: ask again about stuck fee payments (same request) to learn the outcome; cancel a bank check left unfinished for 30 minutes. */
export async function reconcileApplications(olderThanMinutes = 5) {
  const stuck = await db
    .select({
      id: volunteerApplications.id,
      paymentRequest: volunteerApplications.paymentRequest,
      abandon: sql<boolean>`${volunteerApplications.processingStartedAt} < now() - interval '30 minutes'`,
    })
    .from(volunteerApplications)
    .where(and(eq(volunteerApplications.status, "processing"), sql`${volunteerApplications.processingStartedAt} < now() - make_interval(mins => ${olderThanMinutes})`))
    .limit(25);
  let settled = 0;
  for (const s of stuck) {
    if (!s.paymentRequest) continue;
    try {
      await chargeApplication(s.id, s.paymentRequest as PaymentRequest, { userId: null }, { abandon: s.abandon });
      settled++;
    } catch (err) {
      if (err instanceof HttpError && !["PAYMENT_PENDING", "PAYMENTS_UNAVAILABLE", "PAYMENT_ACTION_REQUIRED"].includes(err.code)) settled++;
    }
  }
  return settled;
}

/* ---------------- applicant actions ---------------- */

/** Withdraw before a decision; a paid fee is refunded. */
export async function withdrawApplication(actor: Actor & { userId: string }, applicationId: string) {
  const [a] = await db
    .update(volunteerApplications)
    .set({ status: "withdrawn", paymentRequest: null, processingStartedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(volunteerApplications.id, applicationId),
        eq(volunteerApplications.userId, actor.userId),
        inArray(volunteerApplications.status, ["pending_payment", "submitted"]),
      ),
    )
    .returning();
  if (!a) throw new HttpError(409, "CONFLICT", "This application can't be withdrawn. Contact the league.");
  await writeAudit(db, { actorUserId: actor.userId, action: "staff.application.withdraw", targetType: "volunteer_application", targetId: a.id, requestId: actor.requestId, ipAddress: actor.ip });
  const refund = a.paidAt ? await refundAll({ applicationId: a.id }, "Application withdrawn", actor) : null;
  // Card processor wording stays with admins (the refund needing a retry shows on the admin page).
  const shown = refund && { ...refund, error: refund.error ? "Your fee couldn't be refunded automatically. The league will send it." : null };
  return { application: publicApplication(a), refund: shown };
}

/* ---------------- admin ---------------- */

export async function updateScreening(
  actor: Actor & { userId: string },
  applicationId: string,
  input: { status: "not_started" | "pending" | "cleared" | "not_cleared"; provider?: string; completedOn?: string | null; expiresOn?: string | null; notes?: string },
) {
  if (input.status === "cleared" && !input.completedOn) throw new HttpError(400, "VALIDATION_FAILED", "Enter the date the check was completed.");
  const [before] = await db.select().from(volunteerApplications).where(eq(volunteerApplications.id, applicationId));
  if (!before) throw new HttpError(404, "NOT_FOUND", "Application not found.");
  if (before.status === "approved" && input.status !== "cleared") {
    throw new HttpError(409, "CONFLICT", "This person is approved. Remove their approval first, then update the check.");
  }
  const [after] = await db
    .update(volunteerApplications)
    .set({
      screeningStatus: input.status,
      screeningProvider: input.provider || null,
      screeningCompletedOn: input.completedOn || null,
      screeningExpiresOn: input.expiresOn || null,
      screeningNotes: input.notes || null,
      screeningUpdatedBy: actor.userId,
      screeningUpdatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(volunteerApplications.id, applicationId))
    .returning();
  await writeAudit(db, {
    actorUserId: actor.userId,
    action: "staff.screening.update",
    targetType: "volunteer_application",
    targetId: applicationId,
    before: { status: before.screeningStatus, provider: before.screeningProvider, completedOn: before.screeningCompletedOn, expiresOn: before.screeningExpiresOn },
    after: { status: after!.screeningStatus, provider: after!.screeningProvider, completedOn: after!.screeningCompletedOn, expiresOn: after!.screeningExpiresOn },
    requestId: actor.requestId,
    ipAddress: actor.ip,
  });
  return after!;
}

export async function decideApplication(
  actor: Actor & { userId: string },
  applicationId: string,
  input: { decision: "approved" | "rejected"; reason?: string; refund: boolean },
) {
  const app = await db.transaction(async (tx) => {
    const [a] = await tx.select().from(volunteerApplications).where(eq(volunteerApplications.id, applicationId)).for("update");
    if (!a) throw new HttpError(404, "NOT_FOUND", "Application not found.");
    if (a.status !== "submitted") throw new HttpError(409, "CONFLICT", "Only submitted (paid) applications can be decided.");
    if (a.userId === actor.userId) throw new HttpError(403, "FORBIDDEN", "Another admin has to decide your own application.");
    let roleAssignmentId: string | null = null;
    if (input.decision === "approved") {
      const today = new Date().toISOString().slice(0, 10);
      if (a.screeningStatus !== "cleared") throw new HttpError(409, "CONFLICT", "The background check must be marked cleared before approving.");
      if (a.screeningExpiresOn && a.screeningExpiresOn < today) throw new HttpError(409, "CONFLICT", "The background check has expired. Record a current one first.");
      const [ura] = await tx
        .insert(userRoleAssignments)
        .values({ userId: a.userId, roleKey: a.roleKey, scopeType: "season", scopeId: a.seasonId, grantedBy: actor.userId })
        .onConflictDoNothing()
        .returning({ id: userRoleAssignments.id });
      roleAssignmentId = ura?.id ?? null;
    }
    const [after] = await tx
      .update(volunteerApplications)
      .set({ status: input.decision, decisionReason: input.reason ?? null, decidedBy: actor.userId, decidedAt: new Date(), roleAssignmentId, updatedAt: new Date() })
      .where(eq(volunteerApplications.id, a.id))
      .returning();
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: `staff.application.${input.decision === "approved" ? "approve" : "reject"}`,
      targetType: "volunteer_application",
      targetId: a.id,
      before: { status: a.status },
      after: { status: input.decision, roleKey: a.roleKey, roleAssignmentId },
      reason: input.reason ?? null,
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    await publish(tx, {
      name: "staff.application_decided",
      aggregateType: "volunteer_application",
      aggregateId: a.id,
      payload: { decision: input.decision, reason: input.reason ?? null },
    });
    return after!;
  });
  const refund = input.decision === "rejected" && input.refund && app.paidAt ? await refundAll({ applicationId: app.id }, input.reason || "Application not approved", actor) : null;
  return { application: app, refund };
}

/**
 * Removes an approved volunteer's role for the season (e.g. a background check
 * later comes back not cleared). The application closes as "revoked", so the
 * person can apply again later if appropriate.
 */
export async function revokeApproval(actor: Actor & { userId: string }, applicationId: string, reason: string) {
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(volunteerApplications).where(eq(volunteerApplications.id, applicationId)).for("update");
    if (!a) throw new HttpError(404, "NOT_FOUND", "Application not found.");
    if (a.status !== "approved") throw new HttpError(409, "CONFLICT", "Only approved applications can have their approval removed.");
    await tx
      .update(userRoleAssignments)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userRoleAssignments.userId, a.userId),
          eq(userRoleAssignments.roleKey, a.roleKey),
          eq(userRoleAssignments.scopeType, "season"),
          eq(userRoleAssignments.scopeId, a.seasonId),
          sql`${userRoleAssignments.revokedAt} is null`,
        ),
      );
    // Off every team where they serve in this role this season.
    const teamsLeft = await removeFromSeasonTeams(tx, a.userId, a.seasonId, a.roleKey);
    const [after] = await tx
      .update(volunteerApplications)
      .set({ status: "revoked", decisionReason: reason, decidedBy: actor.userId, decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(volunteerApplications.id, a.id))
      .returning();
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "staff.application.revoke",
      targetType: "volunteer_application",
      targetId: a.id,
      before: { status: "approved", roleKey: a.roleKey },
      after: { status: "revoked", teamsLeft },
      reason,
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    return after!;
  });
}
