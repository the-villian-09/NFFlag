/**
 * POST /internal/tick — Cloud Scheduler's once-a-minute call that runs the
 * background worker inside the API (Nov 11: replaces starting a Cloud Run job
 * every minute, which billed ~25 s of start-up for ~1 s of work).
 *
 * Who may call it: only a request carrying a Google-signed ID token
 *   - issued by Google (accounts.google.com),
 *   - for our audience (WORKER_TICK_AUDIENCE, the API's own URL),
 *   - for the scheduler's service account (WORKER_TICK_SA), email verified.
 * Anything else gets 401; with nothing configured the endpoint is 404.
 * It isn't under /api, so the website never forwards it.
 *
 * The pass finishes before we answer: on request-based billing Cloud Run
 * slows the CPU right down once the response is sent.
 */
import { Router } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { env } from "../../config.js";
import { handler } from "../../http/context.js";
import { errorForLog } from "../../lib/log-error.js";
import { logger } from "../../lib/logger.js";
import { runWorkerPass } from "./worker-pass.js";

export const TICK_PATH = "/internal/tick";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

let googleKeys: JWTVerifyGetKey = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

/** Tests swap in their own signing keys. */
export function setTickKeys(keys: JWTVerifyGetKey) {
  googleKeys = keys;
}

export async function isSchedulerToken(authHeader: string | undefined, sa = env.WORKER_TICK_SA, audience = env.WORKER_TICK_AUDIENCE) {
  if (!sa || !audience) return false;
  const m = authHeader?.match(/^Bearer ([A-Za-z0-9._-]+)$/);
  if (!m) return false;
  try {
    const { payload } = await jwtVerify(m[1]!, googleKeys, { issuer: GOOGLE_ISSUERS, audience, algorithms: ["RS256"] });
    return payload.email === sa && payload.email_verified === true;
  } catch {
    return false;
  }
}

export const tickRouter = Router();

tickRouter.post(
  TICK_PATH,
  handler(async (req, res) => {
    if (!env.WORKER_TICK_SA || !env.WORKER_TICK_AUDIENCE) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found." } });
      return;
    }
    if (!(await isSchedulerToken(req.header("authorization")))) {
      logger.warn("worker tick refused: not the scheduler");
      res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Not allowed." } });
      return;
    }
    try {
      const r = await runWorkerPass();
      if (!r) {
        res.json({ ok: true, skipped: "another pass is running" });
        return;
      }
      logger.info(r, "worker tick done");
      res.json({ ok: true, ...r });
    } catch (err) {
      logger.error({ err: errorForLog(err) }, "worker tick failed");
      // 500 so Cloud Scheduler records the failure.
      res.status(500).json({ error: { code: "INTERNAL", message: "Worker pass failed." } });
    }
  }),
);
