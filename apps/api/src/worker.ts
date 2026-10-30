/**
 * Background worker: drains the outbox. Runs as a Cloud Run job triggered
 * every minute by Cloud Scheduler (see infra/README.md), or as a loop locally.
 *
 *   pnpm --filter @nffl/api worker          # one pass, then exit (Cloud Run job)
 *   pnpm --filter @nffl/api worker --loop   # keep polling (local dev)
 */
import { pool } from "./db/client.js";
import { logger } from "./lib/logger.js";
import { registerSubscribers } from "./modules/subscribers.js";
import { processOutbox } from "./modules/platform/outbox.js";
import { expireHolds, reconcileProcessing } from "./modules/registration/service.js";
import { refreshConnection } from "./modules/square/client.js";
import { db } from "./db/client.js";
import { squareConnection } from "./db/schema/index.js";
import { eq } from "drizzle-orm";

registerSubscribers();

/** Housekeeping each pass: release unpaid holds, keep the Square token fresh (it lasts 30 days). */
async function housekeeping() {
  const settled = await reconcileProcessing();
  if (settled) logger.info({ settled }, "settled payments that were stuck in processing");
  const expired = await expireHolds();
  if (expired) logger.info({ expired }, "released unpaid registration holds");
  const [conn] = await db
    .select({ expiresAt: squareConnection.accessTokenExpiresAt, lastRefreshedAt: squareConnection.lastRefreshedAt })
    .from(squareConnection)
    .where(eq(squareConnection.id, "default"));
  const dayMs = 24 * 3600 * 1000;
  if (conn?.expiresAt && conn.expiresAt.getTime() - Date.now() < 7 * dayMs) {
    const recentlyTried = conn.lastRefreshedAt && Date.now() - conn.lastRefreshedAt.getTime() < dayMs;
    if (!recentlyTried) await refreshConnection();
  }
}

async function drain() {
  await housekeeping().catch((err) => logger.error({ err }, "housekeeping failed"));
  let total = 0;
  for (;;) {
    const { processed, failed } = await processOutbox(50);
    total += processed;
    if (processed + failed === 0) break;
  }
  return total;
}

async function main() {
  if (process.argv.includes("--loop")) {
    for (;;) {
      await drain();
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  const n = await drain();
  logger.info({ processed: n }, "outbox drained");
}

main()
  .catch((err) => {
    logger.error({ err }, "worker failed");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
