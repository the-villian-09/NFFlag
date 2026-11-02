/** Coach and team staff applications (Head Coach, Assistant Coach, Team Mom): applicant routes and admin review. */
import { adminStaffPhoto } from "../documents/service.js";
import { payRegistrationInput, volunteerApplicationInput } from "@nffl/shared";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Router, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { env } from "../../config.js";
import { db } from "../../db/client.js";
import { divisions, householdMembers, households, payments, players, promoCodes, refunds, seasons, user, volunteerApplications } from "../../db/schema/index.js";
import { adminIdleTimeout, handler, requireAuth, requireMfa, requirePermission } from "../../http/context.js";
import { applyToApplication } from "../promo/service.js";
import { promoLimiter } from "../promo/routes.js";
import { HttpError } from "../../http/errors.js";
import { can } from "../platform/access.js";
import { issueRefund } from "../registration/service.js";
import { applyToVolunteer, confirmApplicationPayment, decideApplication, payApplication, publicApplication, revokeApproval, ROLE_LABELS, updateScreening, volunteerOptions, withdrawApplication, type VolunteerRole } from "./service.js";

const actorOf = (req: Request) => ({ userId: req.ctx.auth!.user.id, requestId: req.ctx.requestId, ip: req.ctx.ip });

/* ---------------- applicant ---------------- */

export const staffRouter = Router();

staffRouter.get(
  "/volunteer/options",
  requireAuth,
  requireMfa,
  handler(async (_req, res) => {
    res.json(await volunteerOptions());
  }),
);

staffRouter.get(
  "/volunteer/applications",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    const rows = await db
      .select({
        id: volunteerApplications.id,
        roleKey: volunteerApplications.roleKey,
        status: volunteerApplications.status,
        totalCents: volunteerApplications.totalCents,
        discountCents: volunteerApplications.discountCents,
        promoCode: promoCodes.code,
        feeCents: volunteerApplications.feeCents,
        processingFeeCents: volunteerApplications.processingFeeCents,
        paymentError: volunteerApplications.paymentError,
        decisionReason: volunteerApplications.decisionReason,
        screeningStatus: volunteerApplications.screeningStatus,
        createdAt: volunteerApplications.createdAt,
        seasonName: seasons.name,
      })
      .from(volunteerApplications)
      .innerJoin(seasons, eq(seasons.id, volunteerApplications.seasonId))
      .leftJoin(promoCodes, eq(promoCodes.id, volunteerApplications.promoCodeId))
      .where(and(eq(volunteerApplications.userId, req.ctx.auth!.user.id), inArray(volunteerApplications.status, ["pending_payment", "processing", "submitted", "approved", "rejected", "withdrawn", "revoked"])))
      .orderBy(desc(volunteerApplications.createdAt));
    res.json({ items: rows.map((r) => ({ ...r, roleLabel: ROLE_LABELS[r.roleKey as VolunteerRole] })) });
  }),
);

staffRouter.post(
  "/volunteer/applications",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    const input = volunteerApplicationInput.parse(req.body);
    res.status(201).json({ application: publicApplication(await applyToVolunteer(actorOf(req), input)) });
  }),
);

const payLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: env.NODE_ENV === "test" ? 1000 : 10,
  keyGenerator: (req) => req.ctx?.auth?.user.id ?? "anon",
  validate: false,
  handler: (req, res) =>
    res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many payment attempts. Please try again later.", requestId: req.ctx?.requestId } }),
});

staffRouter.post(
  "/volunteer/applications/:id/pay",
  requireAuth,
  requireMfa,
  payLimiter,
  handler(async (req, res) => {
    const input = payRegistrationInput.parse(req.body);
    res.json({ application: publicApplication(await payApplication(actorOf(req), String(req.params.id), input, req.ctx.auth!.user.email)) });
  }),
);

/** After the bank's check (3-D Secure) in the browser: settle the fee payment, or cancel it so the applicant can try again. */
staffRouter.post(
  "/volunteer/applications/:id/pay/confirm",
  requireAuth,
  requireMfa,
  payLimiter,
  handler(async (req, res) => {
    res.json({ application: publicApplication(await confirmApplicationPayment(actorOf(req), String(req.params.id))) });
  }),
);

/** Apply a promo code to an unpaid application (body { code }), or remove it (code: null). */
staffRouter.put(
  "/volunteer/applications/:id/promo",
  requireAuth,
  requireMfa,
  promoLimiter,
  handler(async (req, res) => {
    const { code } = z.object({ code: z.string().trim().min(1).max(40).nullable() }).parse(req.body);
    const r = await applyToApplication(actorOf(req), String(req.params.id), code);
    res.json({ application: { ...publicApplication(r.application), promoCode: r.code } });
  }),
);

staffRouter.post(
  "/volunteer/applications/:id/withdraw",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    res.json(await withdrawApplication(actorOf(req), String(req.params.id)));
  }),
);

/* ---------------- admin ---------------- */

export const adminStaffRouter = Router();
adminStaffRouter.use(requireAuth, requireMfa, adminIdleTimeout, requirePermission("staff.applications.review"));

adminStaffRouter.get(
  "/applications",
  handler(async (req, res) => {
    const q = z.object({ seasonId: z.uuid().optional(), status: z.string().max(100).optional() }).parse(req.query);
    const statuses = q.status ? q.status.split(",") : ["submitted", "approved", "rejected", "pending_payment", "processing", "withdrawn", "revoked"];
    const rows = await db
      .select({
        id: volunteerApplications.id,
        roleKey: volunteerApplications.roleKey,
        status: volunteerApplications.status,
        screeningStatus: volunteerApplications.screeningStatus,
        screeningExpiresOn: volunteerApplications.screeningExpiresOn,
        paidAt: volunteerApplications.paidAt,
        createdAt: volunteerApplications.createdAt,
        name: user.name,
        email: user.email,
        phone: volunteerApplications.phone,
        divisionName: divisions.name,
      })
      .from(volunteerApplications)
      .innerJoin(user, eq(user.id, volunteerApplications.userId))
      .leftJoin(divisions, eq(divisions.id, volunteerApplications.preferredDivisionId))
      .where(and(q.seasonId ? eq(volunteerApplications.seasonId, q.seasonId) : undefined, inArray(volunteerApplications.status, statuses)))
      .orderBy(asc(volunteerApplications.createdAt));
    res.json({ items: rows.map((r) => ({ ...r, roleLabel: ROLE_LABELS[r.roleKey as VolunteerRole] })) });
  }),
);

adminStaffRouter.get(
  "/applications/:id",
  handler(async (req, res) => {
    const id = String(req.params.id);
    const [a] = await db.select().from(volunteerApplications).where(eq(volunteerApplications.id, id));
    if (!a) throw new HttpError(404, "NOT_FOUND", "Application not found.");
    const [u] = await db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, a.userId));
    const [h] = await db
      .select({ displayName: households.displayName, phone: households.phone })
      .from(householdMembers)
      .innerJoin(households, eq(households.id, householdMembers.householdId))
      .where(eq(householdMembers.userId, a.userId))
      .limit(1);
    const [division] = a.preferredDivisionId ? await db.select({ name: divisions.name }).from(divisions).where(eq(divisions.id, a.preferredDivisionId)) : [];
    const [player] = a.playerId ? await db.select({ firstName: players.firstName, lastName: players.lastName }).from(players).where(eq(players.id, a.playerId)) : [];
    const [season] = await db.select({ name: seasons.name }).from(seasons).where(eq(seasons.id, a.seasonId));
    const pays = await db.select().from(payments).where(eq(payments.applicationId, id)).orderBy(asc(payments.createdAt));
    const refs = pays.length ? await db.select().from(refunds).where(inArray(refunds.paymentId, pays.map((p) => p.id))) : [];
    const { paymentRequest: _omit, ...app } = a;
    res.json({
      application: { ...app, roleLabel: ROLE_LABELS[a.roleKey as VolunteerRole] },
      applicant: u,
      household: h ?? null,
      division: division ?? null,
      player: player ?? null,
      season: season ?? null,
      payments: pays,
      refunds: refs,
      photo: await adminStaffPhoto(a.userId, a.seasonId),
    });
  }),
);

const isoDate = z.union([z.iso.date(), z.literal("")]).optional().transform((v) => v || null);

adminStaffRouter.put(
  "/applications/:id/screening",
  handler(async (req, res) => {
    const input = z
      .object({
        status: z.enum(["not_started", "pending", "cleared", "not_cleared"]),
        provider: z.string().trim().max(120).optional(),
        completedOn: isoDate,
        expiresOn: isoDate,
        notes: z.string().trim().max(1000).optional(),
      })
      .parse(req.body);
    res.json({ application: await updateScreening(actorOf(req), String(req.params.id), input) });
  }),
);

adminStaffRouter.post(
  "/applications/:id/decision",
  handler(async (req, res) => {
    const input = z
      .object({ decision: z.enum(["approved", "rejected"]), reason: z.string().trim().max(500).optional(), refund: z.boolean().default(true) })
      .parse(req.body);
    if (input.decision === "rejected" && !input.reason) throw new HttpError(400, "VALIDATION_FAILED", "Give the applicant a reason.");
    if (input.decision === "rejected" && input.refund && !can(req.ctx.access!, "refunds.issue")) throw new HttpError(403, "FORBIDDEN", "You don't have permission to issue refunds.");
    res.json(await decideApplication(actorOf(req), String(req.params.id), input));
  }),
);

adminStaffRouter.post(
  "/applications/:id/revoke",
  handler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    res.json({ application: await revokeApproval(actorOf(req), String(req.params.id), reason) });
  }),
);

adminStaffRouter.post(
  "/applications/:id/refund",
  requirePermission("refunds.issue"),
  handler(async (req, res) => {
    const input = z.object({ amountCents: z.number().int().min(1).optional(), reason: z.string().trim().min(3).max(190) }).parse(req.body);
    res.json({ refund: await issueRefund({ applicationId: String(req.params.id) }, input, actorOf(req)) });
  }),
);
