/**
 * Background worker as a command: one pass, then exit. Kept as the Cloud Run
 * job nffl-worker (a fallback; normally Cloud Scheduler calls the API's
 * POST /internal/tick instead, see modules/platform/tick.ts) and for local dev.
 *
 *   pnpm --filter @nffl/api worker          # one pass, then exit
 *   pnpm --filter @nffl/api worker --loop   # keep polling (local dev)
 */
import { pool } from "./db/client.js";
import { errorForLog } from "./lib/log-error.js";
import { logger } from "./lib/logger.js";
import { runWorkerPass } from "./modules/platform/worker-pass.js";

async function main() {
  if (process.argv.includes("--loop")) {
    for (;;) {
      await runWorkerPass();
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  const r = await runWorkerPass();
  if (r) logger.info(r, "outbox drained");
  else logger.info("another worker pass is running; skipped");
}

main()
  .catch((err) => {
    logger.error({ err: errorForLog(err) }, "worker failed");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
