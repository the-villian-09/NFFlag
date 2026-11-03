/**
 * Referees (R5): sign-up, approval, games and pay.
 *
 * Sign up → admin records a cleared background check and verifies the
 * certification → approve (minimum age checked) → the referee sets up payouts
 * with Stripe on our site (Stripe holds their tax ID and bank details) →
 * claims open games or is assigned by an admin → after a game is final an
 * admin approves pay → a Stripe transfer moves the money from the league's
 * Stripe balance into the referee's account → Stripe pays it to their bank
 * (about 2 business days, or within minutes with an instant payout the
 * referee starts and pays 1% for).
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, type DbOrTx } from "../../db/client.js";
import {
  divisions,
  gameOfficials,
  games,
  refereeAccounts,
  refereeApplications,
  refereePayouts,
  seasons,
  siteSettings,
  teams,
  user,
} from "../../db/schema/index.js";
import { HttpError } from "../../http/errors.js";
import { logger } from "../../lib/logger.js";
import { writeAudit } from "../platform/audit.js";
import { publish } from "../platform/outbox.js";
import { isUniqueViolation, type Actor } from "../registration/service.js";
import {
  createAccountSession,
  createConnectedAccount,
  createTopup,
  createTransfer,
  findTransfer,
  retrieveAccount,
  retrieveBalance,
  stripeConfigured,
  stripeEnvironment,
  StripeError,
  type ConnectedAccount,
} from "../stripe/client.js";
import { env } from "../../config.js";
import { adminStaffPhoto, requireStaffPhoto } from "../documents/service.js";

export const REFEREE_FLAG = "r5.referees";

type Application = typeof refereeApplications.$inferSelect;
type Account = typeof refereeAccounts.$inferSelect;

/* ---------------- settings ---------------- */

export const refereeSettingsSchema = z.object({
  /** Youngest age a referee can be approved at. */
  minAge: z.number().int().min(14).max(30).default(16),
  /** A referee can drop a game they're on until this many hours before it starts. */
  dropCutoffHours: z.number().int().min(0).max(168).default(24),
  /** Referees a new game needs (each game can be changed). */
  defaultSlots: z.number().int().min(0).max(6).default(2),
});
export type RefereeSettings = z.infer<typeof refereeSettingsSchema>;

export async function getRefereeSettings(conn: DbOrTx = db): Promise<RefereeSettings> {
  const [row] = await conn.select().from(siteSettings).where(eq(siteSettings.key, "referees"));
  return refereeSettingsSchema.parse(row?.value ?? {});
}

export async function saveRefereeSettings(actor: Actor & { userId: string }, input: Partial<RefereeSettings>) {
  const before = await getRefereeSettings();
  const value = refereeSettingsSchema.parse({ ...before, ...input });
  await db.transaction(async (tx) => {
    await tx
      .insert(siteSettings)
      .values({ key: "referees", value, updatedBy: actor.userId })
      .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedBy: actor.userId, updatedAt: new Date() } });
    await writeAudit(tx, { actorUserId: actor.userId, action: "referees.settings.update", targetType: "setting", targetId: "referees", before, after: value, requestId: actor.requestId, ipAddress: actor.ip });
  });
  return value;
}

/* ---------------- helpers ---------------- */

const today = () => new Date().toISOString().slice(0, 10);

/** Whole years between a birth date and a date (both YYYY-MM-DD). */
export function ageOn(birthDate: string, on: string) {
  const [by, bm, bd] = birthDate.split("-").map(Number) as [number, number, number];
  const [y, m, d] = on.split("-").map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

async function currentSeason() {
  const [s] = await db.select().from(seasons).where(eq(seasons.isCurrent, "current")).limit(1);
  return s ?? null;
}

async function approvedFor(conn: DbOrTx, userId: string, seasonId: string) {
  const [a] = await conn
    .select()
    .from(refereeApplications)
    .where(and(eq(refereeApplications.userId, userId), eq(refereeApplications.seasonId, seasonId), eq(refereeApplications.status, "approved")));
  return a ?? null;
}

/** What an applicant may see about their own application (no screening notes). */
export function publicApplication(a: Application) {
  return {
    id: a.id,
    status: a.status,
    phone: a.phone,
    birthDate: a.birthDate,
    experience: a.experience,
    certification: a.certification,
    certificationExpiresOn: a.certificationExpiresOn,
    decisionReason: a.status === "rejected" || a.status === "revoked" ? a.decisionReason : null,
    createdAt: a.createdAt,
  };
}

export type PayoutSetup = "not_started" | "needs_info" | "in_review" | "ready";

/** Where a referee is with Stripe payout setup. */
export function payoutSetup(a: Pick<Account, "detailsSubmitted" | "transfersActive" | "requirementsDue" | "environment"> | null | undefined): PayoutSetup {
  if (!a || a.environment !== stripeEnvironment()) return "not_started";
  if (a.transfersActive && a.requirementsDue === 0) return "ready";
  if (!a.detailsSubmitted || a.requirementsDue > 0) return "needs_info";
  return a.transfersActive ? "ready" : "in_review";
}

function accountFields(acct: ConnectedAccount) {
  const due = new Set([...(acct.requirements?.currently_due ?? []), ...(acct.requirements?.past_due ?? [])]);
  return {
    detailsSubmitted: !!acct.details_submitted,
    transfersActive: acct.capabilities?.transfers === "active",
    payoutsEnabled: !!acct.payouts_enabled,
    requirementsDue: due.size,
    disabledReason: acct.requirements?.disabled_reason ?? null,
    checkedAt: new Date(),
    updatedAt: new Date(),
  };
}

/* ---------------- applicant ---------------- */

export async function refereeHome(userId: string) {
  const season = await currentSeason();
  const settings = await getRefereeSettings();
  const apps = season
    ? await db
        .select()
        .from(refereeApplications)
        .where(and(eq(refereeApplications.userId, userId), eq(refereeApplications.seasonId, season.id)))
        .orderBy(desc(refereeApplications.createdAt))
    : [];
  const [acct] = await db.select().from(refereeAccounts).where(eq(refereeAccounts.userId, userId));
  const latest = apps[0] ?? null;
  return {
    season: season ? { id: season.id, name: season.name } : null,
    minAge: settings.minAge,
    dropCutoffHours: settings.dropCutoffHours,
    application: latest ? publicApplication(latest) : null,
    approved: latest?.status === "approved",
    payouts: {
      available: stripeConfigured(),
      setup: payoutSetup(acct),
      payoutsEnabled: !!acct?.payoutsEnabled && acct.environment === stripeEnvironment(),
    },
  };
}

export const refereeApplicationInput = z.object({
  phone: z.string().trim().min(7).max(40),
  birthDate: z.iso.date(),
  experience: z.string().trim().max(2000).optional(),
  certification: z.string().trim().min(2).max(200),
  certificationExpiresOn: z.iso.date().optional().or(z.literal("").transform(() => undefined)),
});

export async function applyAsReferee(actor: Actor & { userId: string }, input: z.infer<typeof refereeApplicationInput>) {
  const season = await currentSeason();
  if (!season) throw new HttpError(409, "CONFLICT", "Referee sign-up opens when the next season is set up.");
  const { minAge } = await getRefereeSettings();
  if (ageOn(input.birthDate, today()) < minAge) {
    throw new HttpError(400, "VALIDATION_FAILED", `Referees must be at least ${minAge} years old.`);
  }
  if (input.certificationExpiresOn && input.certificationExpiresOn < today()) {
    throw new HttpError(400, "VALIDATION_FAILED", "That certification has expired. Renew it, then sign up with the new expiration date.");
  }
  await requireStaffPhoto(actor.userId, season.id, "signing up");
  const [closed] = await db
    .select({ status: refereeApplications.status })
    .from(refereeApplications)
    .where(and(eq(refereeApplications.userId, actor.userId), eq(refereeApplications.seasonId, season.id), inArray(refereeApplications.status, ["rejected", "revoked"])))
    .limit(1);
  if (closed) throw new HttpError(409, "CONFLICT", "The league has already decided on your referee sign-up this season. Contact the league with any questions.");
  try {
    return await db.transaction(async (tx) => {
      const [a] = await tx
        .insert(refereeApplications)
        .values({
          seasonId: season.id,
          userId: actor.userId,
          phone: input.phone,
          birthDate: input.birthDate,
          experience: input.experience || null,
          certification: input.certification,
          certificationExpiresOn: input.certificationExpiresOn ?? null,
        })
        .returning();
      await writeAudit(tx, { actorUserId: actor.userId, action: "referee.apply", targetType: "referee_application", targetId: a!.id, requestId: actor.requestId, ipAddress: actor.ip });
      await publish(tx, { name: "referee.application_submitted", aggregateType: "referee_application", aggregateId: a!.id });
      return a!;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "CONFLICT", "You've already signed up as a referee this season.");
    throw err;
  }
}

export async function withdrawRefereeApplication(actor: Actor & { userId: string }, id: string) {
  const [a] = await db
    .update(refereeApplications)
    .set({ status: "withdrawn", updatedAt: new Date() })
    .where(and(eq(refereeApplications.id, id), eq(refereeApplications.userId, actor.userId), eq(refereeApplications.status, "submitted")))
    .returning();
  if (!a) throw new HttpError(409, "CONFLICT", "Only an application that hasn't been decided can be withdrawn. Contact the league.");
  await writeAudit(db, { actorUserId: actor.userId, action: "referee.withdraw", targetType: "referee_application", targetId: a.id, requestId: actor.requestId, ipAddress: actor.ip });
  return a;
}

/* ---------------- Stripe payout account ---------------- */

/** Creates (once) the referee's Stripe account and returns a session for the embedded components. */
export async function payoutSession(u: { id: string; email: string }) {
  try {
    return await startPayoutSession(u);
  } catch (err) {
    if (!(err instanceof StripeError)) throw err;
    // Stripe's own reason (usually a dashboard setting), so it can be fixed.
    logger.error({ userId: u.id, status: err.status, type: err.type, code: err.code, message: err.message }, "Stripe refused payout setup");
    // The details stay in the log for the league; referees get a plain message.
    throw new HttpError(503, "PAYMENTS_UNAVAILABLE", "Payout setup isn't available right now. Please try again later, or contact the league if it keeps happening.");
  }
}

async function startPayoutSession(u: { id: string; email: string }) {
  if (!stripeConfigured()) throw new HttpError(503, "PAYMENTS_UNAVAILABLE", "Payout setup isn't available right now. Please try again later.");
  const season = await currentSeason();
  // Approved referees set up payouts; anyone else only while the league still owes them money.
  const approved = season ? await approvedFor(db, u.id, season.id) : null;
  if (!approved && !(await isOwed(u.id))) {
    throw new HttpError(403, "FORBIDDEN", "Payout setup opens once the league approves you as a referee.");
  }
  const environment = stripeEnvironment();
  let [acct] = await db.select().from(refereeAccounts).where(eq(refereeAccounts.userId, u.id));
  if (!acct || acct.environment !== environment) {
    const created = await createConnectedAccount({ email: u.email, userId: u.id, idempotencyKey: `referee-account:${u.id}:${environment}` });
    const row = { stripeAccountId: created.id, environment, ...accountFields(created) };
    [acct] = await db
      .insert(refereeAccounts)
      .values({ userId: u.id, ...row })
      .onConflictDoUpdate({ target: refereeAccounts.userId, set: row })
      .returning();
    await writeAudit(db, { actorUserId: u.id, action: "referee.payout_account.create", targetType: "referee_account", targetId: created.id });
  }
  return { clientSecret: await createAccountSession(acct!.stripeAccountId), setup: payoutSetup(acct) };
}

/** Pay not yet sent: a payout waiting, or games worked but not yet approved. */
async function isOwed(userId: string) {
  const [p] = await db
    .select({ id: refereePayouts.id })
    .from(refereePayouts)
    .where(and(eq(refereePayouts.userId, userId), inArray(refereePayouts.status, ["pending", "failed"])))
    .limit(1);
  if (p) return true;
  const [o] = await db
    .select({ id: gameOfficials.id })
    .from(gameOfficials)
    .innerJoin(games, eq(games.id, gameOfficials.gameId))
    .where(and(eq(gameOfficials.userId, userId), inArray(gameOfficials.status, ["assigned", "worked"]), isNull(gameOfficials.payoutId), eq(games.status, "final")))
    .limit(1);
  return !!o;
}

/** Re-reads the referee's Stripe account and saves its status. */
export async function refreshAccount(userId: string) {
  const [acct] = await db.select().from(refereeAccounts).where(eq(refereeAccounts.userId, userId));
  if (!acct || acct.environment !== stripeEnvironment() || !stripeConfigured()) return acct ?? null;
  const fresh = await retrieveAccount(acct.stripeAccountId);
  const [after] = await db.update(refereeAccounts).set(accountFields(fresh)).where(eq(refereeAccounts.userId, userId)).returning();
  return after!;
}

/* ---------------- games ---------------- */

const homeTeam = sql<string>`(select name from ${teams} where ${teams.id} = ${games.homeTeamId})`;
const awayTeam = sql<string>`(select name from ${teams} where ${teams.id} = ${games.awayTeamId})`;
const activeOfficials = sql<number>`(select count(*)::int from ${gameOfficials} where ${gameOfficials.gameId} = ${games.id} and ${gameOfficials.status} <> 'removed')`;

/** Open games a referee can claim, and the games they're on. */
export async function refereeGames(userId: string) {
  const season = await currentSeason();
  if (!season) return { open: [], mine: [] };
  const approved = await approvedFor(db, userId, season.id);
  const mine = await db
    .select({
      officialId: gameOfficials.id,
      gameId: games.id,
      startsAt: games.startsAt,
      location: games.location,
      gameStatus: games.status,
      division: divisions.name,
      home: homeTeam,
      away: awayTeam,
      status: gameOfficials.status,
      source: gameOfficials.source,
      rateCents: gameOfficials.rateCents,
      payoutStatus: refereePayouts.status,
      paidAt: refereePayouts.paidAt,
    })
    .from(gameOfficials)
    .innerJoin(games, eq(games.id, gameOfficials.gameId))
    .innerJoin(divisions, eq(divisions.id, games.divisionId))
    .leftJoin(refereePayouts, eq(refereePayouts.id, gameOfficials.payoutId))
    .where(and(eq(gameOfficials.userId, userId), ne(gameOfficials.status, "removed"), eq(games.seasonId, season.id)))
    .orderBy(asc(games.startsAt));
  const onGames = new Set(mine.map((m) => m.gameId));
  const open = approved
    ? (
        await db
          .select({
            gameId: games.id,
            startsAt: games.startsAt,
            location: games.location,
            division: divisions.name,
            home: homeTeam,
            away: awayTeam,
            rateCents: divisions.refereeRateCents,
            slots: games.refereeSlots,
            filled: activeOfficials,
          })
          .from(games)
          .innerJoin(divisions, eq(divisions.id, games.divisionId))
          .where(and(eq(games.seasonId, season.id), eq(games.status, "scheduled"), gt(games.startsAt, new Date()), sql`${activeOfficials} < ${games.refereeSlots}`))
          .orderBy(asc(games.startsAt))
          .limit(200)
      ).filter((g) => !onGames.has(g.gameId))
    : [];
  return { open, mine };
}

/** Locks the game and checks a referee can be put on it. */
async function lockGameForOfficial(tx: DbOrTx, gameId: string, userId: string, by: "claim" | "assign") {
  // One referee's claims and assignments run one at a time, so two can't slip past the clash check together.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`referee:${userId}`}))`);
  const [g] = await tx.select().from(games).where(eq(games.id, gameId)).for("update");
  if (!g) throw new HttpError(404, "NOT_FOUND", "Game not found.");
  if (g.status !== "scheduled" && g.status !== "postponed") throw new HttpError(409, "CONFLICT", "Referees can only be added to scheduled games.");
  if (by === "claim" && (g.status !== "scheduled" || g.startsAt <= new Date())) throw new HttpError(409, "CONFLICT", "This game has already started.");
  // Held until commit, so an approval can't be removed halfway through.
  const [app] = await tx
    .select()
    .from(refereeApplications)
    .where(and(eq(refereeApplications.userId, userId), eq(refereeApplications.seasonId, g.seasonId), eq(refereeApplications.status, "approved")))
    .for("share");
  if (!app) {
    throw new HttpError(409, "CONFLICT", by === "claim" ? "Only approved referees can sign up for games." : "That person isn't an approved referee this season.");
  }
  const gameDay = g.startsAt.toISOString().slice(0, 10);
  if ((app.certificationExpiresOn && app.certificationExpiresOn < gameDay) || (app.screeningExpiresOn && app.screeningExpiresOn < gameDay)) {
    throw new HttpError(
      409,
      "CONFLICT",
      by === "claim"
        ? "Your certification or background check expires before this game. Contact the league to update it."
        : "That referee's certification or background check expires before this game. Update it on their referee page first.",
    );
  }
  const [{ n }] = (await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(gameOfficials)
    .where(and(eq(gameOfficials.gameId, gameId), ne(gameOfficials.status, "removed")))) as [{ n: number }];
  if (n >= g.refereeSlots) throw new HttpError(409, "CONFLICT", by === "claim" ? "This game already has all the referees it needs." : "All referee spots on this game are filled. Add a spot first.");
  // Not on another game within 90 minutes of this one.
  const [clash] = await tx
    .select({ id: games.id, startsAt: games.startsAt })
    .from(gameOfficials)
    .innerJoin(games, eq(games.id, gameOfficials.gameId))
    .where(
      and(
        eq(gameOfficials.userId, userId),
        ne(gameOfficials.status, "removed"),
        ne(games.id, gameId),
        inArray(games.status, ["scheduled", "postponed"]),
        sql`abs(extract(epoch from (${games.startsAt} - ${g.startsAt.toISOString()}::timestamptz))) < 90 * 60`,
      ),
    )
    .limit(1);
  if (clash) throw new HttpError(409, "CONFLICT", by === "claim" ? "You're already on a game within 90 minutes of this one." : "That referee is already on a game within 90 minutes of this one.");
  const [d] = await tx.select({ rate: divisions.refereeRateCents }).from(divisions).where(eq(divisions.id, g.divisionId));
  return { game: g, rateCents: d?.rate ?? 0 };
}

export async function claimGame(actor: Actor & { userId: string }, gameId: string) {
  try {
    return await db.transaction(async (tx) => {
      const { rateCents } = await lockGameForOfficial(tx, gameId, actor.userId, "claim");
      const [o] = await tx.insert(gameOfficials).values({ gameId, userId: actor.userId, source: "claimed", rateCents, assignedBy: actor.userId }).returning();
      await writeAudit(tx, { actorUserId: actor.userId, action: "referee.game.claim", targetType: "game", targetId: gameId, after: { officialId: o!.id, rateCents }, requestId: actor.requestId, ipAddress: actor.ip });
      return o!;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "CONFLICT", "You're already on this game.");
    throw err;
  }
}

export async function dropGame(actor: Actor & { userId: string }, gameId: string) {
  const { dropCutoffHours } = await getRefereeSettings();
  return db.transaction(async (tx) => {
    const [o] = await tx
      .select({ id: gameOfficials.id, status: gameOfficials.status, startsAt: games.startsAt })
      .from(gameOfficials)
      .innerJoin(games, eq(games.id, gameOfficials.gameId))
      .where(and(eq(gameOfficials.gameId, gameId), eq(gameOfficials.userId, actor.userId), eq(gameOfficials.status, "assigned")))
      .for("update", { of: gameOfficials });
    if (!o) throw new HttpError(404, "NOT_FOUND", "You're not on this game.");
    if (o.startsAt.getTime() - Date.now() < dropCutoffHours * 3600_000) {
      throw new HttpError(409, "CONFLICT", `Games can be dropped up to ${dropCutoffHours} hours before they start. Contact the league to be replaced.`);
    }
    await tx.update(gameOfficials).set({ status: "removed", updatedAt: new Date() }).where(eq(gameOfficials.id, o.id));
    await writeAudit(tx, { actorUserId: actor.userId, action: "referee.game.drop", targetType: "game", targetId: gameId, requestId: actor.requestId, ipAddress: actor.ip });
    return { ok: true };
  });
}

/* ---------------- admin: applications ---------------- */

export async function listApplications(seasonId: string) {
  const rows = await db
    .select({ a: refereeApplications, name: user.name, email: user.email, acct: refereeAccounts })
    .from(refereeApplications)
    .innerJoin(user, eq(user.id, refereeApplications.userId))
    .leftJoin(refereeAccounts, eq(refereeAccounts.userId, refereeApplications.userId))
    .where(eq(refereeApplications.seasonId, seasonId))
    .orderBy(asc(refereeApplications.status), asc(user.name));
  const { minAge } = await getRefereeSettings();
  return rows.map((r) => ({ ...adminView(r.a, minAge), name: r.name, email: r.email, payoutSetup: payoutSetup(r.acct) }));
}

function adminView(a: Application, minAge: number) {
  const age = ageOn(a.birthDate, today());
  return {
    ...a,
    age,
    meetsMinAge: age >= minAge,
    certificationVerified: !!a.certificationVerifiedAt,
    certificationExpired: !!a.certificationExpiresOn && a.certificationExpiresOn < today(),
  };
}

export async function getApplication(id: string) {
  const [r] = await db
    .select({ a: refereeApplications, name: user.name, email: user.email, acct: refereeAccounts })
    .from(refereeApplications)
    .innerJoin(user, eq(user.id, refereeApplications.userId))
    .leftJoin(refereeAccounts, eq(refereeAccounts.userId, refereeApplications.userId))
    .where(eq(refereeApplications.id, id));
  if (!r) throw new HttpError(404, "NOT_FOUND", "Application not found.");
  const { minAge } = await getRefereeSettings();
  return { ...adminView(r.a, minAge), name: r.name, email: r.email, payoutSetup: payoutSetup(r.acct), minAge, photo: await adminStaffPhoto(r.a.userId, r.a.seasonId) };
}

export const screeningInput = z.object({
  status: z.enum(["not_started", "pending", "cleared", "not_cleared"]),
  provider: z.string().trim().max(200).optional(),
  completedOn: z.iso.date().nullable().optional(),
  expiresOn: z.iso.date().nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
});

export async function updateScreening(actor: Actor & { userId: string }, id: string, input: z.infer<typeof screeningInput>) {
  if (input.status === "cleared" && !input.completedOn) throw new HttpError(400, "VALIDATION_FAILED", "Enter the date the check was completed.");
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(refereeApplications).where(eq(refereeApplications.id, id)).for("update");
    if (!before) throw new HttpError(404, "NOT_FOUND", "Application not found.");
    if (before.status === "approved" && input.status !== "cleared") {
      throw new HttpError(409, "CONFLICT", "This referee is approved. Remove their approval first, then update the check.");
    }
    const [after] = await tx
      .update(refereeApplications)
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
      .where(eq(refereeApplications.id, id))
      .returning();
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "referee.screening.update",
      targetType: "referee_application",
      targetId: id,
      before: { status: before.screeningStatus, completedOn: before.screeningCompletedOn, expiresOn: before.screeningExpiresOn },
      after: { status: after!.screeningStatus, completedOn: after!.screeningCompletedOn, expiresOn: after!.screeningExpiresOn },
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    return after!;
  });
}

export const certificationInput = z.object({
  verified: z.boolean(),
  certification: z.string().trim().min(2).max(200).optional(),
  expiresOn: z.iso.date().nullable().optional(),
});

/** Records that an admin checked the certification (and corrects its name or expiry if needed). */
export async function verifyCertification(actor: Actor & { userId: string }, id: string, input: z.infer<typeof certificationInput>) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(refereeApplications).where(eq(refereeApplications.id, id)).for("update");
    if (!before) throw new HttpError(404, "NOT_FOUND", "Application not found.");
    if (before.status === "approved" && !input.verified) {
      throw new HttpError(409, "CONFLICT", "This referee is approved. Remove their approval first.");
    }
    const expiresOn = input.expiresOn === undefined ? before.certificationExpiresOn : input.expiresOn;
    if (input.verified && expiresOn && expiresOn < today()) throw new HttpError(400, "VALIDATION_FAILED", "That certification has expired, so it can't be marked verified.");
    const [after] = await tx
      .update(refereeApplications)
      .set({
        certification: input.certification ?? before.certification,
        certificationExpiresOn: input.expiresOn === undefined ? before.certificationExpiresOn : input.expiresOn,
        certificationVerifiedBy: input.verified ? actor.userId : null,
        certificationVerifiedAt: input.verified ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(refereeApplications.id, id))
      .returning();
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: input.verified ? "referee.certification.verify" : "referee.certification.unverify",
      targetType: "referee_application",
      targetId: id,
      before: { certification: before.certification, expiresOn: before.certificationExpiresOn, verified: !!before.certificationVerifiedAt },
      after: { certification: after!.certification, expiresOn: after!.certificationExpiresOn, verified: input.verified },
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    return after!;
  });
}

export const decisionInput = z.object({ decision: z.enum(["approved", "rejected"]), reason: z.string().trim().max(1000).optional() });

export async function decideApplication(actor: Actor & { userId: string }, id: string, input: z.infer<typeof decisionInput>) {
  const { minAge } = await getRefereeSettings();
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(refereeApplications).where(eq(refereeApplications.id, id)).for("update");
    if (!a) throw new HttpError(404, "NOT_FOUND", "Application not found.");
    if (a.status !== "submitted") throw new HttpError(409, "CONFLICT", "This application has already been decided.");
    if (a.userId === actor.userId) throw new HttpError(403, "FORBIDDEN", "Another admin has to decide your own application.");
    if (input.decision === "approved") {
      const t = today();
      if (a.screeningStatus !== "cleared") throw new HttpError(409, "CONFLICT", "The background check must be marked cleared before approving.");
      if (a.screeningExpiresOn && a.screeningExpiresOn < t) throw new HttpError(409, "CONFLICT", "The background check has expired. Record a current one first.");
      if (!a.certificationVerifiedAt) throw new HttpError(409, "CONFLICT", "Verify the referee's certification before approving.");
      if (a.certificationExpiresOn && a.certificationExpiresOn < t) throw new HttpError(409, "CONFLICT", "The certification has expired. Record the renewed one first.");
      if (ageOn(a.birthDate, t) < minAge) throw new HttpError(409, "CONFLICT", `Referees must be at least ${minAge} years old.`);
    }
    const [after] = await tx
      .update(refereeApplications)
      .set({ status: input.decision, decisionReason: input.reason || null, decidedBy: actor.userId, decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(refereeApplications.id, id))
      .returning();
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: `referee.${input.decision === "approved" ? "approve" : "reject"}`,
      targetType: "referee_application",
      targetId: id,
      before: { status: a.status },
      after: { status: input.decision },
      reason: input.reason ?? null,
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    await publish(tx, { name: "referee.application_decided", aggregateType: "referee_application", aggregateId: id, payload: { decision: input.decision, reason: input.reason ?? null } });
    return after!;
  });
}

/** Removes an approval (e.g. a check came back): off every upcoming game; money already owed is still paid. */
export async function revokeApproval(actor: Actor & { userId: string }, id: string, reason: string) {
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(refereeApplications).where(eq(refereeApplications.id, id)).for("update");
    if (!a) throw new HttpError(404, "NOT_FOUND", "Application not found.");
    if (a.status !== "approved") throw new HttpError(409, "CONFLICT", "Only an approved referee's approval can be removed.");
    const [after] = await tx
      .update(refereeApplications)
      .set({ status: "revoked", decisionReason: reason, decidedBy: actor.userId, decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(refereeApplications.id, id))
      .returning();
    const removed = await tx
      .update(gameOfficials)
      .set({ status: "removed", updatedAt: new Date() })
      .where(
        and(
          eq(gameOfficials.userId, a.userId),
          eq(gameOfficials.status, "assigned"),
          isNull(gameOfficials.payoutId),
          // Only games still to come: games already played stay, so their pay is still owed.
          inArray(
            gameOfficials.gameId,
            tx.select({ id: games.id }).from(games).where(and(eq(games.seasonId, a.seasonId), inArray(games.status, ["scheduled", "postponed"]), gt(games.startsAt, new Date()))),
          ),
        ),
      )
      .returning({ id: gameOfficials.id });
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "referee.revoke",
      targetType: "referee_application",
      targetId: id,
      before: { status: "approved" },
      after: { status: "revoked", gamesRemoved: removed.length },
      reason,
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    await publish(tx, { name: "referee.application_decided", aggregateType: "referee_application", aggregateId: id, payload: { decision: "revoked", reason } });
    return { application: after!, gamesRemoved: removed.length };
  });
}

/* ---------------- admin: games ---------------- */

/** Games in a date range with their referees, for assigning. */
export async function adminGames(seasonId: string, from: Date, to: Date) {
  const rows = await db
    .select({
      id: games.id,
      startsAt: games.startsAt,
      location: games.location,
      status: games.status,
      division: divisions.name,
      rateCents: divisions.refereeRateCents,
      home: homeTeam,
      away: awayTeam,
      slots: games.refereeSlots,
    })
    .from(games)
    .innerJoin(divisions, eq(divisions.id, games.divisionId))
    .where(and(eq(games.seasonId, seasonId), gte(games.startsAt, from), lt(games.startsAt, to)))
    .orderBy(asc(games.startsAt));
  const officials = rows.length
    ? await db
        .select({
          id: gameOfficials.id,
          gameId: gameOfficials.gameId,
          userId: gameOfficials.userId,
          name: user.name,
          status: gameOfficials.status,
          source: gameOfficials.source,
          rateCents: gameOfficials.rateCents,
          paid: sql<boolean>`${gameOfficials.payoutId} is not null`,
        })
        .from(gameOfficials)
        .innerJoin(user, eq(user.id, gameOfficials.userId))
        .where(and(inArray(gameOfficials.gameId, rows.map((r) => r.id)), ne(gameOfficials.status, "removed")))
        .orderBy(asc(gameOfficials.createdAt))
    : [];
  const referees = await db
    .select({ userId: refereeApplications.userId, name: user.name })
    .from(refereeApplications)
    .innerJoin(user, eq(user.id, refereeApplications.userId))
    .where(and(eq(refereeApplications.seasonId, seasonId), eq(refereeApplications.status, "approved")))
    .orderBy(asc(user.name));
  return { games: rows.map((g) => ({ ...g, officials: officials.filter((o) => o.gameId === g.id) })), referees };
}

export async function assignReferee(actor: Actor & { userId: string }, gameId: string, userId: string) {
  if (userId === actor.userId) throw new HttpError(403, "FORBIDDEN", "Another admin has to assign you; you can also take open games from your referee page.");
  try {
    return await db.transaction(async (tx) => {
      const { rateCents } = await lockGameForOfficial(tx, gameId, userId, "assign");
      const [o] = await tx.insert(gameOfficials).values({ gameId, userId, source: "assigned", rateCents, assignedBy: actor.userId }).returning();
      await writeAudit(tx, { actorUserId: actor.userId, action: "referee.game.assign", targetType: "game", targetId: gameId, after: { userId, officialId: o!.id, rateCents }, requestId: actor.requestId, ipAddress: actor.ip });
      await publish(tx, { name: "referee.assigned", aggregateType: "game_official", aggregateId: o!.id });
      return o!;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "CONFLICT", "That referee is already on this game.");
    throw err;
  }
}

export async function removeOfficial(actor: Actor & { userId: string }, officialId: string) {
  return db.transaction(async (tx) => {
    const [o] = await tx.select().from(gameOfficials).where(eq(gameOfficials.id, officialId)).for("update");
    if (!o || o.status === "removed") throw new HttpError(404, "NOT_FOUND", "That referee isn't on this game.");
    if (o.payoutId) throw new HttpError(409, "CONFLICT", "This game has already been paid, so the referee can't be removed.");
    await tx.update(gameOfficials).set({ status: "removed", updatedAt: new Date() }).where(eq(gameOfficials.id, o.id));
    const [g] = await tx.select({ startsAt: games.startsAt, status: games.status }).from(games).where(eq(games.id, o.gameId));
    await writeAudit(tx, { actorUserId: actor.userId, action: "referee.game.remove", targetType: "game", targetId: o.gameId, before: { userId: o.userId, status: o.status }, requestId: actor.requestId, ipAddress: actor.ip });
    if (g && g.startsAt > new Date() && g.status === "scheduled") {
      await publish(tx, { name: "referee.unassigned", aggregateType: "game_official", aggregateId: o.id });
    }
    return { ok: true };
  });
}

export const officialUpdateInput = z.object({
  status: z.enum(["assigned", "no_show"]).optional(),
  rateCents: z.number().int().min(0).max(100_000).optional(),
});

/** Marks a no-show (not paid) or changes one game's pay, before it's paid. */
export async function updateOfficial(actor: Actor & { userId: string }, officialId: string, input: z.infer<typeof officialUpdateInput>) {
  return db.transaction(async (tx) => {
    const [o] = await tx.select().from(gameOfficials).where(eq(gameOfficials.id, officialId)).for("update");
    if (!o || o.status === "removed") throw new HttpError(404, "NOT_FOUND", "That referee isn't on this game.");
    if (o.payoutId || o.status === "worked") throw new HttpError(409, "CONFLICT", "This game has already been paid.");
    if (o.userId === actor.userId) throw new HttpError(403, "FORBIDDEN", "Another admin has to change your own games and pay.");
    const [after] = await tx
      .update(gameOfficials)
      .set({ status: input.status ?? o.status, rateCents: input.rateCents ?? o.rateCents, updatedAt: new Date() })
      .where(eq(gameOfficials.id, o.id))
      .returning();
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "referee.game.update",
      targetType: "game_official",
      targetId: o.id,
      before: { status: o.status, rateCents: o.rateCents },
      after: { status: after!.status, rateCents: after!.rateCents },
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    return after!;
  });
}

export async function setSlots(actor: Actor & { userId: string }, gameId: string, slots: number) {
  return db.transaction(async (tx) => {
    const [g] = await tx.select().from(games).where(eq(games.id, gameId)).for("update");
    if (!g) throw new HttpError(404, "NOT_FOUND", "Game not found.");
    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(gameOfficials)
      .where(and(eq(gameOfficials.gameId, gameId), ne(gameOfficials.status, "removed")))) as [{ n: number }];
    if (slots < n) throw new HttpError(409, "CONFLICT", `${n} referees are on this game. Remove one first.`);
    await tx.update(games).set({ refereeSlots: slots, updatedAt: new Date() }).where(eq(games.id, gameId));
    await writeAudit(tx, { actorUserId: actor.userId, action: "referee.game.slots", targetType: "game", targetId: gameId, before: { slots: g.refereeSlots }, after: { slots }, requestId: actor.requestId, ipAddress: actor.ip });
    return { slots };
  });
}

/* ---------------- admin: pay ---------------- */

/** Referees owed for final games not yet paid, and payouts still waiting. */
export async function payOverview() {
  const owed = await db
    .select({
      officialId: gameOfficials.id,
      userId: gameOfficials.userId,
      name: user.name,
      email: user.email,
      gameId: games.id,
      startsAt: games.startsAt,
      division: divisions.name,
      home: homeTeam,
      away: awayTeam,
      rateCents: gameOfficials.rateCents,
      status: gameOfficials.status,
    })
    .from(gameOfficials)
    .innerJoin(games, eq(games.id, gameOfficials.gameId))
    .innerJoin(divisions, eq(divisions.id, games.divisionId))
    .innerJoin(user, eq(user.id, gameOfficials.userId))
    .where(
      and(
        isNull(gameOfficials.payoutId),
        eq(games.status, "final"),
        // No-shows stay listed for 45 days so a mistake can be undone; they're never paid.
        sql`(${gameOfficials.status} in ('assigned','worked') or (${gameOfficials.status} = 'no_show' and ${games.startsAt} > now() - interval '45 days'))`,
      ),
    )
    .orderBy(asc(user.name), asc(games.startsAt));
  const accounts = await db.select().from(refereeAccounts);
  const setupOf = (userId: string) => payoutSetup(accounts.find((a) => a.userId === userId));
  const byUser = new Map<string, { userId: string; name: string; email: string; payoutSetup: PayoutSetup; games: typeof owed; totalCents: number }>();
  for (const o of owed) {
    const r = byUser.get(o.userId) ?? { userId: o.userId, name: o.name, email: o.email, payoutSetup: setupOf(o.userId), games: [], totalCents: 0 };
    r.games.push(o);
    if (o.status !== "no_show") r.totalCents += o.rateCents;
    byUser.set(o.userId, r);
  }
  const waiting = await db
    .select({ p: refereePayouts, name: user.name })
    .from(refereePayouts)
    .innerJoin(user, eq(user.id, refereePayouts.userId))
    .where(inArray(refereePayouts.status, ["pending", "failed"]))
    .orderBy(asc(refereePayouts.createdAt));
  const recent = await db
    .select({ p: refereePayouts, name: user.name })
    .from(refereePayouts)
    .innerJoin(user, eq(user.id, refereePayouts.userId))
    .where(eq(refereePayouts.status, "paid"))
    .orderBy(desc(refereePayouts.paidAt))
    .limit(30);
  let balance: { availableCents: number; pendingCents: number } | null = null;
  let balanceError: string | null = null;
  if (stripeConfigured()) {
    try {
      balance = await retrieveBalance();
    } catch (err) {
      balanceError = err instanceof StripeError ? `Couldn't read the Stripe balance: ${err.message}` : "Couldn't reach Stripe to read the balance. Refresh to try again.";
    }
  }
  const view = (r: { p: typeof refereePayouts.$inferSelect; name: string }) => ({
    id: r.p.id,
    userId: r.p.userId,
    name: r.name,
    amountCents: r.p.amountCents,
    status: r.p.status,
    lastError: r.p.lastError,
    attempts: r.p.attempts,
    createdAt: r.p.createdAt,
    paidAt: r.p.paidAt,
    payoutSetup: setupOf(r.p.userId),
  });
  return {
    stripe: { configured: stripeConfigured(), environment: stripeEnvironment() },
    balance,
    balanceError,
    owed: [...byUser.values()],
    waiting: waiting.map(view),
    recent: recent.map(view),
  };
}

export const approvePayInput = z.object({ officialIds: z.array(z.uuid()).min(1).max(500) });

/**
 * Approves pay for the chosen games: one payout per referee, then tries to
 * send each one. No-shows are recorded but not paid.
 */
export async function approvePay(actor: Actor & { userId: string }, officialIds: string[]) {
  const environment = stripeEnvironment();
  if (!stripeConfigured()) throw new HttpError(503, "PAYMENTS_UNAVAILABLE", "Stripe isn't set up, so referees can't be paid yet.");
  const created = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ o: gameOfficials, gameStatus: games.status })
      .from(gameOfficials)
      .innerJoin(games, eq(games.id, gameOfficials.gameId))
      .where(inArray(gameOfficials.id, officialIds))
      .orderBy(asc(games.id), asc(gameOfficials.id))
      // The games too, so a score can't be cleared while its pay is approved.
      .for("update", { of: [gameOfficials, games] });
    if (rows.some((r) => r.o.userId === actor.userId)) throw new HttpError(403, "FORBIDDEN", "Another admin has to approve your own pay.");
    const payable = rows.filter((r) => r.gameStatus === "final" && !r.o.payoutId && (r.o.status === "assigned" || r.o.status === "worked"));
    if (payable.length !== officialIds.length) {
      throw new HttpError(409, "CONFLICT", "Some of those games were already paid, aren't final yet, or are marked as no-shows. Refresh and try again.");
    }
    const byUser = new Map<string, typeof payable>();
    for (const r of payable) byUser.set(r.o.userId, [...(byUser.get(r.o.userId) ?? []), r]);
    const out: string[] = [];
    for (const [userId, list] of byUser) {
      const amountCents = list.reduce((n, r) => n + r.o.rateCents, 0);
      const ids = list.map((r) => r.o.id);
      if (amountCents === 0) {
        // Unpaid games (rate $0) are just marked worked.
        await tx.update(gameOfficials).set({ status: "worked", updatedAt: new Date() }).where(inArray(gameOfficials.id, ids));
        continue;
      }
      const [p] = await tx.insert(refereePayouts).values({ userId, amountCents, environment, idempotencyKey: randomUUID(), approvedBy: actor.userId }).returning();
      await tx.update(gameOfficials).set({ status: "worked", payoutId: p!.id, updatedAt: new Date() }).where(inArray(gameOfficials.id, ids));
      await writeAudit(tx, {
        actorUserId: actor.userId,
        action: "referee.pay.approve",
        targetType: "referee_payout",
        targetId: p!.id,
        after: { userId, amountCents, games: ids.length },
        requestId: actor.requestId,
        ipAddress: actor.ip,
      });
      out.push(p!.id);
    }
    return out;
  });
  const results = [];
  for (const id of created) results.push(await sendPayout(id));
  return { payouts: results };
}

const NOT_READY = "Waiting for the referee to finish payout setup.";

/** Marks a payout paid with its Stripe transfer (once), and emails the statement. */
async function markPayoutPaid(p: typeof refereePayouts.$inferSelect, transferId: string, actorUserId: string | null) {
  return db.transaction(async (tx) => {
    const [after] = await tx
      .update(refereePayouts)
      .set({ status: "paid", stripeTransferId: transferId, lastError: null, paidAt: new Date(), updatedAt: new Date() })
      .where(and(eq(refereePayouts.id, p.id), ne(refereePayouts.status, "paid"), ne(refereePayouts.status, "void")))
      .returning();
    if (after) {
      await writeAudit(tx, { actorUserId, action: "referee.pay.sent", targetType: "referee_payout", targetId: p.id, after: { transferId, amountCents: p.amountCents } });
      await publish(tx, { name: "referee.paid", aggregateType: "referee_payout", aggregateId: p.id, dedupeKey: `referee.paid:${p.id}` });
    }
    return after ?? (await tx.select().from(refereePayouts).where(eq(refereePayouts.id, p.id)))[0]!;
  });
}

/**
 * Sends one payout as a Stripe transfer.
 *
 * Never pays twice: the transfer carries the payout id as its transfer group,
 * and before any re-send of a payout that was tried before, Stripe is asked
 * whether that transfer already exists (Stripe only remembers idempotency keys
 * for 24 hours). A definite refusal (e.g. not enough balance) gets a fresh
 * idempotency key, so the next retry isn't answered with the cached refusal.
 */
export async function sendPayout(payoutId: string, actor?: Actor & { userId: string }) {
  const claim = await db.transaction(async (tx) => {
    const [p] = await tx.select().from(refereePayouts).where(eq(refereePayouts.id, payoutId)).for("update");
    if (!p) throw new HttpError(404, "NOT_FOUND", "Payout not found.");
    if (p.status === "paid" || p.status === "void") return { p, skip: true as const };
    if (p.environment !== stripeEnvironment()) {
      const [after] = await tx
        .update(refereePayouts)
        .set({ status: "failed", lastError: `Approved in Stripe ${p.environment} mode; the site is now in ${stripeEnvironment()} mode. Void it and approve the games again.`, updatedAt: new Date() })
        .where(eq(refereePayouts.id, p.id))
        .returning();
      return { p: after!, skip: true as const };
    }
    // Another send of this payout is in progress (another admin, or the worker).
    if (p.sendingAt && Date.now() - p.sendingAt.getTime() < SENDING_WINDOW_MS) return { p, skip: true as const };
    const [acct] = await tx.select().from(refereeAccounts).where(eq(refereeAccounts.userId, p.userId));
    await tx
      .update(refereePayouts)
      .set({ attempts: sql`${refereePayouts.attempts} + 1`, sendingAt: new Date(), updatedAt: new Date() })
      .where(eq(refereePayouts.id, p.id));
    return { p, acct: acct ?? null, skip: false as const };
  });
  if (claim.skip) return publicPayout(claim.p);
  const { p, acct } = claim as { p: typeof refereePayouts.$inferSelect; acct: Account | null };
  try {
    return await sendClaimed(p, acct, actor);
  } finally {
    await db.update(refereePayouts).set({ sendingAt: null }).where(eq(refereePayouts.id, p.id));
  }
}

/** How long a send may hold a payout before it's treated as interrupted. */
const SENDING_WINDOW_MS = 5 * 60_000;

async function sendClaimed(p: typeof refereePayouts.$inferSelect, acct: Account | null, actor?: Actor & { userId: string }) {

  // Tried before: it may already have gone through (response lost, or a different attempt).
  if (p.attempts > 0) {
    try {
      const existing = await findTransfer(p.id);
      if (existing) return publicPayout(await markPayoutPaid(p, existing.id, actor?.userId ?? null));
    } catch (err) {
      logger.warn({ payoutId: p.id, err: err instanceof Error ? err.message : String(err) }, "couldn't look up an earlier transfer; not re-sending");
      const [after] = await db
        .update(refereePayouts)
        .set({ status: "pending", lastError: "Couldn't reach Stripe; it will be retried automatically.", updatedAt: new Date() })
        .where(and(eq(refereePayouts.id, p.id), eq(refereePayouts.status, p.status)))
        .returning();
      return publicPayout(after ?? p);
    }
  }

  if (payoutSetup(acct) !== "ready") {
    const [after] = await db
      .update(refereePayouts)
      .set({ status: "pending", lastError: NOT_READY, updatedAt: new Date() })
      .where(and(eq(refereePayouts.id, p.id), inArray(refereePayouts.status, ["pending", "failed"])))
      .returning();
    return publicPayout(after ?? p);
  }

  // Pay from card-payment money if there's enough, else from bank top-ups.
  let sourceType: "card" | "bank_account" | undefined;
  try {
    const bal = await retrieveBalance();
    if (bal.availableBySource.card < p.amountCents && bal.availableBySource.bank_account >= p.amountCents) sourceType = "bank_account";
  } catch {
    sourceType = undefined;
  }

  try {
    const t = await createTransfer({
      amountCents: p.amountCents,
      destination: acct!.stripeAccountId,
      description: "NFFL referee pay",
      idempotencyKey: p.idempotencyKey,
      transferGroup: p.id,
      sourceType,
      metadata: { payout_id: p.id, user_id: p.userId },
    });
    return publicPayout(await markPayoutPaid(p, t.id, actor?.userId ?? null));
  } catch (err) {
    // 409 (same key in use by another attempt right now) and 429/5xx/network: outcome unknown.
    const refused = err instanceof StripeError && err.status >= 400 && err.status < 500 && err.status !== 409 && err.status !== 429;
    const message =
      err instanceof StripeError && (err.code === "balance_insufficient" || /insufficient/i.test(err.message))
        ? "Not enough available money in the league's Stripe balance. Add funds, or wait for recent payments to settle, then retry."
        : refused
          ? `Stripe refused the transfer: ${(err as StripeError).message}`
          : "Couldn't confirm with Stripe; it will be checked and retried automatically.";
    if (!refused) logger.error({ payoutId: p.id, err: err instanceof Error ? err.message : String(err) }, "referee transfer outcome unknown");
    const [after] = await db
      .update(refereePayouts)
      .set({
        status: refused ? "failed" : "pending",
        lastError: message,
        // Nothing was sent, so the next try needs a new key (Stripe replays a refusal for 24 hours).
        ...(refused ? { idempotencyKey: randomUUID() } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(refereePayouts.id, p.id), inArray(refereePayouts.status, ["pending", "failed"])))
      .returning();
    return publicPayout(after ?? p);
  }
}

/**
 * Cancels a payout that wasn't sent (e.g. approved in test mode, or Stripe
 * keeps refusing it): its games go back to "owed" so they can be approved
 * again. Checks with Stripe first that no transfer was made.
 */
export async function voidPayout(actor: Actor & { userId: string }, payoutId: string, reason: string) {
  const [p0] = await db.select().from(refereePayouts).where(eq(refereePayouts.id, payoutId));
  if (!p0) throw new HttpError(404, "NOT_FOUND", "Payout not found.");
  if (p0.status === "paid" || p0.status === "void") throw new HttpError(409, "CONFLICT", "This payout can't be voided.");
  if (p0.attempts > 0 && p0.environment === stripeEnvironment()) {
    const existing = await findTransfer(p0.id);
    if (existing) {
      await markPayoutPaid(p0, existing.id, actor.userId);
      throw new HttpError(409, "CONFLICT", "Stripe shows this payout was already sent, so it's now marked paid.");
    }
  }
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(refereePayouts).where(eq(refereePayouts.id, payoutId)).for("update");
    if (!p || p.status === "paid" || p.status === "void") throw new HttpError(409, "CONFLICT", "This payout can't be voided.");
    // A send that started after the check above (or is still running) wins; try Void again in a few minutes.
    if (p.sendingAt && Date.now() - p.sendingAt.getTime() < SENDING_WINDOW_MS) {
      throw new HttpError(409, "CONFLICT", "This payout is being sent right now. Wait a few minutes and check it again before voiding.");
    }
    if (p.attempts !== p0.attempts) throw new HttpError(409, "CONFLICT", "This payout was just tried again. Refresh and check it before voiding.");
    await tx.update(refereePayouts).set({ status: "void", lastError: reason, updatedAt: new Date() }).where(eq(refereePayouts.id, p.id));
    const games = await tx
      .update(gameOfficials)
      .set({ status: "assigned", payoutId: null, updatedAt: new Date() })
      .where(eq(gameOfficials.payoutId, p.id))
      .returning({ id: gameOfficials.id });
    await writeAudit(tx, { actorUserId: actor.userId, action: "referee.pay.void", targetType: "referee_payout", targetId: p.id, before: { status: p.status, amountCents: p.amountCents }, after: { status: "void", games: games.length }, reason, requestId: actor.requestId, ipAddress: actor.ip });
    return { ok: true, games: games.length };
  });
}

function publicPayout(p: typeof refereePayouts.$inferSelect) {
  return { id: p.id, userId: p.userId, amountCents: p.amountCents, status: p.status, lastError: p.lastError, paidAt: p.paidAt };
}

/** Worker: send payouts waiting on a referee's setup or a lost response; refresh accounts still being set up. */
export async function processRefereePayouts() {
  if (!stripeConfigured()) return 0;
  const stale = await db
    .select({ userId: refereeAccounts.userId })
    .from(refereeAccounts)
    .where(
      and(
        eq(refereeAccounts.environment, stripeEnvironment()),
        sql`(${refereeAccounts.transfersActive} = false or ${refereeAccounts.requirementsDue} > 0)`,
        sql`(${refereeAccounts.checkedAt} is null or ${refereeAccounts.checkedAt} < now() - interval '10 minutes')`,
      ),
    )
    .limit(20);
  for (const s of stale) {
    try {
      await refreshAccount(s.userId);
    } catch (err) {
      logger.warn({ userId: s.userId, err: err instanceof Error ? err.message : String(err) }, "referee account refresh failed");
    }
  }
  const pending = await db
    .select({ id: refereePayouts.id })
    .from(refereePayouts)
    .where(and(eq(refereePayouts.status, "pending"), sql`${refereePayouts.updatedAt} < now() - interval '2 minutes'`))
    .limit(25);
  let sent = 0;
  for (const p of pending) if ((await sendPayout(p.id)).status === "paid") sent++;
  return sent;
}

export const topupInput = z.object({ amountCents: z.number().int().min(100).max(5_000_000) });

/** Adds money to the league's Stripe balance from its bank account. */
export async function addFunds(actor: Actor & { userId: string }, amountCents: number) {
  if (!stripeConfigured()) throw new HttpError(503, "PAYMENTS_UNAVAILABLE", "Stripe isn't set up.");
  try {
    const t = await createTopup({ amountCents, idempotencyKey: randomUUID() });
    await writeAudit(db, { actorUserId: actor.userId, action: "referee.pay.add_funds", targetType: "stripe_topup", targetId: t.id, after: { amountCents, status: t.status }, requestId: actor.requestId, ipAddress: actor.ip });
    return { id: t.id, status: t.status, expectedAvailableOn: t.expected_availability_date ? new Date(t.expected_availability_date * 1000).toISOString().slice(0, 10) : null };
  } catch (err) {
    if (err instanceof StripeError && err.status >= 400 && err.status < 500) {
      throw new HttpError(409, "CONFLICT", `Stripe couldn't add funds: ${err.message} (The league's bank account must be verified in the Stripe dashboard first.)`);
    }
    throw err;
  }
}

/* ---------------- referee: pay ---------------- */

export async function myPay(userId: string) {
  const payouts = await db.select().from(refereePayouts).where(and(eq(refereePayouts.userId, userId), ne(refereePayouts.status, "void"))).orderBy(desc(refereePayouts.createdAt)).limit(100);
  const items = payouts.length
    ? await db
        .select({ payoutId: gameOfficials.payoutId, startsAt: games.startsAt, division: divisions.name, home: homeTeam, away: awayTeam, rateCents: gameOfficials.rateCents })
        .from(gameOfficials)
        .innerJoin(games, eq(games.id, gameOfficials.gameId))
        .innerJoin(divisions, eq(divisions.id, games.divisionId))
        .where(inArray(gameOfficials.payoutId, payouts.map((p) => p.id)))
        .orderBy(asc(games.startsAt))
    : [];
  return payouts.map((p) => ({
    ...publicPayout(p),
    lastError:
      p.status === "paid" ? null : p.lastError === NOT_READY ? "Finish payout setup to receive this." : p.status === "failed" ? "The league is working on sending this." : "On its way; the league is sending it.",
    createdAt: p.createdAt,
    games: items.filter((i) => i.payoutId === p.id),
  }));
}

/* ---------------- year-end ---------------- */

/** Paid totals per referee for a calendar year (for the league's accountant; Stripe files the 1099s). */
export async function yearReport(year: number) {
  const from = new Date(`${year}-01-01T05:00:00Z`);
  const to = new Date(`${year + 1}-01-01T05:00:00Z`);
  return db
    .select({
      name: user.name,
      email: user.email,
      payouts: sql<number>`count(*)::int`,
      totalCents: sql<number>`sum(${refereePayouts.amountCents})::int`,
      stripeAccountId: refereeAccounts.stripeAccountId,
    })
    .from(refereePayouts)
    .innerJoin(user, eq(user.id, refereePayouts.userId))
    .leftJoin(refereeAccounts, eq(refereeAccounts.userId, refereePayouts.userId))
    .where(and(eq(refereePayouts.status, "paid"), eq(refereePayouts.environment, stripeEnvironment()), gte(refereePayouts.paidAt, from), lt(refereePayouts.paidAt, to)))
    .groupBy(user.name, user.email, refereeAccounts.stripeAccountId)
    .orderBy(asc(user.name));
}

export const publishableKey = () => env.STRIPE_PUBLISHABLE_KEY?.trim() ?? "";
