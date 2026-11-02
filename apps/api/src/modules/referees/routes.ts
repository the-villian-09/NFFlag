/**
 * Referees (R5).
 *
 * Referee:  /api/v1/referees/...          sign up, payout setup (Stripe embedded), claim games, pay statements
 * Admin:    /api/v1/admin/referees/...    review, assign games, approve pay, add funds, year-end report
 */
import { asc, eq } from "drizzle-orm";
import { Router, type Request } from "express";
import { z } from "zod";
import { db } from "../../db/client.js";
import { seasons } from "../../db/schema/index.js";
import { adminIdleTimeout, handler, requireAuth, requireMfa, requirePermission } from "../../http/context.js";
import { HttpError } from "../../http/errors.js";
import { requireFlag } from "../platform/flags.js";
import {
  addFunds,
  adminGames,
  applyAsReferee,
  approvePay,
  approvePayInput,
  assignReferee,
  certificationInput,
  claimGame,
  decideApplication,
  decisionInput,
  dropGame,
  getApplication,
  getRefereeSettings,
  listApplications,
  myPay,
  officialUpdateInput,
  payOverview,
  payoutSession,
  payoutSetup,
  publicApplication,
  publishableKey,
  REFEREE_FLAG,
  refereeApplicationInput,
  refereeGames,
  refereeHome,
  refereeSettingsSchema,
  refreshAccount,
  removeOfficial,
  revokeApproval,
  saveRefereeSettings,
  screeningInput,
  sendPayout,
  setSlots,
  topupInput,
  updateOfficial,
  updateScreening,
  verifyCertification,
  voidPayout,
  withdrawRefereeApplication,
  yearReport,
} from "./service.js";
import { stripeEnvironment } from "../stripe/client.js";

const actorOf = (req: Request) => ({ userId: req.ctx.auth!.user.id, requestId: req.ctx.requestId, ip: req.ctx.ip });

/* ---------------- referee ---------------- */

export const refereeRouter = Router();
refereeRouter.use("/referees", requireAuth, requireMfa, requireFlag(REFEREE_FLAG, "referees.manage"));

refereeRouter.get(
  "/referees/me",
  handler(async (req, res) => {
    res.json(await refereeHome(req.ctx.auth!.user.id));
  }),
);

refereeRouter.post(
  "/referees/applications",
  handler(async (req, res) => {
    const input = refereeApplicationInput.parse(req.body);
    res.status(201).json({ application: publicApplication(await applyAsReferee(actorOf(req), input)) });
  }),
);

refereeRouter.post(
  "/referees/applications/:id/withdraw",
  handler(async (req, res) => {
    res.json({ application: publicApplication(await withdrawRefereeApplication(actorOf(req), String(req.params.id))) });
  }),
);

/** A session for Stripe's embedded payout components (creates the referee's Stripe account the first time). */
refereeRouter.post(
  "/referees/payouts/session",
  handler(async (req, res) => {
    const u = req.ctx.auth!.user;
    const s = await payoutSession({ id: u.id, email: u.email });
    res.json({ clientSecret: s.clientSecret, publishableKey: publishableKey(), environment: stripeEnvironment() });
  }),
);

/** Re-reads payout setup from Stripe (after the referee finishes or leaves onboarding). */
refereeRouter.post(
  "/referees/payouts/refresh",
  handler(async (req, res) => {
    const a = await refreshAccount(req.ctx.auth!.user.id);
    res.json({ setup: payoutSetup(a), payoutsEnabled: !!a?.payoutsEnabled });
  }),
);

refereeRouter.get(
  "/referees/games",
  handler(async (req, res) => {
    res.json(await refereeGames(req.ctx.auth!.user.id));
  }),
);

refereeRouter.post(
  "/referees/games/:gameId/claim",
  handler(async (req, res) => {
    res.status(201).json({ official: await claimGame(actorOf(req), String(req.params.gameId)) });
  }),
);

refereeRouter.delete(
  "/referees/games/:gameId/claim",
  handler(async (req, res) => {
    res.json(await dropGame(actorOf(req), String(req.params.gameId)));
  }),
);

refereeRouter.get(
  "/referees/pay",
  handler(async (req, res) => {
    res.json({ payouts: await myPay(req.ctx.auth!.user.id) });
  }),
);

/* ---------------- admin ---------------- */

export const adminRefereeRouter = Router();
adminRefereeRouter.use(requireAuth, requireMfa, adminIdleTimeout);

const manage = requirePermission("referees.manage");
const pay = requirePermission("referees.pay");

async function seasonParam(req: Request) {
  const q = z.object({ seasonId: z.uuid().optional() }).parse(req.query);
  if (q.seasonId) return q.seasonId;
  const [s] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.isCurrent, "current")).orderBy(asc(seasons.createdAt)).limit(1);
  if (!s) throw new HttpError(409, "CONFLICT", "Set up a current season first.");
  return s.id;
}

adminRefereeRouter.get(
  "/settings",
  manage,
  handler(async (_req, res) => {
    res.json({ settings: await getRefereeSettings() });
  }),
);

adminRefereeRouter.put(
  "/settings",
  manage,
  handler(async (req, res) => {
    const input = refereeSettingsSchema.partial().parse(req.body);
    res.json({ settings: await saveRefereeSettings(actorOf(req), input) });
  }),
);

adminRefereeRouter.get(
  "/applications",
  manage,
  handler(async (req, res) => {
    res.json({ items: await listApplications(await seasonParam(req)) });
  }),
);

adminRefereeRouter.get(
  "/applications/:id",
  manage,
  handler(async (req, res) => {
    res.json({ application: await getApplication(String(req.params.id)) });
  }),
);

adminRefereeRouter.put(
  "/applications/:id/screening",
  manage,
  handler(async (req, res) => {
    await updateScreening(actorOf(req), String(req.params.id), screeningInput.parse(req.body));
    res.json({ application: await getApplication(String(req.params.id)) });
  }),
);

adminRefereeRouter.put(
  "/applications/:id/certification",
  manage,
  handler(async (req, res) => {
    await verifyCertification(actorOf(req), String(req.params.id), certificationInput.parse(req.body));
    res.json({ application: await getApplication(String(req.params.id)) });
  }),
);

adminRefereeRouter.post(
  "/applications/:id/decision",
  manage,
  handler(async (req, res) => {
    await decideApplication(actorOf(req), String(req.params.id), decisionInput.parse(req.body));
    res.json({ application: await getApplication(String(req.params.id)) });
  }),
);

adminRefereeRouter.post(
  "/applications/:id/revoke",
  manage,
  handler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(3).max(1000) }).parse(req.body);
    const r = await revokeApproval(actorOf(req), String(req.params.id), reason);
    res.json({ application: await getApplication(String(req.params.id)), gamesRemoved: r.gamesRemoved });
  }),
);

adminRefereeRouter.get(
  "/games",
  manage,
  handler(async (req, res) => {
    const q = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }).parse(req.query);
    const from = q.from ? new Date(`${q.from}T00:00:00-05:00`) : new Date(Date.now() - 14 * 86400_000);
    const to = q.to ? new Date(`${q.to}T23:59:59-05:00`) : new Date(Date.now() + 180 * 86400_000);
    res.json(await adminGames(await seasonParam(req), from, to));
  }),
);

adminRefereeRouter.post(
  "/games/:gameId/officials",
  manage,
  handler(async (req, res) => {
    const { userId } = z.object({ userId: z.string().min(1).max(100) }).parse(req.body);
    res.status(201).json({ official: await assignReferee(actorOf(req), String(req.params.gameId), userId) });
  }),
);

adminRefereeRouter.put(
  "/games/:gameId/slots",
  manage,
  handler(async (req, res) => {
    const { slots } = z.object({ slots: z.number().int().min(0).max(6) }).parse(req.body);
    res.json(await setSlots(actorOf(req), String(req.params.gameId), slots));
  }),
);

adminRefereeRouter.patch(
  "/officials/:id",
  manage,
  handler(async (req, res) => {
    res.json({ official: await updateOfficial(actorOf(req), String(req.params.id), officialUpdateInput.parse(req.body)) });
  }),
);

adminRefereeRouter.delete(
  "/officials/:id",
  manage,
  handler(async (req, res) => {
    res.json(await removeOfficial(actorOf(req), String(req.params.id)));
  }),
);

adminRefereeRouter.get(
  "/pay",
  pay,
  handler(async (_req, res) => {
    res.json(await payOverview());
  }),
);

adminRefereeRouter.post(
  "/pay/approve",
  pay,
  handler(async (req, res) => {
    const { officialIds } = approvePayInput.parse(req.body);
    res.json(await approvePay(actorOf(req), officialIds));
  }),
);

adminRefereeRouter.post(
  "/pay/payouts/:id/retry",
  pay,
  handler(async (req, res) => {
    res.json({ payout: await sendPayout(String(req.params.id), actorOf(req)) });
  }),
);

adminRefereeRouter.post(
  "/pay/payouts/:id/void",
  pay,
  handler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    res.json(await voidPayout(actorOf(req), String(req.params.id), reason));
  }),
);

adminRefereeRouter.post(
  "/pay/add-funds",
  pay,
  handler(async (req, res) => {
    const { amountCents } = topupInput.parse(req.body);
    res.json({ topup: await addFunds(actorOf(req), amountCents) });
  }),
);

/** Paid totals per referee for a year, as CSV (for the accountant; Stripe files the 1099s). */
adminRefereeRouter.get(
  "/pay/report.csv",
  pay,
  handler(async (req, res) => {
    const { year } = z.object({ year: z.coerce.number().int().min(2025).max(2100) }).parse(req.query);
    const rows = await yearReport(year);
    const cell = (v: unknown) => {
      const s = String(v ?? "");
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = [["Referee", "Email", "Payments", "Total paid", "Stripe account"].join(",")];
    for (const r of rows) lines.push([r.name, r.email, r.payouts, (r.totalCents / 100).toFixed(2), r.stripeAccountId ?? ""].map(cell).join(","));
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="nffl-referee-pay-${year}.csv"`);
    res.send(lines.join("\n") + "\n");
  }),
);
