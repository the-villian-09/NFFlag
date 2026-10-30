/**
 * Per-request context and guards.
 *
 * Guard order on a protected route:
 *   requireAuth → requireMfa → requirePermission(...)
 * Admin routes also get `adminIdleTimeout`.
 */
import type { Permission } from "@nffl/shared";
import { fromNodeHeaders } from "better-auth/node";
import { eq, sql } from "drizzle-orm";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { randomUUID } from "node:crypto";
import { env } from "../config.js";
import { db } from "../db/client.js";
import { session as sessionTable, sessionActivity } from "../db/schema/index.js";
import { auth, type AuthSession } from "../modules/auth/auth.js";
import { can, loadAccess, type Access, type Scope } from "../modules/platform/access.js";
import { HttpError } from "./errors.js";

export interface RequestContext {
  requestId: string;
  ip: string | null;
  auth: AuthSession | null;
  access: Access | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: RequestContext;
    }
  }
}

export const requestContext: RequestHandler = (req, res, next) => {
  const incoming = req.header("x-request-id");
  const requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader("x-request-id", requestId);
  req.ctx = { requestId, ip: req.ip ?? null, auth: null, access: null };
  next();
};

/** Loads the session (if any) and the user's access. Never rejects. */
export const loadSession: RequestHandler = async (req, _res, next) => {
  try {
    const s = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (s) {
      req.ctx.auth = s;
      req.ctx.access = await loadAccess(db, s.user.id);
    }
    next();
  } catch (err) {
    next(err);
  }
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.ctx.auth) return next(new HttpError(401, "UNAUTHENTICATED", "Please sign in."));
  // Belt and braces: sign-in already refuses unconfirmed emails.
  if (!req.ctx.auth.user.emailVerified) {
    return next(new HttpError(403, "EMAIL_NOT_VERIFIED", "Please confirm your email address first."));
  }
  next();
};

/** "none" = optional (the default for every role); "totp" = a role requires an authenticator app. */
export type MfaRequirement = "none" | "totp";

export function mfaStatus(ctx: RequestContext): {
  required: MfaRequirement;
  complete: boolean;
  enabled: boolean;
} {
  const access = ctx.access;
  const enabled = ctx.auth?.user.twoFactorEnabled === true;
  if (access?.requiresTotp) return { required: "totp", complete: enabled && access.hasVerifiedTotp, enabled };
  return { required: "none", complete: true, enabled };
}

/**
 * Two-step sign-in is optional by default. It is enforced only for users
 * holding a role an admin has set to require an authenticator app
 * (roles.requires_totp); those users must confirm one before continuing.
 */
export const requireMfa: RequestHandler = (req, _res, next) => {
  const status = mfaStatus(req.ctx);
  if (!status.complete) {
    return next(
      new HttpError(403, "MFA_ENROLLMENT_REQUIRED", "Set up two-step sign-in to continue.", { required: status.required }),
    );
  }
  next();
};

/**
 * Permission guard. `scopeOf` maps the request to a season/team scope for
 * scoped grants (e.g. a coach's own team). Omit it for league-wide checks.
 */
export function requirePermission(permission: Permission, scopeOf?: (req: Request) => Scope | undefined): RequestHandler {
  return (req, _res, next) => {
    const access = req.ctx.access;
    if (!access || !can(access, permission, scopeOf?.(req))) {
      return next(new HttpError(403, "FORBIDDEN", "You don't have permission to do that."));
    }
    next();
  };
}

/**
 * Admin portal idle timeout (default 30 min), tracked in Postgres so it holds
 * across Cloud Run instances. An idle admin session is revoked.
 */
export const adminIdleTimeout: RequestHandler = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const sessionId = req.ctx.auth?.session.id;
    if (!sessionId) return next(new HttpError(401, "UNAUTHENTICATED", "Please sign in."));
    const [row] = await db.select().from(sessionActivity).where(eq(sessionActivity.sessionId, sessionId)).limit(1);
    const idleMs = env.ADMIN_IDLE_MINUTES * 60_000;
    if (row && Date.now() - row.lastSeenAt.getTime() > idleMs) {
      await db.delete(sessionTable).where(eq(sessionTable.id, sessionId));
      return next(new HttpError(401, "SESSION_IDLE", "You were signed out after a period of inactivity."));
    }
    await db
      .insert(sessionActivity)
      .values({ sessionId, lastSeenAt: new Date() })
      .onConflictDoUpdate({ target: sessionActivity.sessionId, set: { lastSeenAt: sql`now()` } });
    next();
  } catch (err) {
    next(err);
  }
};

/** Wraps async handlers so thrown errors reach the error handler. */
export function handler(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}
