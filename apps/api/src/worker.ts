/**
 * Background worker: drains the outbox. Runs as a Cloud Run job triggered
 * every minute by Cloud Scheduler (see infra/README.md), or as a loop locally.
 *
 *   pnpm --filter @nffl/api worker          # one pass, then exit (Cloud Run job)
 *   pnpm --filter @nffl/api worker --loop   # keep polling (local dev)
 */
import { pool } from "./db/client.js";
import { logger } from "./lib/logger.js";
import { errorForLog } from "./lib/log-error.js";
import { registerSubscribers } from "./modules/subscribers.js";
import { processOutbox } from "./modules/platform/outbox.js";
import { expireHolds, reconcileProcessing, retryAutoRefunds, retrySubmittingRefunds } from "./modules/registration/service.js";
import { processWaitlist } from "./modules/registration/waitlist.js";
import { reconcileApplications } from "./modules/staff/service.js";
import { refreshConnection } from "./modules/square/client.js";
import { processRefereePayouts } from "./modules/referees/service.js";
import { cleanupUnusedImages } from "./modules/content/site.js";
import { db } from "./db/client.js";
import { squareConnection } from "./db/schema/index.js";
import { eq } from "drizzle-orm";

registerSubscribers();

/** Housekeeping each pass: release unpaid holds, keep the Square token fresh (it lasts 30 days). */
async function housekeeping() {
  // Each step runs on its own, so one failing doesn't skip the rest.
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      logger.error({ step: name, err: err instanceof Error ? err.message : String(err) }, "housekeeping step failed");
    }
  };
  await step("reconcile registrations", async () => {
    const n = await reconcileProcessing();
    if (n) logger.info({ settled: n }, "settled registration payments stuck in processing");
  });
  await step("reconcile volunteer fees", async () => {
    const n = await reconcileApplications();
    if (n) logger.info({ settled: n }, "settled volunteer fee payments stuck in processing");
  });
  await step("expire holds", async () => {
    const n = await expireHolds();
    if (n) logger.info({ expired: n }, "released unpaid registration holds");
  });
  await step("waitlist", async () => {
    const wl = await processWaitlist();
    if (wl.offered || wl.expired) logger.info(wl, "waitlist offers sent / expired");
  });
  await step("refunds awaiting an answer", async () => {
    const n = await retrySubmittingRefunds();
    if (n) logger.info({ settled: n }, "settled refunds whose answer was lost");
  });
  await step("automatic refunds", async () => {
    await retryAutoRefunds();
  });
  await step("referee pay", async () => {
    const n = await processRefereePayouts();
    if (n) logger.info({ sent: n }, "sent referee payouts that were waiting");
  });
  await step("unused photos", async () => {
    const n = await cleanupUnusedImages();
    if (n) logger.info({ deleted: n }, "deleted uploaded photos nothing used");
  });
  await step("square token", async () => {
    const [conn] = await db
      .select({ expiresAt: squareConnection.accessTokenExpiresAt, lastRefreshedAt: squareConnection.lastRefreshedAt })
      .from(squareConnection)
      .where(eq(squareConnection.id, "default"));
    const dayMs = 24 * 3600 * 1000;
    if (conn?.expiresAt && conn.expiresAt.getTime() - Date.now() < 7 * dayMs) {
      const recentlyTried = conn.lastRefreshedAt && Date.now() - conn.lastRefreshedAt.getTime() < dayMs;
      if (!recentlyTried) await refreshConnection();
    }
  });
}

async function drain() {
  await housekeeping().catch((err) => logger.error({ err: errorForLog(err) }, "housekeeping failed"));
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
    logger.error({ err: errorForLog(err) }, "worker failed");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
