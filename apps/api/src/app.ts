/**
 * Express app. Modules mount their routers here; adding a release usually
 * means one new `app.use("/api/v1/...", router)` line.
 */
import { toNodeHandler } from "better-auth/node";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { errorHandler, HttpError } from "./http/errors.js";
import { loadSession, requestContext } from "./http/context.js";
import { logger } from "./lib/logger.js";
import { accountsRouter } from "./modules/accounts/routes.js";
import { adminRouter } from "./modules/admin/routes.js";
import { auth } from "./modules/auth/auth.js";
import { leagueRouter } from "./modules/league/routes.js";
import { platformRouter } from "./modules/platform/routes.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // Cloud Run sits behind Google's front end, and Vercel proxies in front of that.
  app.set("trust proxy", true);

  app.use(requestContext);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).ctx?.requestId ?? "",
      autoLogging: { ignore: (req) => req.url === "/api/v1/health" },
    }),
  );
  app.use(helmet());

  // Better Auth reads the raw body itself, so it mounts before express.json().
  app.all("/api/auth/{*splat}", toNodeHandler(auth));

  // Webhooks that need the raw body (Square, R1b) mount here, before express.json().

  app.use(express.json({ limit: "100kb" }));
  app.use(loadSession);

  app.use("/api/v1", platformRouter);
  app.use("/api/v1", leagueRouter);
  app.use("/api/v1", accountsRouter);
  app.use("/api/v1/admin", adminRouter);
  // R1b: app.use("/api/v1", registrationRouter); app.use("/api/v1/admin", adminRegistrationRouter);

  app.use((_req, _res, next) => next(new HttpError(404, "NOT_FOUND", "Not found.")));
  app.use(errorHandler);
  return app;
}
