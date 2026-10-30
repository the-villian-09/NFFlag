/** Feature flags with a short in-process cache (flags change rarely). */
import { eq } from "drizzle-orm";
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
