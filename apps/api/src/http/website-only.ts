/**
 * Only the website may call the API.
 *
 * The website (apps/web/proxy.ts and its server-side fetches) adds a shared
 * secret header to every request it forwards, plus the visitor's IP as Vercel
 * saw it. When API_PROXY_SECRET is set:
 *   - requests without the secret get 404, except health checks, payment
 *     webhooks (signature-checked) and the scheduler's worker tick (Google token);
 *   - the visitor IP comes only from the website's header, so rate limits,
 *     the audit log and text-alert consent records use the real address.
 * Without the secret configured (local dev, tests, before rollout) requests
 * pass as before.
 */
import type { RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { env } from "../config.js";

export const PROXY_HEADER = "x-nffl-proxy";
export const CLIENT_IP_HEADER = "x-nffl-client-ip";

// Health checks, payment webhooks (signature-checked) and the scheduler's
// worker tick (Google-signed token, see modules/platform/tick.ts).
const OPEN_PATHS = [/^\/api\/v1\/health$/, /^\/api\/v1\/ready$/, /^\/api\/v1\/webhooks\//, /^\/internal\/tick$/];

function secretMatches(given: string | undefined, secret: string) {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const websiteOnly: RequestHandler = (req, res, next) => {
  const secret = env.API_PROXY_SECRET;
  const given = req.header(PROXY_HEADER);
  const claimedIp = req.header(CLIENT_IP_HEADER)?.trim();
  delete req.headers[PROXY_HEADER];
  delete req.headers[CLIENT_IP_HEADER];
  if (!secret) return next();

  if (secretMatches(given, secret)) {
    // The visitor's address as the website saw it; nothing else is trusted.
    if (claimedIp && isIP(claimedIp)) req.headers["x-forwarded-for"] = claimedIp;
    else delete req.headers["x-forwarded-for"];
    return next();
  }
  const path = req.path;
  if (OPEN_PATHS.some((p) => p.test(path))) {
    delete req.headers["x-forwarded-for"];
    return next();
  }
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found." } });
};
