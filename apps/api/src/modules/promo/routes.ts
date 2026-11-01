/** Admin: create, edit and track promo codes. */
import { Router, type Request } from "express";
import { z } from "zod";
import { adminIdleTimeout, handler, requireAuth, requireMfa, requirePermission } from "../../http/context.js";
import { createPromo, listPromos, updatePromo } from "./service.js";

const actorOf = (req: Request) => ({ userId: req.ctx.auth!.user.id, requestId: req.ctx.requestId, ip: req.ctx.ip });

const promoInput = z.object({
  code: z.string().trim().min(3).max(30),
  description: z.string().trim().max(200).optional().nullable(),
  kind: z.enum(["percent", "amount"]),
  value: z.number().int().min(1).max(1_000_000),
  appliesTo: z.enum(["registration", "staff", "both"]),
  seasonId: z.uuid().optional().nullable(),
  divisionIds: z.array(z.uuid()).max(50).default([]),
  maxUses: z.number().int().min(1).max(100_000).optional().nullable(),
  onePerFamily: z.boolean().default(false),
  startsAt: z.coerce.date().optional().nullable(),
  endsAt: z.coerce.date().optional().nullable(),
  active: z.boolean().default(true),
});

export const adminPromoRouter = Router();
adminPromoRouter.use(requireAuth, requireMfa, adminIdleTimeout);

adminPromoRouter.get(
  "/",
  requirePermission("promo.manage"),
  handler(async (_req, res) => {
    res.json({ items: await listPromos() });
  }),
);

adminPromoRouter.post(
  "/",
  requirePermission("promo.manage"),
  handler(async (req, res) => {
    res.status(201).json({ promo: await createPromo(actorOf(req), promoInput.parse(req.body)) });
  }),
);

adminPromoRouter.put(
  "/:id",
  requirePermission("promo.manage"),
  handler(async (req, res) => {
    res.json({ promo: await updatePromo(actorOf(req), z.uuid().parse(req.params.id), promoInput.parse(req.body)) });
  }),
);
