/** Waivers & forms: completing them from My account, and the admin library. */
import { Router } from "express";
import { z } from "zod";
import { formResponseInput } from "@nffl/shared";
import { adminIdleTimeout, handler, requireAuth, requireMfa, requirePermission } from "../../http/context.js";
import { writeAudit } from "../platform/audit.js";
import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "../../db/client.js";
import { divisions, seasons } from "../../db/schema/index.js";
import { createForm, exportCsv, formInput, getForm, listForms, remind, setArchived, tracking, updateForm, type AdminActor } from "./admin.js";
import { completedBy, completeForm, outstandingFor } from "./service.js";

const uuid = z.uuid();

/* ---------------- My account ---------------- */

export const myFormsRouter = Router();
myFormsRouter.use("/me/forms", requireAuth, requireMfa);

/** Forms still to complete for things already signed up for, and everything completed. */
myFormsRouter.get(
  "/me/forms",
  handler(async (req, res) => {
    res.set("cache-control", "no-store");
    const userId = req.ctx.auth!.user.id;
    const [outstanding, completed] = await Promise.all([outstandingFor(userId), completedBy(userId)]);
    res.json({ outstanding, completed });
  }),
);

const completeInput = formResponseInput.extend({
  subjectType: z.enum(["registration", "staff_application", "referee_application"]),
  subjectId: uuid,
  signerName: z.string().trim().min(3).max(120),
});

myFormsRouter.post(
  "/me/forms",
  handler(async (req, res) => {
    const input = completeInput.parse(req.body);
    const r = await completeForm({ userId: req.ctx.auth!.user.id, ip: req.ctx.ip }, input);
    res.status(201).json(r);
  }),
);

/* ---------------- admin ---------------- */

export const adminFormsRouter = Router();
adminFormsRouter.use(requireAuth, requireMfa, adminIdleTimeout, requirePermission("forms.manage"));

const actorOf = (req: Parameters<Parameters<typeof handler>[0]>[0]): AdminActor => ({ userId: req.ctx.auth!.user.id, requestId: req.ctx.requestId, ip: req.ctx.ip });
const idOf = (req: Parameters<Parameters<typeof handler>[0]>[0]) => uuid.parse(req.params.id);

adminFormsRouter.get(
  "/",
  handler(async (_req, res) => {
    res.json({ items: await listForms() });
  }),
);

/** Divisions to choose from (current season). */
adminFormsRouter.get(
  "/divisions",
  handler(async (_req, res) => {
    const [season] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.isCurrent, "current")).limit(1);
    const items = season
      ? await db
          .select({ id: divisions.id, name: divisions.name })
          .from(divisions)
          .where(and(eq(divisions.seasonId, season.id), ne(divisions.status, "draft")))
          .orderBy(asc(divisions.sortOrder), asc(divisions.name))
      : [];
    res.json({ items });
  }),
);

adminFormsRouter.post(
  "/",
  handler(async (req, res) => {
    res.status(201).json(await createForm(actorOf(req), formInput.parse(req.body)));
  }),
);

adminFormsRouter.get(
  "/:id",
  handler(async (req, res) => {
    res.json(await getForm(idOf(req)));
  }),
);

adminFormsRouter.put(
  "/:id",
  handler(async (req, res) => {
    res.json(await updateForm(actorOf(req), idOf(req), formInput.parse(req.body)));
  }),
);

adminFormsRouter.post(
  "/:id/archive",
  handler(async (req, res) => {
    const { archived } = z.object({ archived: z.boolean() }).parse(req.body);
    await setArchived(actorOf(req), idOf(req), archived);
    res.json({ ok: true });
  }),
);

/** Who has and hasn't completed it (answers can include medical details: every view is audited). */
adminFormsRouter.get(
  "/:id/tracking",
  handler(async (req, res) => {
    const id = idOf(req);
    const t = await tracking(id);
    await writeAudit(db, { actorUserId: req.ctx.auth!.user.id, action: "form.responses.view", targetType: "form", targetId: id, requestId: req.ctx.requestId, ipAddress: req.ctx.ip });
    res.set("cache-control", "no-store");
    res.json({
      minVersion: t.minVersion,
      remindedAt: t.form.remindedAt,
      rows: t.rows.map(({ userIds: _u, ...r }) => r),
    });
  }),
);

adminFormsRouter.post(
  "/:id/remind",
  handler(async (req, res) => {
    res.json(await remind(actorOf(req), idOf(req)));
  }),
);

adminFormsRouter.get(
  "/:id/export.csv",
  handler(async (req, res) => {
    const { filename, csv } = await exportCsv(actorOf(req), idOf(req));
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${filename}"`);
    res.setHeader("cache-control", "no-store");
    res.send(csv);
  }),
);
