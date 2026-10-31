/**
 * Coach and team manager applications (R2).
 *
 * Apply (with the volunteer agreement) → pay the volunteer fee by card →
 * submitted → admin records the background check → approved (role granted for
 * the season) or rejected (fee refunded). Payments reuse the registration
 * safeguards: a `processing` state with the exact Square request stored, so
 * the worker can re-send it with the same idempotency key if the response is
 * lost; refunds go through the shared race-safe issueRefund.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { env } from "../../config.js";
import { db } from "../../db/client.js";
import { contentPages, divisions, householdMembers, payments, players, refunds, seasons, userRoleAssignments, volunteerApplications } from "../../db/schema/index.js";
import { HttpError } from "../../http/errors.js";
import { logger } from "../../lib/logger.js";
import { writeAudit } from "../platform/audit.js";
import { isEnabled } from "../platform/flags.js";
import { publish } from "../platform/outbox.js";
import { COMPLETED, isUniqueViolation, issueRefund, refundAll, type Actor, type PaymentRequest } from "../registration/service.js";
import { getPaymentSettings, quote } from "../registration/settings.js";
import { createPayment, friendlyPaymentError, getCredentials, parseReference, SquareError, type SquarePayment } from "../square/client.js";

export const STAFF_FLAG = "r2.staff_applications";
export const VOLUNTEER_ROLES = ["head_coach", "assistant_coach", "team_manager"] as const;
export type VolunteerRole = (typeof VOLUNTEER_ROLES)[number];
export const ROLE_LABELS: Record<VolunteerRole, string> = {
  head_coach: "Head coach",
  assistant_coach: "Assistant coach",
  team_manager: "Team manager (team mom)",
};
const AGREEMENT_SLUG = "volunteer-agreement";
/** Square reference_id for an application payment (max 40 chars). */
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
  const creds = await getCredentials().catch(() => null);
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
    agreement: agreement ? { slug: agreement.slug, title: agreement.title, body: agreement.body, isPlaceholder: agreement.isPlaceholder } : null,
    // Public values for the Square card form; null = payments unavailable right now.
    square: creds && env.SQUARE_APPLICATION_ID ? { applicationId: env.SQUARE_APPLICATION_ID, locationId: creds.locationId, environment: creds.environment } : null,
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
  if (!(await isEnabled(STAFF_FLAG))) throw new HttpError(403, "FEATURE_DISABLED", "Volunteer applications aren't open yet.");
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

export async function payApplication(actor: Actor & { userId: string }, applicationId: string, input: { sourceId: string; verificationToken?: string }, buyerEmail: string) {
  const creds = await getCredentials().catch(() => null);
  if (!creds) throw new HttpError(503, "PAYMENTS_UNAVAILABLE", "Online payment is temporarily unavailable. Please try again later.");
  const request = await db.transaction(async (tx) => {
    const [a] = await tx
      .select()
      .from(volunteerApplications)
      .where(and(eq(volunteerApplications.id, applicationId), eq(volunteerApplications.userId, actor.userId)))
      .for("update");
    if (!a) throw new HttpError(404, "NOT_FOUND", "Application not found.");
    if (a.status === "processing") throw new HttpError(409, "CONFLICT", "This payment is already being processed.");
    if (a.status !== "pending_payment") throw new HttpError(409, "CONFLICT", "This application doesn't need a payment.");
    const request: PaymentRequest = {
      idempotencyKey: randomUUID(),
      sourceId: input.sourceId,
      verificationToken: input.verificationToken,
      amountCents: a.totalCents,
      note: `NFFL volunteer fee: ${ROLE_LABELS[a.roleKey as VolunteerRole]}`,
      buyerEmail,
    };
    await tx
      .update(volunteerApplications)
      .set({ status: "processing", paymentError: null, paymentRequest: request, processingStartedAt: new Date(), updatedAt: new Date() })
      .where(eq(volunteerApplications.id, a.id));
    return request;
  });
  return chargeApplication(applicationId, request, actor);
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

async function chargeApplication(applicationId: string, request: PaymentRequest, actor: Actor) {
  const creds = await getCredentials().catch(() => null);
  if (!creds) throw new HttpError(503, "PAYMENTS_UNAVAILABLE", "Online payment is temporarily unavailable. Please try again later.");
  let payment: SquarePayment;
  try {
    payment = await createPayment(creds, { ...request, referenceId: appReference(applicationId) });
  } catch (err) {
    if (err instanceof SquareError && err.status >= 400 && err.status < 500) {
      const card = err.errors.some((e) => e.category === "PAYMENT_METHOD_ERROR") || err.status === 402;
      const message = card ? friendlyPaymentError(err) : "Payment setup problem (not the card).";
      await revertApplication(applicationId, message);
      if (card) throw new HttpError(402, "PAYMENT_FAILED", message);
      logger.error({ applicationId, squareErrors: err.errors }, "Square rejected the volunteer fee request: check Square settings");
      throw new HttpError(503, "PAYMENTS_UNAVAILABLE", "We couldn't process payments just now because of a problem on our side. Your card was not charged.");
    }
    logger.error({ applicationId, err: err instanceof Error ? err.message : String(err) }, "volunteer fee outcome unknown");
    throw new HttpError(502, "PAYMENT_PENDING", "We couldn't confirm your payment yet. Please don't pay again; check back in a few minutes.");
  }
  if (COMPLETED.includes(payment.status)) {
    const app = await recordApplicationPayment(payment, { environment: creds.environment, merchantId: creds.merchantId }, actor);
    if (!app || app.status !== "submitted") throw new HttpError(409, "CONFLICT", "This application was closed before your payment finished. It's being refunded.");
    return app;
  }
  if (payment.status === "FAILED" || payment.status === "CANCELED") {
    await revertApplication(applicationId, "The payment didn't go through.");
    throw new HttpError(402, "PAYMENT_FAILED", "The payment didn't go through. Please try again.");
  }
  throw new HttpError(502, "PAYMENT_PENDING", "Your payment is still being confirmed. Please don't pay again; check back in a few minutes.");
}

/**
 * Records a completed fee payment (checkout, worker or webhook; safe to repeat).
 * Refunds it automatically if the application was withdrawn or rejected
 * meanwhile, or if it duplicates an earlier payment.
 */
export async function recordApplicationPayment(payment: SquarePayment, source: { environment: string; merchantId: string | null }, actor: Actor) {
  const ref = parseReference(payment.reference_id);
  if (!ref || !("applicationId" in ref)) return null;
  const id = ref.applicationId;
  const outcome = await db.transaction(async (tx) => {
    const [a] = await tx.select().from(volunteerApplications).where(eq(volunteerApplications.id, id)).for("update");
    if (!a) return { app: null as Application | null, refundPaymentId: null as string | null, reason: "" };
    const [row] = await tx
      .insert(payments)
      .values({
        applicationId: a.id,
        providerEnvironment: source.environment,
        providerPaymentId: payment.id,
        merchantId: source.merchantId,
        locationId: payment.location_id ?? null,
        status: payment.status,
        amountCents: payment.amount_money?.amount ?? a.totalCents,
        cardBrand: payment.card_details?.card?.card_brand ?? null,
        cardLast4: payment.card_details?.card?.last_4 ?? null,
        receiptUrl: payment.receipt_url ?? null,
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
      after: { paymentId: payment.id, amountCents: payment.amount_money?.amount },
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    await publish(tx, { name: "staff.application_submitted", aggregateType: "volunteer_application", aggregateId: a.id, dedupeKey: `staff.submitted:${a.id}` });
    return { ...keep, app: after! };
  });
  if (outcome.refundPaymentId && outcome.app) {
    try {
      await issueRefund({ applicationId: outcome.app.id }, { reason: outcome.reason, paymentId: outcome.refundPaymentId }, { userId: null });
    } catch (err) {
      logger.error({ applicationId: outcome.app.id, err: err instanceof Error ? err.message : String(err) }, "automatic volunteer fee refund failed");
    }
  }
  return outcome.app;
}

/** Webhook: a FAILED/CANCELED fee payment frees the application to try again (only for the current attempt). */
export async function failApplicationPayment(payment: SquarePayment) {
  const ref = parseReference(payment.reference_id);
  if (!ref || !("applicationId" in ref) || !payment.created_at) return;
  await revertApplication(ref.applicationId, "The payment didn't go through.", new Date(payment.created_at));
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
    paymentError: a.paymentError,
    decisionReason: a.decisionReason,
    createdAt: a.createdAt,
  };
}

/** Worker: re-send stuck fee payments with the same idempotency key to learn the outcome. */
export async function reconcileApplications(olderThanMinutes = 5) {
  const stuck = await db
    .select({ id: volunteerApplications.id, paymentRequest: volunteerApplications.paymentRequest })
    .from(volunteerApplications)
    .where(and(eq(volunteerApplications.status, "processing"), sql`${volunteerApplications.processingStartedAt} < now() - make_interval(mins => ${olderThanMinutes})`))
    .limit(25);
  let settled = 0;
  for (const s of stuck) {
    if (!s.paymentRequest) continue;
    try {
      await chargeApplication(s.id, s.paymentRequest as PaymentRequest, { userId: null });
      settled++;
    } catch (err) {
      if (err instanceof HttpError && err.code !== "PAYMENT_PENDING" && err.code !== "PAYMENTS_UNAVAILABLE") settled++;
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
  return { application: publicApplication(a), refund };
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
    throw new HttpError(409, "CONFLICT", "This volunteer is approved. Remove their approval first, then update the check.");
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
    if (a.status !== "approved") throw new HttpError(409, "CONFLICT", "Only approved volunteers can be removed.");
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
      after: { status: "revoked" },
      reason,
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    return after!;
  });
}
