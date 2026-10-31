/**
 * Family-facing routes: children (players), registration options, starting a
 * registration, paying for it, and the family's registration list.
 * Registration itself is behind the `r1b.registration` release switch;
 * managing children is always available.
 */
import { acceptOfferInput, joinWaitlistInput, payRegistrationInput, playerInput, startRegistrationInput } from "@nffl/shared";
import { and, asc, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { env } from "../../config.js";
import { db } from "../../db/client.js";
import {
  divisions,
  drafts,
  householdMembers,
  payments,
  playerMedical,
  players,
  registrations,
  rosterEntries,
  seasons,
  teams,
  teamStaff,
  user,
} from "../../db/schema/index.js";
import { handler, requireAuth, requireMfa } from "../../http/context.js";
import { HttpError } from "../../http/errors.js";
import { writeAudit } from "../platform/audit.js";
import { FLAG, isEnabled } from "../platform/flags.js";
import { getCredentials } from "../square/client.js";
import {
  cancelRegistration,
  currentWaivers,
  ineligibleReason,
  payRegistration,
  registrationWindow,
  spotsTaken,
  startRegistration,
  waitingCount,
} from "./service.js";
import { acceptOffer, joinWaitlist, leaveWaitlist, listMyWaitlist, WAITLIST_FLAG } from "./waitlist.js";
import { getPaymentSettings, quote } from "./settings.js";

export const registrationRouter = Router();

async function householdOf(userId: string) {
  const [m] = await db
    .select({ householdId: householdMembers.householdId })
    .from(householdMembers)
    .where(eq(householdMembers.userId, userId))
    .limit(1);
  if (!m) throw new HttpError(409, "CONFLICT", "Add your family details first.");
  return m.householdId;
}

const registrationOn: RequestHandler = (_req, _res, next) => {
  isEnabled("r1b.registration")
    .then((on) => next(on ? undefined : new HttpError(403, "FEATURE_DISABLED", "Registration isn't open yet.")))
    .catch(next);
};

const actorOf = (req: Parameters<RequestHandler>[0]) => ({
  userId: req.ctx.auth!.user.id,
  requestId: req.ctx.requestId,
  ip: req.ctx.ip,
});

/* ---------------- players ---------------- */

registrationRouter.get(
  "/players",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    const householdId = await householdOf(req.ctx.auth!.user.id);
    const rows = await db
      .select()
      .from(players)
      .where(eq(players.householdId, householdId))
      .orderBy(asc(players.birthDate));
    res.json({ items: rows });
  }),
);

registrationRouter.get(
  "/players/:id",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    const householdId = await householdOf(req.ctx.auth!.user.id);
    const [p] = await db
      .select()
      .from(players)
      .where(and(eq(players.id, String(req.params.id)), eq(players.householdId, householdId)));
    if (!p) throw new HttpError(404, "NOT_FOUND", "Player not found.");
    const [medical] = await db.select().from(playerMedical).where(eq(playerMedical.playerId, p.id));
    res.json({ player: p, medical: medical ?? null });
  }),
);

registrationRouter.post(
  "/players",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    const input = playerInput.parse(req.body);
    const householdId = await householdOf(req.ctx.auth!.user.id);
    const { medical, ...profile } = input;
    const created = await db.transaction(async (tx) => {
      const [p] = await tx.insert(players).values({ ...profile, householdId }).returning();
      await tx.insert(playerMedical).values({ ...medical, playerId: p!.id });
      await writeAudit(tx, {
        actorUserId: req.ctx.auth!.user.id,
        action: "player.create",
        targetType: "player",
        targetId: p!.id,
        after: { ...p, ...medical },
        requestId: req.ctx.requestId,
        ipAddress: req.ctx.ip,
      });
      return p!;
    });
    res.status(201).json({ player: created });
  }),
);

registrationRouter.patch(
  "/players/:id",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    const input = playerInput.parse(req.body);
    const householdId = await householdOf(req.ctx.auth!.user.id);
    const id = String(req.params.id);
    const { medical, ...profile } = input;
    const updated = await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(players)
        .where(and(eq(players.id, id), eq(players.householdId, householdId)));
      if (!before) throw new HttpError(404, "NOT_FOUND", "Player not found.");
      // Birth date and gender decide eligibility: locked once a registration is paid.
      const [locked] = await tx
        .select({ id: registrations.id })
        .from(registrations)
        .where(and(eq(registrations.playerId, id), inArray(registrations.status, ["processing", "paid", "approved"])))
        .limit(1);
      if (locked && (profile.birthDate !== before.birthDate || profile.gender !== before.gender)) {
        throw new HttpError(409, "CONFLICT", "Birth date and gender can't be changed after registering. Please contact the league.");
      }
      const [after] = await tx
        .update(players)
        .set({
          ...profile,
          preferredName: profile.preferredName ?? null,
          shirtSize: profile.shirtSize ?? null,
          school: profile.school ?? null,
          grade: profile.grade ?? null,
          updatedAt: new Date(),
        })
        .where(eq(players.id, id))
        .returning();
      const medicalRow = {
        allergies: medical.allergies ?? null,
        medicalConditions: medical.medicalConditions ?? null,
        medications: medical.medications ?? null,
        medicalInstructions: medical.medicalInstructions ?? null,
        physicianName: medical.physicianName ?? null,
        physicianPhone: medical.physicianPhone ?? null,
        emergencyContactName: medical.emergencyContactName,
        emergencyContactPhone: medical.emergencyContactPhone,
        emergencyContactRelationship: medical.emergencyContactRelationship ?? null,
        updatedAt: new Date(),
      };
      await tx
        .insert(playerMedical)
        .values({ playerId: id, ...medicalRow })
        .onConflictDoUpdate({ target: playerMedical.playerId, set: medicalRow });
      await writeAudit(tx, {
        actorUserId: req.ctx.auth!.user.id,
        action: "player.update",
        targetType: "player",
        targetId: id,
        before,
        after: { ...after, ...medical },
        requestId: req.ctx.requestId,
        ipAddress: req.ctx.ip,
      });
      return after!;
    });
    res.json({ player: updated });
  }),
);

/* ---------------- registration ---------------- */

/** Everything the registration screen needs: season, divisions with prices, waivers, card form settings. */
registrationRouter.get(
  "/registration/options",
  requireAuth,
  requireMfa,
  handler(async (_req, res) => {
    const enabled = await isEnabled("r1b.registration");
    const [season] = await db.select().from(seasons).where(eq(seasons.isCurrent, "current")).limit(1);
    if (!enabled || !season) {
      res.json({ enabled, season: null, window: { open: false, reason: "Registration isn't open yet." }, divisions: [], waivers: [], square: null });
      return;
    }
    const settings = await getPaymentSettings();
    const divs = await db
      .select()
      .from(divisions)
      .where(and(eq(divisions.seasonId, season.id), ne(divisions.status, "draft")))
      .orderBy(asc(divisions.sortOrder), asc(divisions.name));
    const withSpots = await Promise.all(
      divs.map(async (d) => ({
        id: d.id,
        name: d.name,
        genderPolicy: d.genderPolicy,
        birthDateFrom: d.birthDateFrom,
        birthDateTo: d.birthDateTo,
        eligibilityNotes: d.eligibilityNotes,
        status: d.status,
        full: d.status === "full" || (await spotsTaken(db, d.id)) >= d.capacity || (await waitingCount(db, d.id)) > 0,
        ...quote(d.priceCents, settings),
      })),
    );
    const creds = await getCredentials().catch(() => null);
    const waivers = await currentWaivers();
    res.json({
      enabled,
      season: { id: season.id, name: season.name, registrationOpensAt: season.registrationOpensAt, registrationClosesAt: season.registrationClosesAt },
      window: registrationWindow(season),
      feeMode: settings.feeMode,
      holdMinutes: settings.holdMinutes,
      waitlist: await isEnabled(WAITLIST_FLAG),
      offerHours: settings.offerHours,
      divisions: withSpots,
      waivers: waivers.map((w) => ({ slug: w.slug, title: w.title, body: w.body, isPlaceholder: w.isPlaceholder })),
      // Public values for the Square card form. null = payments unavailable right now.
      square:
        creds && env.SQUARE_APPLICATION_ID
          ? { applicationId: env.SQUARE_APPLICATION_ID, locationId: creds.locationId, environment: creds.environment }
          : null,
    });
  }),
);

/** Which divisions a child is eligible for (the screen greys out the rest with the reason). */
registrationRouter.get(
  "/players/:id/eligibility",
  requireAuth,
  requireMfa,
  registrationOn,
  handler(async (req, res) => {
    const householdId = await householdOf(req.ctx.auth!.user.id);
    const [p] = await db
      .select()
      .from(players)
      .where(and(eq(players.id, String(req.params.id)), eq(players.householdId, householdId)));
    if (!p) throw new HttpError(404, "NOT_FOUND", "Player not found.");
    const [season] = await db.select().from(seasons).where(eq(seasons.isCurrent, "current")).limit(1);
    if (!season) {
      res.json({ items: [] });
      return;
    }
    const divs = await db
      .select()
      .from(divisions)
      .where(and(eq(divisions.seasonId, season.id), ne(divisions.status, "draft")));
    res.json({ items: divs.map((d) => ({ divisionId: d.id, reason: ineligibleReason(p, d) })) });
  }),
);

registrationRouter.get(
  "/registrations",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    const householdId = await householdOf(req.ctx.auth!.user.id).catch(() => null);
    if (!householdId) {
      res.json({ items: [] });
      return;
    }
    const rows = await db
      .select({
        id: registrations.id,
        status: registrations.status,
        priceCents: registrations.priceCents,
        feeCents: registrations.feeCents,
        totalCents: registrations.totalCents,
        holdExpiresAt: registrations.holdExpiresAt,
        paymentError: registrations.paymentError,
        decisionReason: registrations.decisionReason,
        paidAt: registrations.paidAt,
        createdAt: registrations.createdAt,
        playerId: players.id,
        playerName: players.firstName,
        playerLastName: players.lastName,
        divisionName: divisions.name,
        seasonName: seasons.name,
      })
      .from(registrations)
      .innerJoin(players, eq(players.id, registrations.playerId))
      .innerJoin(divisions, eq(divisions.id, registrations.divisionId))
      .innerJoin(seasons, eq(seasons.id, registrations.seasonId))
      .where(and(eq(registrations.householdId, householdId), ne(registrations.status, "cancelled")))
      .orderBy(desc(registrations.createdAt));
    const ids = rows.map((r) => r.id);
    const pays = ids.length
      ? await db
          .select({
            registrationId: payments.registrationId,
            receiptUrl: payments.receiptUrl,
            refundedCents: payments.refundedCents,
            cardBrand: payments.cardBrand,
            cardLast4: payments.cardLast4,
          })
          .from(payments)
          .where(inArray(payments.registrationId, ids))
      : [];
    const teamsOn = await isEnabled(FLAG.teams);
    const placements = ids.length
      ? await db
          .select({ registrationId: rosterEntries.registrationId, teamId: teams.id, teamName: teams.name })
          .from(rosterEntries)
          .innerJoin(teams, eq(teams.id, rosterEntries.teamId))
          .innerJoin(drafts, and(eq(drafts.divisionId, rosterEntries.divisionId), isNotNull(drafts.publishedAt)))
          .where(inArray(rosterEntries.registrationId, ids))
      : [];
    const coaches = placements.length
      ? await db
          .select({ teamId: teamStaff.teamId, name: user.name, email: user.email })
          .from(teamStaff)
          .innerJoin(user, eq(user.id, teamStaff.userId))
          .where(and(inArray(teamStaff.teamId, placements.map((p) => p.teamId)), eq(teamStaff.roleKey, "head_coach")))
      : [];
    res.json({
      items: rows.map((r) => {
        const place = placements.find((p) => p.registrationId === r.id);
        const coach = place ? coaches.find((c) => c.teamId === place.teamId) : undefined;
        return {
          ...r,
          payment: pays.find((p) => p.registrationId === r.id) ?? null,
          team: place && teamsOn ? { name: place.teamName, coach: coach ? { name: coach.name, email: coach.email } : null } : null,
        };
      }),
    });
  }),
);

registrationRouter.post(
  "/registrations",
  requireAuth,
  requireMfa,
  registrationOn,
  handler(async (req, res) => {
    const input = startRegistrationInput.parse(req.body);
    const householdId = await householdOf(req.ctx.auth!.user.id);
    const reg = await startRegistration(actorOf(req), householdId, input);
    res.status(201).json({ registration: reg });
  }),
);

// Card attempts per user, to slow down card testing.
const payLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: env.NODE_ENV === "test" ? 1000 : 10,
  keyGenerator: (req) => req.ctx?.auth?.user.id ?? "anon",
  // Keyed by signed-in user, not IP, so the IP-specific checks don't apply.
  validate: false,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      error: { code: "RATE_LIMITED", message: "Too many payment attempts. Please try again later.", requestId: req.ctx?.requestId },
    }),
});

registrationRouter.post(
  "/registrations/:id/pay",
  requireAuth,
  requireMfa,
  registrationOn,
  payLimiter,
  handler(async (req, res) => {
    const input = payRegistrationInput.parse(req.body);
    const householdId = await householdOf(req.ctx.auth!.user.id);
    const reg = await payRegistration(actorOf(req), householdId, String(req.params.id), input, req.ctx.auth!.user.email);
    res.json({ registration: reg });
  }),
);

registrationRouter.post(
  "/registrations/:id/cancel",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    const householdId = await householdOf(req.ctx.auth!.user.id);
    const { registration } = await cancelRegistration(
      String(req.params.id),
      { reason: "Cancelled by family before payment", refund: false, householdId },
      actorOf(req),
    );
    res.json({ registration });
  }),
);

/* ---------------- waitlist (R2) ---------------- */

registrationRouter.get(
  "/waitlist",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    const householdId = await householdOf(req.ctx.auth!.user.id).catch(() => null);
    res.json({ items: householdId ? await listMyWaitlist(householdId) : [] });
  }),
);

registrationRouter.post(
  "/waitlist",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    const input = joinWaitlistInput.parse(req.body);
    const householdId = await householdOf(req.ctx.auth!.user.id);
    res.status(201).json(await joinWaitlist(actorOf(req), householdId, input));
  }),
);

registrationRouter.post(
  "/waitlist/:id/leave",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    const householdId = await householdOf(req.ctx.auth!.user.id);
    res.json({ entry: await leaveWaitlist(actorOf(req), householdId, String(req.params.id)) });
  }),
);

registrationRouter.post(
  "/waitlist/:id/accept",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    const input = acceptOfferInput.parse(req.body);
    const householdId = await householdOf(req.ctx.auth!.user.id);
    res.status(201).json({ registration: await acceptOffer(actorOf(req), householdId, String(req.params.id), input) });
  }),
);
