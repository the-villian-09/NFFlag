/** Feature flags with a short in-process cache (flags change rarely). */
import type { Permission } from "@nffl/shared";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "express";
import { HttpError } from "../../http/errors.js";
import { db, type DbOrTx } from "../../db/client.js";
import { featureFlags } from "../../db/schema/index.js";

const TTL_MS = 15_000;
let cache: { at: number; flags: Map<string, boolean> } | null = null;

export async function getFlags(): Promise<Map<string, boolean>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.flags;
  const rows = await db.select({ key: featureFlags.key, enabled: featureFlags.enabled }).from(featureFlags);
  cache = { at: Date.now(), flags: new Map(rows.map((r) => [r.key, r.enabled])) };
  return cache.flags;
}

export async function isEnabled(key: string): Promise<boolean> {
  return (await getFlags()).get(key) ?? false;
}

export async function setFlag(conn: DbOrTx, key: string, enabled: boolean, actorUserId: string) {
  const [before] = await conn.select().from(featureFlags).where(eq(featureFlags.key, key));
  if (!before) return null;
  const [after] = await conn
    .update(featureFlags)
    .set({ enabled, updatedBy: actorUserId, updatedAt: new Date() })
    .where(eq(featureFlags.key, key))
    .returning();
  cache = null;
  return { before, after };
}

export function resetFlagCache() {
  cache = null;
}

/** Release switches checked by the R3/R4 features. */
export const FLAG = {
  teams: "r3.teams_draft",
  practices: "r3.practices",
  games: "r4.games",
  announcements: "r4.announcements",
} as const;

/**
 * Blocks a route while its release switch is off. Admins holding `adminPermission`
 * league-wide get through anyway, so they can set things up and test first.
 */
export function requireFlag(key: string, adminPermission?: Permission): RequestHandler {
  return async (req, _res, next) => {
    try {
      if (await isEnabled(key)) return next();
      if (adminPermission && req.ctx.access?.leagueWide.has(adminPermission)) return next();
      next(new HttpError(403, "FEATURE_DISABLED", "This isn't turned on yet."));
    } catch (err) {
      next(err);
    }
  };
}
