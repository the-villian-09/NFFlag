import { createApp } from "./app.js";
import { env } from "./config.js";
import { pool } from "./db/client.js";
import { logger } from "./lib/logger.js";

const server = createApp().listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.APP_ENV }, "NFFL API listening");
});

// Cloud Run sends SIGTERM before stopping an instance.
process.on("SIGTERM", () => {
  logger.info("SIGTERM received, draining");
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
});
