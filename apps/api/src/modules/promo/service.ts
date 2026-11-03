/**
 * Promo codes: a percent or dollar discount on the division price at
 * registration and/or on coach and team mom fees. The discount comes off the
 * price first; any card fee is then worked out on what's left. A code's uses
 * are the registrations and applications currently holding it (cancelled,
 * expired, withdrawn and rejected ones free their use).
 */
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db, type DbOrTx, type Tx } from "../../db/client.js";
import { divisions, householdMembers, promoCodes, registrations, seasons, volunteerApplications } from "../../db/schema/index.js";
import { HttpError } from "../../http/errors.js";
import { writeAudit } from "../platform/audit.js";
import { isEnabled } from "../platform/flags.js";
import { publish } from "../platform/outbox.js";
import type { Actor } from "../registration/service.js";
import { getPaymentSettings, quote } from "../registration/settings.js";

export const PROMO_FLAG = "r2.promo_codes";
export type Promo = typeof promoCodes.$inferSelect;

const REG_HOLDING = ["pending_payment", "processing", "paid", "approved"];
// A revoked approval keeps its use: the fee was paid and the code was spent.
const APP_HOLDING = ["pending_payment", "processing", "submitted", "approved", "revoked"];

export const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, "");

export function discountFor(p: Pick<Promo, "kind" | "value">, priceCents: number) {
  const off = p.kind === "percent" ? Math.round((priceCents * p.value) / 100) : p.value;
  return Math.max(0, Math.min(priceCents, off));
}

/** Uses currently held, optionally not counting one registration or application. */
export async function usesOf(conn: DbOrTx, promoId: string, exclude: { registrationId?: string; applicationId?: string } = {}) {
  const [{ n: regs }] = (await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(registrations)
    .where(
      and(
        eq(registrations.promoCodeId, promoId),
        inArray(registrations.status, REG_HOLDING),
        exclude.registrationId ? ne(registrations.id, exclude.registrationId) : undefined,
      ),
    )) as [{ n: number }];
  const [{ n: apps }] = (await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(volunteerApplications)
    .where(
      and(
        eq(volunteerApplications.promoCodeId, promoId),
        inArray(volunteerApplications.status, APP_HOLDING),
        exclude.applicationId ? ne(volunteerApplications.id, exclude.applicationId) : undefined,
      ),
    )) as [{ n: number }];
  return regs + apps;
}

interface UseContext {
  target: "registration" | "staff";
  seasonId: string;
  divisionId?: string;
  /** For one-per-family codes. */
  householdId?: string | null;
  userId?: string;
  registrationId?: string;
  applicationId?: string;
}

/**
 * Finds a code and checks it can be used here. Locks the code's row so two
 * families can't take the last use at the same time.
 */
/**
 * One answer for every reason a code can't be used (unknown, expired, used up,
 * wrong division or fee), so codes can't be discovered by trying them.
 */
const CODE_REFUSED = "That code can't be used here. Check the code, or contact the league if you think it should work.";

export async function usableCode(tx: Tx, raw: string, ctx: UseContext): Promise<Promo> {
  const code = normalizeCode(raw);
  const [p] = code ? await tx.select().from(promoCodes).where(eq(promoCodes.code, code)).for("update") : [];
  if (!p || !p.active) throw new HttpError(409, "CONFLICT", CODE_REFUSED);
  await checkUsable(tx, p, ctx);
  return p;
}

async function checkUsable(tx: Tx, p: Promo, ctx: UseContext) {
  const now = new Date();
  // Same message as an unknown code, so codes can't be discovered by guessing.
  if (p.startsAt && p.startsAt > now) throw new HttpError(409, "CONFLICT", CODE_REFUSED);
  if (p.endsAt && p.endsAt <= now) throw new HttpError(409, "CONFLICT", CODE_REFUSED);
  if (p.appliesTo !== "both" && p.appliesTo !== ctx.target) {
    throw new HttpError(409, "CONFLICT", CODE_REFUSED);
  }
  if (p.seasonId && p.seasonId !== ctx.seasonId) throw new HttpError(409, "CONFLICT", CODE_REFUSED);
  const divs = (p.divisionIds as string[]) ?? [];
  if (ctx.target === "registration" && divs.length && (!ctx.divisionId || !divs.includes(ctx.divisionId))) {
    throw new HttpError(409, "CONFLICT", CODE_REFUSED);
  }
  if (p.maxUses !== null && (await usesOf(tx, p.id, { registrationId: ctx.registrationId, applicationId: ctx.applicationId })) >= p.maxUses) {
    throw new HttpError(409, "CONFLICT", CODE_REFUSED);
  }
  if (p.onePerFamily) {
    const homes = ctx.householdId
      ? [ctx.householdId]
      : ctx.userId
        ? (await tx.select({ id: householdMembers.householdId }).from(householdMembers).where(eq(householdMembers.userId, ctx.userId))).map((h) => h.id)
        : [];
    const members = homes.length
      ? (await tx.select({ id: householdMembers.userId }).from(householdMembers).where(inArray(householdMembers.householdId, homes))).map((m) => m.id)
      : [];
    if (ctx.userId && !members.includes(ctx.userId)) members.push(ctx.userId);
    const [{ n: regs }] = homes.length
      ? ((await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(registrations)
          .where(
            and(
              eq(registrations.promoCodeId, p.id),
              inArray(registrations.householdId, homes),
              inArray(registrations.status, REG_HOLDING),
              ctx.registrationId ? ne(registrations.id, ctx.registrationId) : undefined,
            ),
          )) as [{ n: number }])
      : [{ n: 0 }];
    const [{ n: apps }] = members.length
      ? ((await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(volunteerApplications)
          .where(
            and(
              eq(volunteerApplications.promoCodeId, p.id),
              inArray(volunteerApplications.userId, members),
              inArray(volunteerApplications.status, APP_HOLDING),
              ctx.applicationId ? ne(volunteerApplications.id, ctx.applicationId) : undefined,
            ),
          )) as [{ n: number }])
      : [{ n: 0 }];
    if (regs + apps > 0) throw new HttpError(409, "CONFLICT", CODE_REFUSED);
  }
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * At payment time, inside the same locked transaction that charges: checks the
 * code a registration holds is still good (not paused, ended, used up, …) and
 * still gives the same discount. If not, the code is dropped or the discount
 * updated, the new totals are saved, and a message is returned so the family
 * can review the new total before paying. Null means nothing changed.
 */
export async function settleRegistrationCode(tx: Tx, r: typeof registrations.$inferSelect): Promise<string | null> {
  if (!r.promoCodeId) return null;
  const [p] = await tx.select().from(promoCodes).where(eq(promoCodes.id, r.promoCodeId)).for("update");
  const settings = await getPaymentSettings(tx);
  let reason: string | null = null;
  try {
    if (!p || !p.active) throw new HttpError(409, "CONFLICT", CODE_REFUSED);
    await checkUsable(tx, p, { target: "registration", seasonId: r.seasonId, divisionId: r.divisionId, householdId: r.householdId, registrationId: r.id });
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    reason = err.message;
  }
  const discountCents = reason || !p ? 0 : discountFor(p, r.priceCents);
  const q = quote(r.priceCents - discountCents, settings);
  if (!reason && discountCents === r.discountCents && q.totalCents === r.totalCents) return null;
  await tx
    .update(registrations)
    .set({ promoCodeId: reason ? null : r.promoCodeId, discountCents, feeCents: q.feeCents, totalCents: q.totalCents, updatedAt: new Date() })
    .where(eq(registrations.id, r.id));
  return reason
    ? `Promo code ${p?.code ?? ""} can't be used any more (it has expired, been used up or was changed). The total is now ${dollars(q.totalCents)}. No payment was taken; review it and pay again.`
    : `Promo code ${p!.code} was changed by the league. The total is now ${dollars(q.totalCents)}. No payment was taken; review it and pay again.`;
}

/** The same check for a coach / team mom application's fee. */
export async function settleApplicationCode(tx: Tx, a: typeof volunteerApplications.$inferSelect): Promise<string | null> {
  if (!a.promoCodeId) return null;
  const [p] = await tx.select().from(promoCodes).where(eq(promoCodes.id, a.promoCodeId)).for("update");
  const settings = await getPaymentSettings(tx);
  let reason: string | null = null;
  try {
    if (!p || !p.active) throw new HttpError(409, "CONFLICT", CODE_REFUSED);
    await checkUsable(tx, p, { target: "staff", seasonId: a.seasonId, userId: a.userId, applicationId: a.id });
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    reason = err.message;
  }
  const discountCents = reason || !p ? 0 : discountFor(p, a.feeCents);
  const q = quote(a.feeCents - discountCents, settings);
  if (!reason && discountCents === a.discountCents && q.totalCents === a.totalCents) return null;
  await tx
    .update(volunteerApplications)
    .set({ promoCodeId: reason ? null : a.promoCodeId, discountCents, processingFeeCents: q.feeCents, totalCents: q.totalCents, updatedAt: new Date() })
    .where(eq(volunteerApplications.id, a.id));
  return reason
    ? `Promo code ${p?.code ?? ""} can't be used any more (it has expired, been used up or was changed). The total is now ${dollars(q.totalCents)}. No payment was taken; review it and pay again.`
    : `Promo code ${p!.code} was changed by the league. The total is now ${dollars(q.totalCents)}. No payment was taken; review it and pay again.`;
}

/* ---------------- families: apply / remove ---------------- */

async function flagOn() {
  if (!(await isEnabled(PROMO_FLAG))) throw new HttpError(403, "FEATURE_DISABLED", "Promo codes aren't available yet.");
}

export async function applyToRegistration(actor: Actor, householdId: string, registrationId: string, code: string | null) {
  if (code !== null) await flagOn();
  return db.transaction(async (tx) => {
    const [r] = await tx
      .select()
      .from(registrations)
      .where(and(eq(registrations.id, registrationId), eq(registrations.householdId, householdId)))
      .for("update");
    if (!r) throw new HttpError(404, "NOT_FOUND", "Registration not found.");
    if (r.status !== "pending_payment" && r.status !== "expired") throw new HttpError(409, "CONFLICT", "The code can only change before you pay.");
    const p = code === null ? null : await usableCode(tx, code, { target: "registration", seasonId: r.seasonId, divisionId: r.divisionId, householdId, registrationId: r.id });
    const discountCents = p ? discountFor(p, r.priceCents) : 0;
    const q = quote(r.priceCents - discountCents, await getPaymentSettings(tx));
    const [after] = await tx
      .update(registrations)
      .set({ promoCodeId: p?.id ?? null, discountCents, feeCents: q.feeCents, totalCents: q.totalCents, updatedAt: new Date() })
      .where(eq(registrations.id, r.id))
      .returning();
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: p ? "promo.apply" : "promo.remove",
      targetType: "registration",
      targetId: r.id,
      before: { promoCodeId: r.promoCodeId, totalCents: r.totalCents },
      after: { promoCodeId: after!.promoCodeId, code: p?.code ?? null, discountCents, totalCents: after!.totalCents },
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    return { registration: after!, code: p?.code ?? null };
  });
}

export async function applyToApplication(actor: Actor & { userId: string }, applicationId: string, code: string | null) {
  if (code !== null) await flagOn();
  return db.transaction(async (tx) => {
    const [a] = await tx
      .select()
      .from(volunteerApplications)
      .where(and(eq(volunteerApplications.id, applicationId), eq(volunteerApplications.userId, actor.userId)))
      .for("update");
    if (!a) throw new HttpError(404, "NOT_FOUND", "Application not found.");
    if (a.status !== "pending_payment") throw new HttpError(409, "CONFLICT", "The code can only change before you pay.");
    const p = code === null ? null : await usableCode(tx, code, { target: "staff", seasonId: a.seasonId, userId: actor.userId, applicationId: a.id });
    const discountCents = p ? discountFor(p, a.feeCents) : 0;
    const q = quote(a.feeCents - discountCents, await getPaymentSettings(tx));
    const [after] = await tx
      .update(volunteerApplications)
      .set({ promoCodeId: p?.id ?? null, discountCents, processingFeeCents: q.feeCents, totalCents: q.totalCents, updatedAt: new Date() })
      .where(eq(volunteerApplications.id, a.id))
      .returning();
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: p ? "promo.apply" : "promo.remove",
      targetType: "volunteer_application",
      targetId: a.id,
      before: { promoCodeId: a.promoCodeId, totalCents: a.totalCents },
      after: { promoCodeId: after!.promoCodeId, code: p?.code ?? null, discountCents, totalCents: after!.totalCents },
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    return { application: after!, code: p?.code ?? null };
  });
}

/** A staff application whose fee is fully covered by a code: submit it without a card. */
export async function submitFreeApplication(tx: Tx, a: typeof volunteerApplications.$inferSelect, actor: Actor) {
  const [after] = await tx
    .update(volunteerApplications)
    .set({ status: "submitted", paidAt: new Date(), paymentError: null, updatedAt: new Date() })
    .where(eq(volunteerApplications.id, a.id))
    .returning();
  await writeAudit(tx, {
    actorUserId: actor.userId,
    action: "staff.application.submitted_free",
    targetType: "volunteer_application",
    targetId: a.id,
    after: { promoCodeId: a.promoCodeId },
    requestId: actor.requestId,
    ipAddress: actor.ip,
  });
  await publish(tx, { name: "staff.application_submitted", aggregateType: "volunteer_application", aggregateId: a.id });
  return after!;
}

/* ---------------- admin ---------------- */

export interface PromoInput {
  code: string;
  description?: string | null;
  kind: "percent" | "amount";
  value: number;
  appliesTo: "registration" | "staff" | "both";
  seasonId?: string | null;
  divisionIds?: string[];
  maxUses?: number | null;
  onePerFamily?: boolean;
  startsAt?: Date | null;
  endsAt?: Date | null;
  active?: boolean;
}

async function checkInput(input: PromoInput) {
  if (!/^[A-Z0-9_-]{3,30}$/.test(normalizeCode(input.code))) throw new HttpError(400, "VALIDATION_FAILED", "Codes are 3–30 letters, numbers, dashes or underscores.");
  if (input.kind === "percent" && (input.value < 1 || input.value > 100)) throw new HttpError(400, "VALIDATION_FAILED", "Percent off must be 1–100.");
  if (input.kind === "amount" && input.value < 1) throw new HttpError(400, "VALIDATION_FAILED", "Enter an amount off.");
  if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) throw new HttpError(400, "VALIDATION_FAILED", "The end date must be after the start date.");
  if (input.divisionIds?.length) {
    if (!input.seasonId) throw new HttpError(400, "VALIDATION_FAILED", "Pick the season to limit a code to certain divisions.");
    const ds = await db.select({ id: divisions.id }).from(divisions).where(and(eq(divisions.seasonId, input.seasonId), inArray(divisions.id, input.divisionIds)));
    if (ds.length !== new Set(input.divisionIds).size) throw new HttpError(400, "VALIDATION_FAILED", "Choose divisions from that season.");
  }
}

const values = (input: PromoInput) => ({
  code: normalizeCode(input.code),
  description: input.description || null,
  kind: input.kind,
  value: input.value,
  appliesTo: input.appliesTo,
  seasonId: input.seasonId || null,
  divisionIds: input.divisionIds ?? [],
  maxUses: input.maxUses ?? null,
  onePerFamily: input.onePerFamily ?? false,
  startsAt: input.startsAt ?? null,
  endsAt: input.endsAt ?? null,
  active: input.active ?? true,
});

export async function createPromo(actor: Actor & { userId: string }, input: PromoInput) {
  await checkInput(input);
  try {
    return await db.transaction(async (tx) => {
      const [p] = await tx.insert(promoCodes).values({ ...values(input), createdBy: actor.userId }).returning();
      await writeAudit(tx, { actorUserId: actor.userId, action: "promo.create", targetType: "promo_code", targetId: p!.id, after: p, requestId: actor.requestId, ipAddress: actor.ip });
      return p!;
    });
  } catch (err) {
    if ((err as { cause?: { code?: string } }).cause?.code === "23505") throw new HttpError(409, "CONFLICT", "There's already a code with that name.");
    throw err;
  }
}

/** Edits a code. Changes apply to future checkouts; families who already used it keep their price. */
export async function updatePromo(actor: Actor & { userId: string }, id: string, input: PromoInput) {
  await checkInput(input);
  try {
    return await db.transaction(async (tx) => {
      const [before] = await tx.select().from(promoCodes).where(eq(promoCodes.id, id)).for("update");
      if (!before) throw new HttpError(404, "NOT_FOUND", "Code not found.");
      const [after] = await tx.update(promoCodes).set({ ...values(input), updatedAt: new Date() }).where(eq(promoCodes.id, id)).returning();
      await writeAudit(tx, { actorUserId: actor.userId, action: "promo.update", targetType: "promo_code", targetId: id, before, after, requestId: actor.requestId, ipAddress: actor.ip });
      return after!;
    });
  } catch (err) {
    if ((err as { cause?: { code?: string } }).cause?.code === "23505") throw new HttpError(409, "CONFLICT", "There's already a code with that name.");
    throw err;
  }
}

/** Every code with how many times it's been used and the total discount given (paid/approved only). */
export async function listPromos() {
  const rows = await db
    .select({ p: promoCodes, seasonName: seasons.name })
    .from(promoCodes)
    .leftJoin(seasons, eq(seasons.id, promoCodes.seasonId))
    .orderBy(asc(promoCodes.code));
  const regStats = await db
    .select({ id: registrations.promoCodeId, uses: sql<number>`count(*)::int`, saved: sql<number>`coalesce(sum(${registrations.discountCents}) filter (where ${registrations.status} in ('paid','approved')), 0)::int` })
    .from(registrations)
    .where(and(sql`${registrations.promoCodeId} is not null`, inArray(registrations.status, REG_HOLDING)))
    .groupBy(registrations.promoCodeId);
  const appStats = await db
    .select({ id: volunteerApplications.promoCodeId, uses: sql<number>`count(*)::int`, saved: sql<number>`coalesce(sum(${volunteerApplications.discountCents}) filter (where ${volunteerApplications.status} in ('submitted','approved')), 0)::int` })
    .from(volunteerApplications)
    .where(and(sql`${volunteerApplications.promoCodeId} is not null`, inArray(volunteerApplications.status, APP_HOLDING)))
    .groupBy(volunteerApplications.promoCodeId);
  return rows.map(({ p, seasonName }) => {
    const r = regStats.find((x) => x.id === p.id);
    const a = appStats.find((x) => x.id === p.id);
    return { ...p, seasonName, uses: (r?.uses ?? 0) + (a?.uses ?? 0), savedCents: (r?.saved ?? 0) + (a?.saved ?? 0) };
  });
}
