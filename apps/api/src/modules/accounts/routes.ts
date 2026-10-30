/** Signed-in user's own profile, MFA status and household. */
import { householdInput } from "@nffl/shared";
import { eq } from "drizzle-orm";
import { Router } from "express";
import { db } from "../../db/client.js";
import { householdMembers, households } from "../../db/schema/index.js";
import { handler, mfaStatus, requireAuth, requireMfa } from "../../http/context.js";
import { HttpError } from "../../http/errors.js";
import { allPermissions } from "../platform/access.js";
import { writeAudit } from "../platform/audit.js";
import { publish } from "../platform/outbox.js";

export const accountsRouter = Router();

/**
 * Available before MFA is complete so the front end can route the user to
 * the right enrollment screen.
 */
accountsRouter.get(
  "/me",
  requireAuth,
  handler(async (req, res) => {
    const { user } = req.ctx.auth!;
    const access = req.ctx.access!;
    const [membership] = await db
      .select({ householdId: householdMembers.householdId, memberRole: householdMembers.memberRole })
      .from(householdMembers)
      .where(eq(householdMembers.userId, user.id))
      .limit(1);
    res.json({
      user: { id: user.id, name: user.name, email: user.email, locale: user.locale },
      roles: access.roles,
      permissions: allPermissions(access),
      mfa: { ...mfaStatus(req.ctx), totpEnrolled: access.hasVerifiedTotp },
      householdId: membership?.householdId ?? null,
    });
  }),
);

async function myHouseholdId(userId: string) {
  const [m] = await db
    .select({ householdId: householdMembers.householdId })
    .from(householdMembers)
    .where(eq(householdMembers.userId, userId))
    .limit(1);
  return m?.householdId ?? null;
}

accountsRouter.get(
  "/households/me",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    const id = await myHouseholdId(req.ctx.auth!.user.id);
    if (!id) throw new HttpError(404, "NOT_FOUND", "No household yet.");
    const [h] = await db.select().from(households).where(eq(households.id, id));
    res.json({ household: h });
  }),
);

accountsRouter.post(
  "/households",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    const input = householdInput.parse(req.body);
    const userId = req.ctx.auth!.user.id;
    if (await myHouseholdId(userId)) throw new HttpError(409, "CONFLICT", "You already have a household.");
    const created = await db.transaction(async (tx) => {
      const [h] = await tx.insert(households).values(input).returning();
      await tx.insert(householdMembers).values({
        householdId: h!.id,
        userId,
        memberRole: "primary",
        verifiedAt: new Date(),
      });
      await writeAudit(tx, {
        actorUserId: userId,
        action: "household.create",
        targetType: "household",
        targetId: h!.id,
        after: h,
        requestId: req.ctx.requestId,
        ipAddress: req.ctx.ip,
      });
      await publish(tx, { name: "household.created", aggregateType: "household", aggregateId: h!.id });
      return h!;
    });
    res.status(201).json({ household: created });
  }),
);

accountsRouter.patch(
  "/households/me",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    const input = householdInput.partial().parse(req.body);
    const userId = req.ctx.auth!.user.id;
    const id = await myHouseholdId(userId);
    if (!id) throw new HttpError(404, "NOT_FOUND", "No household yet.");
    const updated = await db.transaction(async (tx) => {
      const [before] = await tx.select().from(households).where(eq(households.id, id));
      const [after] = await tx
        .update(households)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(households.id, id))
        .returning();
      await writeAudit(tx, {
        actorUserId: userId,
        action: "household.update",
        targetType: "household",
        targetId: id,
        before,
        after,
        requestId: req.ctx.requestId,
        ipAddress: req.ctx.ip,
      });
      return after;
    });
    res.json({ household: updated });
  }),
);
