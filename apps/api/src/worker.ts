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

registerSubscribers();

async function drain() {
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
