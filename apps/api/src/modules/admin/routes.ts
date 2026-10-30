/**
 * Admin portal API (R0 platform pieces). R1 adds registration screens here
 * as separate routers under /api/v1/admin.
 */
import { ROLE_KEYS } from "@nffl/shared";
import { and, desc, eq, ilike, isNull, lt, or } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../../db/client.js";
import {
  auditLogs,
  featureFlags,
  roles,
  session as sessionTable,
  twoFactor,
  user,
  userRoleAssignments,
} from "../../db/schema/index.js";
import { adminIdleTimeout, handler, requireAuth, requireMfa, requirePermission } from "../../http/context.js";
import { HttpError } from "../../http/errors.js";
import { writeAudit } from "../platform/audit.js";
import { setFlag } from "../platform/flags.js";
import { publish } from "../platform/outbox.js";

export const adminRouter = Router();

// Every admin route: signed in, authenticator app confirmed if the role requires one, not idle.
adminRouter.use(requireAuth, requireMfa, adminIdleTimeout);

/* ---------- Audit log ---------- */

adminRouter.get(
  "/audit",
  requirePermission("platform.audit.read"),
  handler(async (req, res) => {
    const q = z
      .object({
        targetType: z.string().optional(),
        targetId: z.string().optional(),
        before: z.iso.datetime().optional(), // cursor: createdAt of the last row seen
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const where = and(
      q.targetType ? eq(auditLogs.targetType, q.targetType) : undefined,
      q.targetId ? eq(auditLogs.targetId, q.targetId) : undefined,
      q.before ? lt(auditLogs.createdAt, new Date(q.before)) : undefined,
    );
    const rows = await db.select().from(auditLogs).where(where).orderBy(desc(auditLogs.createdAt)).limit(q.limit);
    res.json({ items: rows, nextCursor: rows.length === q.limit ? rows.at(-1)!.createdAt.toISOString() : null });
  }),
);

/* ---------- Feature flags ---------- */

adminRouter.get(
  "/flags",
  requirePermission("platform.flags.manage"),
  handler(async (_req, res) => {
    res.json({ items: await db.select().from(featureFlags).orderBy(featureFlags.key) });
  }),
);

adminRouter.put(
  "/flags/:key",
  requirePermission("platform.flags.manage"),
  handler(async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const actor = req.ctx.auth!.user.id;
    const result = await db.transaction(async (tx) => {
      const r = await setFlag(tx, String(req.params.key), enabled, actor);
      if (!r) throw new HttpError(404, "NOT_FOUND", "Unknown flag.");
      await writeAudit(tx, {
        actorUserId: actor,
        action: "flag.set",
        targetType: "feature_flag",
        targetId: String(req.params.key),
        before: r.before,
        after: r.after,
        requestId: req.ctx.requestId,
        ipAddress: req.ctx.ip,
      });
      return r.after;
    });
    res.json({ flag: result });
  }),
);

/* ---------- Role security policy ---------- */

adminRouter.get(
  "/roles",
  requirePermission("platform.roles.manage"),
  handler(async (_req, res) => {
    res.json({ items: await db.select().from(roles).orderBy(roles.key) });
  }),
);

/** Require (or stop requiring) an authenticator app for everyone holding a role. */
adminRouter.put(
  "/roles/:key/mfa",
  requirePermission("platform.roles.manage"),
  handler(async (req, res) => {
    const { requiresTotp } = z.object({ requiresTotp: z.boolean() }).parse(req.body);
    const key = String(req.params.key);
    const actor = req.ctx.auth!.user.id;
    const updated = await db.transaction(async (tx) => {
      const [before] = await tx.select().from(roles).where(eq(roles.key, key));
      if (!before) throw new HttpError(404, "NOT_FOUND", "Unknown role.");
      const [after] = await tx.update(roles).set({ requiresTotp }).where(eq(roles.key, key)).returning();
      await writeAudit(tx, {
        actorUserId: actor,
        action: "role.mfa_policy",
        targetType: "role",
        targetId: key,
        before,
        after,
        requestId: req.ctx.requestId,
        ipAddress: req.ctx.ip,
      });
      return after;
    });
    res.json({ role: updated });
  }),
);

/* ---------- Users, roles, MFA reset ---------- */

adminRouter.get(
  "/users",
  requirePermission("platform.admins.manage"),
  handler(async (req, res) => {
    const { q } = z.object({ q: z.string().trim().max(100).optional() }).parse(req.query);
    const rows = await db
      .select({ id: user.id, name: user.name, email: user.email, status: user.status, createdAt: user.createdAt })
      .from(user)
      .where(q ? or(ilike(user.email, `%${q}%`), ilike(user.name, `%${q}%`)) : undefined)
      .orderBy(desc(user.createdAt))
      .limit(50);
    res.json({ items: rows });
  }),
);

const roleInput = z.object({
  role: z.enum(ROLE_KEYS),
  scopeType: z.enum(["season", "team"]).optional(),
  scopeId: z.uuid().optional(),
});

adminRouter.post(
  "/users/:id/roles",
  requirePermission("platform.admins.manage"),
  handler(async (req, res) => {
    const input = roleInput.parse(req.body);
    const targetId = String(req.params.id);
    const actor = req.ctx.auth!.user.id;
    if (input.role === "super_admin" && !req.ctx.access!.roles.includes("super_admin")) {
      throw new HttpError(403, "FORBIDDEN", "Only a Super Admin can grant Super Admin.");
    }
    const [target] = await db.select({ id: user.id }).from(user).where(eq(user.id, targetId));
    if (!target) throw new HttpError(404, "NOT_FOUND", "User not found.");
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(userRoleAssignments)
        .values({
          userId: targetId,
          roleKey: input.role,
          scopeType: input.scopeType ?? null,
          scopeId: input.scopeId ?? null,
          grantedBy: actor,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new HttpError(409, "CONFLICT", "User already has that role.");
      await writeAudit(tx, {
        actorUserId: actor,
        action: "role.grant",
        targetType: "user",
        targetId,
        after: row,
        requestId: req.ctx.requestId,
        ipAddress: req.ctx.ip,
      });
      return row;
    });
    res.status(201).json({ assignment: created });
  }),
);

adminRouter.delete(
  "/users/:id/roles/:assignmentId",
  requirePermission("platform.admins.manage"),
  handler(async (req, res) => {
    const targetId = String(req.params.id);
    const assignmentId = String(req.params.assignmentId);
    const actor = req.ctx.auth!.user.id;
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(userRoleAssignments)
        .where(
          and(
            eq(userRoleAssignments.id, assignmentId),
            eq(userRoleAssignments.userId, targetId),
            isNull(userRoleAssignments.revokedAt),
          ),
        );
      if (!row) throw new HttpError(404, "NOT_FOUND", "Role assignment not found.");
      if (row.roleKey === "super_admin") {
        const supers = await tx
          .select({ id: userRoleAssignments.id })
          .from(userRoleAssignments)
          .where(and(eq(userRoleAssignments.roleKey, "super_admin"), isNull(userRoleAssignments.revokedAt)));
        if (supers.length <= 1) throw new HttpError(409, "CONFLICT", "Can't remove the last Super Admin.");
      }
      const [after] = await tx
        .update(userRoleAssignments)
        .set({ revokedAt: new Date() })
        .where(eq(userRoleAssignments.id, row.id))
        .returning();
      await writeAudit(tx, {
        actorUserId: actor,
        action: "role.revoke",
        targetType: "user",
        targetId,
        before: row,
        after,
        requestId: req.ctx.requestId,
        ipAddress: req.ctx.ip,
      });
    });
    res.status(204).end();
  }),
);

/**
 * Reset a locked-out user's MFA: removes their authenticator app and backup
 * codes and signs them out everywhere. They re-enroll at next sign-in.
 */
adminRouter.post(
  "/users/:id/mfa-reset",
  requirePermission("platform.mfa.reset"),
  handler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body);
    const targetId = String(req.params.id);
    const actor = req.ctx.auth!.user.id;
    if (targetId === actor) throw new HttpError(409, "CONFLICT", "Ask another Super Admin to reset your own MFA.");
    await db.transaction(async (tx) => {
      const [target] = await tx
        .select({ id: user.id, twoFactorEnabled: user.twoFactorEnabled })
        .from(user)
        .where(eq(user.id, targetId));
      if (!target) throw new HttpError(404, "NOT_FOUND", "User not found.");
      await tx.delete(twoFactor).where(eq(twoFactor.userId, targetId));
      await tx.update(user).set({ twoFactorEnabled: false, updatedAt: new Date() }).where(eq(user.id, targetId));
      await tx.delete(sessionTable).where(eq(sessionTable.userId, targetId));
      await writeAudit(tx, {
        actorUserId: actor,
        action: "mfa.reset",
        targetType: "user",
        targetId,
        before: { twoFactorEnabled: target.twoFactorEnabled },
        after: { twoFactorEnabled: false },
        reason,
        requestId: req.ctx.requestId,
        ipAddress: req.ctx.ip,
      });
      await publish(tx, { name: "user.mfa_reset", aggregateType: "user", aggregateId: targetId });
    });
    res.status(204).end();
  }),
);
