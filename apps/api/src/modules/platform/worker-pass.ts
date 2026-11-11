/**
 * One pass of the background worker: housekeeping (unpaid holds, waitlist,
 * refunds, payouts, cleanup) then the outbox (queued emails and other events).
 *
 * Runs from two places, never at the same time (a Postgres advisory lock):
 *   - POST /internal/tick on the API, called every minute by Cloud Scheduler
 *     (the cheap way: the API is usually running already; see platform/tick.ts);
 *   - the nffl-worker Cloud Run job / `pnpm worker` (fallback and local dev).
 */
import { eq } from "drizzle-orm";
import { db, pool } from "../../db/client.js";
import { squareConnection } from "../../db/schema/index.js";
import { cleanupEmailQuota } from "../../lib/email-quota.js";
import { errorForLog } from "../../lib/log-error.js";
import { logger } from "../../lib/logger.js";
import { cleanupUnusedImages } from "../content/site.js";
import { expireHolds, reconcileProcessing, retryAutoRefunds, retrySubmittingRefunds } from "../registration/service.js";
import { processWaitlist } from "../registration/waitlist.js";
import { processRefereePayouts } from "../referees/service.js";
import { refreshConnection } from "../square/client.js";
import { reconcileApplications } from "../staff/service.js";
import { registerSubscribers } from "../subscribers.js";
import { processOutbox } from "./outbox.js";

/** Advisory lock id for "a worker pass is running" (any fixed number; only used here). */
const PASS_LOCK = 4_711_202_611;

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
  await step("old email counts", async () => {
    const n = await cleanupEmailQuota();
    if (n) logger.info({ removed: n }, "old email counts removed");
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

/**
 * How long one pass may keep sending queued events. A Cloud Scheduler call to
 * the API is cut off after 5 minutes, and a cut in the middle of a batch would
 * re-send that batch's emails. One minute leaves a wide margin; whatever is
 * left (a big announcement, say) carries on in the next pass a minute later.
 */
export const PASS_BUDGET_MS = 60_000;
const BATCH = 50;

async function drain(budgetMs: number) {
  const started = Date.now();
  await housekeeping().catch((err) => logger.error({ err: errorForLog(err) }, "housekeeping failed"));
  let total = 0;
  let more = false;
  for (let first = true; ; first = false) {
    // Always at least one batch, so a slow housekeeping step can't stall the queue.
    if (!first && Date.now() - started >= budgetMs) {
      more = true;
      break;
    }
    const { processed, failed } = await processOutbox(BATCH);
    total += processed;
    if (processed + failed === 0) break;
  }
  return { processed: total, more };
}

/**
 * Runs one pass unless another is already running (then returns null at once).
 * The lock is tied to one database session, so it's released even if this
 * process dies mid-pass.
 */
export async function runWorkerPass(
  budgetMs = PASS_BUDGET_MS,
): Promise<{ processed: number; more: boolean; ms: number } | null> {
  registerSubscribers();
  const started = Date.now();
  const lockClient = await pool.connect();
  try {
    const got = await lockClient.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [PASS_LOCK]);
    if (!got.rows[0]?.ok) return null;
    try {
      const r = await drain(budgetMs);
      if (r.more) logger.info({ processed: r.processed }, "worker pass hit its time limit; the rest goes next pass");
      return { ...r, ms: Date.now() - started };
    } finally {
      await lockClient.query("select pg_advisory_unlock($1)", [PASS_LOCK]);
    }
  } finally {
    lockClient.release();
  }
}
