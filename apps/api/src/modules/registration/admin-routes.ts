/**
 * Admin portal: season and division setup, registrations (review, refund,
 * cancel, export) and payment settings. Mounted at /api/v1/admin/league.
 */
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../../db/client.js";
import {
  divisions,
  householdMembers,
  households,
  payments,
  playerMedical,
  players,
  promoCodes,
  refunds,
  registrations,
  rosterEntries,
  seasons,
  siteSettings,
  teams,
  withdrawalRequests,
  user,
  waitlistEntries,
} from "../../db/schema/index.js";
import { adminIdleTimeout, handler, requireAuth, requireMfa, requirePermission } from "../../http/context.js";
import { HttpError } from "../../http/errors.js";
import { can } from "../platform/access.js";
import { writeAudit } from "../platform/audit.js";
import { declineWithdrawal, latestWithdrawals, openWithdrawalCount } from "./withdrawal.js";
import { cancelRegistration, decideRegistration, refundRegistration, spotsTaken } from "./service.js";
import { getPaymentSettings, paymentSettingsSchema } from "./settings.js";
import { positionOf, removeFromWaitlist } from "./waitlist.js";

export const adminLeagueRouter = Router();
adminLeagueRouter.use(requireAuth, requireMfa, adminIdleTimeout);

const actorOf = (req: Parameters<Parameters<typeof handler>[0]>[0]) => ({
  userId: req.ctx.auth!.user.id,
  requestId: req.ctx.requestId,
  ip: req.ctx.ip,
});

/* ---------------- seasons & divisions ---------------- */

const isoDate = z.union([z.iso.date(), z.literal("")]).optional().transform((v) => v || null);
const isoDateTime = z
  .union([z.iso.datetime({ offset: true }), z.literal("")])
  .optional()
  .transform((v) => (v ? new Date(v) : null));

const seasonInput = z.object({
  name: z.string().trim().min(1).max(120),
  year: z.number().int().min(2024).max(2100),
  status: z.enum(["planning", "registration_open", "in_season", "playoffs", "completed", "archived"]),
  registrationOpensAt: isoDateTime,
  registrationClosesAt: isoDateTime,
  ageCutoffDate: isoDate,
  isCurrent: z.boolean(),
});

const divisionInput = z.object({
  name: z.string().trim().min(1).max(80),
  genderPolicy: z.enum(["coed", "boys", "girls"]),
  birthDateFrom: isoDate,
  birthDateTo: isoDate,
  eligibilityNotes: z.string().trim().max(500).optional().transform((v) => v || null),
  capacity: z.number().int().min(0).max(5000),
  priceCents: z.number().int().min(0).max(100_000),
  status: z.enum(["draft", "open", "full", "closed"]),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

adminLeagueRouter.get(
  "/seasons",
  requirePermission("seasons.read"),
  handler(async (_req, res) => {
    const ss = await db.select().from(seasons).orderBy(desc(seasons.year), desc(seasons.createdAt));
    const ds = await db.select().from(divisions).orderBy(asc(divisions.sortOrder), asc(divisions.name));
    const counts = await db
      .select({ divisionId: registrations.divisionId, status: registrations.status, n: sql<number>`count(*)::int` })
      .from(registrations)
      .groupBy(registrations.divisionId, registrations.status);
    const items = await Promise.all(
      ss.map(async (s) => ({
        ...s,
        divisions: await Promise.all(
          ds
            .filter((d) => d.seasonId === s.id)
            .map(async (d) => ({
              ...d,
              taken: await spotsTaken(db, d.id),
              counts: Object.fromEntries(counts.filter((c) => c.divisionId === d.id).map((c) => [c.status, c.n])),
            })),
        ),
      })),
    );
    res.json({ items });
  }),
);

async function setCurrent(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], seasonId: string, current: boolean) {
  if (current) await tx.update(seasons).set({ isCurrent: null }).where(sql`${seasons.id} <> ${seasonId}`);
  await tx.update(seasons).set({ isCurrent: current ? "current" : null }).where(eq(seasons.id, seasonId));
}

adminLeagueRouter.post(
  "/seasons",
  requirePermission("seasons.manage"),
  handler(async (req, res) => {
    const { isCurrent, ...input } = seasonInput.parse(req.body);
    const created = await db.transaction(async (tx) => {
      const [s] = await tx.insert(seasons).values(input).returning();
      await setCurrent(tx, s!.id, isCurrent);
      await writeAudit(tx, { actorUserId: req.ctx.auth!.user.id, action: "season.create", targetType: "season", targetId: s!.id, after: { ...s, isCurrent } });
      return s!;
    });
    res.status(201).json({ season: created });
  }),
);

adminLeagueRouter.put(
  "/seasons/:id",
  requirePermission("seasons.manage"),
  handler(async (req, res) => {
    const { isCurrent, ...input } = seasonInput.parse(req.body);
    const id = String(req.params.id);
    const updated = await db.transaction(async (tx) => {
      const [before] = await tx.select().from(seasons).where(eq(seasons.id, id));
      if (!before) throw new HttpError(404, "NOT_FOUND", "Season not found.");
      await tx.update(seasons).set({ ...input, updatedAt: new Date() }).where(eq(seasons.id, id));
      await setCurrent(tx, id, isCurrent);
      const [after] = await tx.select().from(seasons).where(eq(seasons.id, id));
      await writeAudit(tx, { actorUserId: req.ctx.auth!.user.id, action: "season.update", targetType: "season", targetId: id, before, after });
      return after!;
    });
    res.json({ season: updated });
  }),
);

function checkRange(d: { birthDateFrom: string | null; birthDateTo: string | null }) {
  if (d.birthDateFrom && d.birthDateTo && d.birthDateFrom > d.birthDateTo) {
    throw new HttpError(400, "VALIDATION_FAILED", "“Born on or after” must be earlier than “born on or before”.");
  }
}

adminLeagueRouter.post(
  "/seasons/:id/divisions",
  requirePermission("seasons.manage"),
  handler(async (req, res) => {
    const input = divisionInput.parse(req.body);
    checkRange(input);
    const seasonId = String(req.params.id);
    try {
      const created = await db.transaction(async (tx) => {
        const [d] = await tx.insert(divisions).values({ ...input, seasonId }).returning();
        await writeAudit(tx, { actorUserId: req.ctx.auth!.user.id, action: "division.create", targetType: "division", targetId: d!.id, after: d });
        return d!;
      });
      res.status(201).json({ division: created });
    } catch (err) {
      if ((err as { cause?: { code?: string } }).cause?.code === "23505") throw new HttpError(409, "CONFLICT", "A division with that name already exists this season.");
      throw err;
    }
  }),
);

adminLeagueRouter.put(
  "/divisions/:id",
  requirePermission("seasons.manage"),
  handler(async (req, res) => {
    const input = divisionInput.parse(req.body);
    checkRange(input);
    const id = String(req.params.id);
    const updated = await db.transaction(async (tx) => {
      const [before] = await tx.select().from(divisions).where(eq(divisions.id, id)).for("update");
      if (!before) throw new HttpError(404, "NOT_FOUND", "Division not found.");
      const [after] = await tx.update(divisions).set({ ...input, updatedAt: new Date() }).where(eq(divisions.id, id)).returning();
      await writeAudit(tx, { actorUserId: req.ctx.auth!.user.id, action: "division.update", targetType: "division", targetId: id, before, after });
      return after!;
    });
    res.json({ division: updated });
  }),
);

/* ---------------- registrations ---------------- */

const REG_STATUSES = ["pending_payment", "processing", "paid", "approved", "rejected", "expired", "cancelled"];

const listQuery = z.object({
  seasonId: z.uuid().optional(),
  divisionId: z.uuid().optional(),
  /** Comma-separated statuses, e.g. "paid,approved". */
  status: z
    .string()
    .max(200)
    .optional()
    .transform((v) => (v ? v.split(",").filter((x) => REG_STATUSES.includes(x)) : undefined)),
  q: z.string().trim().max(100).optional(),
  /** "open": only registrations with an open withdrawal request. */
  withdrawal: z.enum(["open"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

const PAGE_SIZE = 50;

function registrationFilters(q: z.infer<typeof listQuery>) {
  const statuses = q.status?.length ? q.status : ["processing", "paid", "approved", "rejected", "pending_payment"];
  const like = q.q ? `%${q.q.replace(/[%_\\]/g, "\\$&")}%` : null;
  return and(
    q.seasonId ? eq(registrations.seasonId, q.seasonId) : undefined,
    q.divisionId ? eq(registrations.divisionId, q.divisionId) : undefined,
    inArray(registrations.status, statuses),
    q.withdrawal === "open"
      ? sql`exists (select 1 from ${withdrawalRequests} w where w.registration_id = ${registrations.id} and w.status = 'open')`
      : undefined,
    like
      ? or(
          ilike(players.firstName, like),
          ilike(players.lastName, like),
          ilike(sql`${players.firstName} || ' ' || ${players.lastName}`, like),
          ilike(households.displayName, like),
        )
      : undefined,
  );
}

function listSelect() {
  return db
    .select({
      id: registrations.id,
      status: registrations.status,
      totalCents: registrations.totalCents,
      feeCents: registrations.feeCents,
      discountCents: registrations.discountCents,
      promoCode: promoCodes.code,
      paidAt: registrations.paidAt,
      createdAt: registrations.createdAt,
      playerFirstName: players.firstName,
      playerLastName: players.lastName,
      birthDate: players.birthDate,
      gender: players.gender,
      shirtSize: players.shirtSize,
      divisionName: divisions.name,
      householdId: registrations.householdId,
      householdName: households.displayName,
      householdPhone: households.phone,
    })
    .from(registrations)
    .innerJoin(players, eq(players.id, registrations.playerId))
    .innerJoin(divisions, eq(divisions.id, registrations.divisionId))
    .innerJoin(households, eq(households.id, registrations.householdId))
    .leftJoin(promoCodes, eq(promoCodes.id, registrations.promoCodeId));
}

adminLeagueRouter.get(
  "/registrations",
  requirePermission("registrations.read"),
  handler(async (req, res) => {
    const q = listQuery.parse(req.query);
    const where = registrationFilters(q);
    const rows = await listSelect()
      .where(where)
      .orderBy(desc(registrations.createdAt))
      .limit(PAGE_SIZE)
      .offset((q.page - 1) * PAGE_SIZE);
    const [total] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(registrations)
      .innerJoin(players, eq(players.id, registrations.playerId))
      .innerJoin(households, eq(households.id, registrations.householdId))
      .where(where);
    res.json({ items: rows, total: total?.n ?? 0, page: q.page, pageSize: PAGE_SIZE });
  }),
);

/** Spreadsheet-safe CSV cell: quotes, and neutralizes formulas (=, +, -, @). */
function csvCell(v: unknown) {
  let s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

adminLeagueRouter.get(
  "/registrations/export.csv",
  requirePermission("registrations.export"),
  handler(async (req, res) => {
    const q = listQuery.parse(req.query);
    const rows = await listSelect().where(registrationFilters(q)).orderBy(asc(divisions.name), asc(players.lastName));
    const householdIds = [...new Set(rows.map((r) => r.householdId))];
    const guardians = householdIds.length
      ? await db
          .select({ householdId: householdMembers.householdId, email: user.email, name: user.name, memberRole: householdMembers.memberRole })
          .from(householdMembers)
          .innerJoin(user, eq(user.id, householdMembers.userId))
          .where(inArray(householdMembers.householdId, householdIds))
          .orderBy(asc(householdMembers.createdAt))
      : [];
    const header = ["Player first name", "Player last name", "Birth date", "Gender", "Division", "Status", "Shirt size", "Family", "Guardian", "Guardian email", "Phone", "Promo code", "Discount", "Total paid", "Paid at", "Registration id"];
    const lines = rows.map((r) => {
      const g = guardians.find((x) => x.householdId === r.householdId);
      return [
        r.playerFirstName,
        r.playerLastName,
        r.birthDate,
        r.gender,
        r.divisionName,
        r.status,
        r.shirtSize,
        r.householdName,
        g?.name,
        g?.email,
        r.householdPhone,
        r.promoCode,
        r.discountCents ? (r.discountCents / 100).toFixed(2) : "",
        (r.totalCents / 100).toFixed(2),
        r.paidAt,
        r.id,
      ]
        .map(csvCell)
        .join(",");
    });
    await writeAudit(db, {
      actorUserId: req.ctx.auth!.user.id,
      action: "registration.export",
      targetType: "registration",
      after: { filters: q, rows: rows.length },
      requestId: req.ctx.requestId,
      ipAddress: req.ctx.ip,
    });
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="nffl-registrations-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader("cache-control", "no-store");
    res.send([header.map(csvCell).join(","), ...lines].join("\r\n"));
  }),
);

adminLeagueRouter.get(
  "/registrations/:id",
  requirePermission("registrations.read"),
  handler(async (req, res) => {
    const id = String(req.params.id);
    const [r] = await db.select().from(registrations).where(eq(registrations.id, id));
    if (!r) throw new HttpError(404, "NOT_FOUND", "Registration not found.");
    const [player] = await db.select().from(players).where(eq(players.id, r.playerId));
    const [division] = await db.select().from(divisions).where(eq(divisions.id, r.divisionId));
    const [season] = await db.select().from(seasons).where(eq(seasons.id, r.seasonId));
    const [household] = await db.select().from(households).where(eq(households.id, r.householdId));
    const guardians = await db
      .select({ name: user.name, email: user.email, memberRole: householdMembers.memberRole })
      .from(householdMembers)
      .innerJoin(user, eq(user.id, householdMembers.userId))
      .where(eq(householdMembers.householdId, r.householdId));
    const pays = await db.select().from(payments).where(eq(payments.registrationId, id)).orderBy(asc(payments.createdAt));
    const refs = pays.length
      ? await db.select().from(refunds).where(inArray(refunds.paymentId, pays.map((p) => p.id))).orderBy(asc(refunds.createdAt))
      : [];
    const canMedical = can(req.ctx.access!, "medical.read");
    let medical = null;
    if (canMedical) {
      [medical] = await db.select().from(playerMedical).where(eq(playerMedical.playerId, r.playerId));
      await writeAudit(db, {
        actorUserId: req.ctx.auth!.user.id,
        action: "medical.view",
        targetType: "player",
        targetId: r.playerId,
        requestId: req.ctx.requestId,
        ipAddress: req.ctx.ip,
      });
    }
    const [team] = await db
      .select({ entryId: rosterEntries.id, teamId: teams.id, name: teams.name, source: rosterEntries.source })
      .from(rosterEntries)
      .innerJoin(teams, eq(teams.id, rosterEntries.teamId))
      .where(eq(rosterEntries.registrationId, id));
    const [promo] = r.promoCodeId ? await db.select({ code: promoCodes.code }).from(promoCodes).where(eq(promoCodes.id, r.promoCodeId)) : [];
    res.json({
      registration: { ...r, promoCode: promo?.code ?? null },
      withdrawal: (await latestWithdrawals([r.id])).get(r.id) ?? null,
      team: team ?? null,
      player,
      division,
      season: season ? { id: season.id, name: season.name } : null,
      household,
      guardians,
      payments: pays,
      refunds: refs,
      medical: medical ?? null,
      canSeeMedical: canMedical,
    });
  }),
);

/** Decline a family's withdrawal request with a note (to accept it, cancel the registration). */
adminLeagueRouter.post(
  "/registrations/:id/withdrawal/decline",
  requirePermission("registrations.manage"),
  handler(async (req, res) => {
    const { note } = z.object({ note: z.string().trim().min(3).max(1000) }).parse(req.body);
    res.json({ withdrawal: await declineWithdrawal({ userId: req.ctx.auth!.user.id, requestId: req.ctx.requestId, ip: req.ctx.ip }, String(req.params.id), note) });
  }),
);

/** How many withdrawal requests are waiting (admin home). */
adminLeagueRouter.get(
  "/withdrawals/count",
  requirePermission("registrations.read"),
  handler(async (_req, res) => {
    res.json({ open: await openWithdrawalCount() });
  }),
);

adminLeagueRouter.post(
  "/registrations/:id/decision",
  requirePermission("eligibility.decide"),
  handler(async (req, res) => {
    const input = z
      .object({ decision: z.enum(["approved", "rejected"]), reason: z.string().trim().max(500).optional(), refund: z.boolean().default(true) })
      .parse(req.body);
    if (input.decision === "rejected" && !input.reason) throw new HttpError(400, "VALIDATION_FAILED", "Give the family a reason.");
    if (input.decision === "rejected" && input.refund && !can(req.ctx.access!, "refunds.issue")) {
      throw new HttpError(403, "FORBIDDEN", "You don't have permission to issue refunds.");
    }
    res.json(await decideRegistration(String(req.params.id), input, actorOf(req)));
  }),
);

adminLeagueRouter.post(
  "/registrations/:id/refund",
  requirePermission("refunds.issue"),
  handler(async (req, res) => {
    const input = z
      .object({ amountCents: z.number().int().min(1).optional(), reason: z.string().trim().min(3).max(190) })
      .parse(req.body);
    res.json({ refund: await refundRegistration(String(req.params.id), input, actorOf(req)) });
  }),
);

adminLeagueRouter.post(
  "/registrations/:id/cancel",
  requirePermission("registrations.manage"),
  handler(async (req, res) => {
    const input = z.object({ reason: z.string().trim().min(3).max(190), refund: z.boolean().default(false) }).parse(req.body);
    if (input.refund && !can(req.ctx.access!, "refunds.issue")) throw new HttpError(403, "FORBIDDEN", "You don't have permission to issue refunds.");
    res.json(await cancelRegistration(String(req.params.id), input, actorOf(req)));
  }),
);

/* ---------------- payment settings ---------------- */

adminLeagueRouter.put(
  "/payment-settings",
  requirePermission("platform.settings.manage"),
  handler(async (req, res) => {
    const before = await getPaymentSettings();
    // Fields left out keep their current value (so an older page can't reset the provider).
    const input = paymentSettingsSchema.parse({ ...before, ...(req.body as object) });
    await db.transaction(async (tx) => {
      await tx
        .insert(siteSettings)
        .values({ key: "payments", value: input, updatedBy: req.ctx.auth!.user.id })
        .onConflictDoUpdate({ target: siteSettings.key, set: { value: input, updatedBy: req.ctx.auth!.user.id, updatedAt: new Date() } });
      await writeAudit(tx, {
        actorUserId: req.ctx.auth!.user.id,
        action: "payments.settings.update",
        targetType: "setting",
        targetId: "payments",
        before,
        after: input,
        requestId: req.ctx.requestId,
        ipAddress: req.ctx.ip,
      });
    });
    res.json({ settings: input });
  }),
);

/* ---------------- waitlist (R2) ---------------- */

adminLeagueRouter.get(
  "/waitlist",
  requirePermission("registrations.read"),
  handler(async (req, res) => {
    const q = z.object({ seasonId: z.uuid().optional(), all: z.string().optional() }).parse(req.query);
    const rows = await db
      .select({
        id: waitlistEntries.id,
        status: waitlistEntries.status,
        divisionId: waitlistEntries.divisionId,
        divisionName: divisions.name,
        playerFirstName: players.firstName,
        playerLastName: players.lastName,
        birthDate: players.birthDate,
        householdName: households.displayName,
        householdPhone: households.phone,
        offeredAt: waitlistEntries.offeredAt,
        offerExpiresAt: waitlistEntries.offerExpiresAt,
        registrationId: waitlistEntries.registrationId,
        createdAt: waitlistEntries.createdAt,
      })
      .from(waitlistEntries)
      .innerJoin(players, eq(players.id, waitlistEntries.playerId))
      .innerJoin(divisions, eq(divisions.id, waitlistEntries.divisionId))
      .innerJoin(households, eq(households.id, waitlistEntries.householdId))
      .where(
        and(
          q.seasonId ? eq(waitlistEntries.seasonId, q.seasonId) : undefined,
          q.all ? undefined : inArray(waitlistEntries.status, ["waiting", "offered"]),
        ),
      )
      .orderBy(asc(divisions.sortOrder), asc(divisions.name), asc(waitlistEntries.createdAt), asc(waitlistEntries.id));
    const items = await Promise.all(rows.map(async (r) => ({ ...r, position: r.status === "waiting" ? (await positionOf(r)) + 1 : null })));
    res.json({ items });
  }),
);

adminLeagueRouter.post(
  "/waitlist/:id/remove",
  requirePermission("registrations.manage"),
  handler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(3).max(190) }).parse(req.body);
    res.json({ entry: await removeFromWaitlist(actorOf(req), String(req.params.id), reason) });
  }),
);
