/**
 * Cloudflare Turnstile — the invisible "are you human" check (Nov 10 hardening).
 *
 * The website renders an invisible widget on the sign-up, forgot-password,
 * resend-confirmation and contact forms and sends its one-time token in the
 * `x-captcha-response` header. Better Auth's captcha plugin checks it for the
 * auth endpoints (see AUTH_CAPTCHA_ENDPOINTS); `checkTurnstile` checks it for
 * our own routes (the contact form).
 *
 * Off when TURNSTILE_SECRET_KEY isn't set (local dev and tests).
 */
import type { Request } from "express";
import type { ErrorCode } from "../http/errors.js";
import { env } from "../config.js";
import { logger } from "./logger.js";

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Auth endpoints anyone can call that send an email to the address they type. */
export const AUTH_CAPTCHA_ENDPOINTS = ["/sign-up/email", "/request-password-reset", "/send-verification-email"];

/** Tokens are only accepted when solved on our own site (not a copy of the widget elsewhere). */
export function allowedHostnames(baseUrl = env.APP_BASE_URL) {
  return [new URL(baseUrl).hostname];
}

export function turnstileEnabled() {
  return Boolean(env.TURNSTILE_SECRET_KEY);
}

export type TurnstileResult = "ok" | "missing" | "failed" | "unavailable";

/**
 * Asks Cloudflare whether a token is good. Fails closed: if Cloudflare can't
 * be reached in 10 seconds, the request is refused ("unavailable").
 */
export async function verifyTurnstile(
  token: string | undefined,
  remoteIp: string | undefined,
  secret = env.TURNSTILE_SECRET_KEY,
): Promise<TurnstileResult> {
  if (!secret) return "ok";
  if (!token || token.length > 2048) return "missing";
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { success?: boolean; hostname?: string; "error-codes"?: string[] };
    if (!data.success) {
      logger.warn({ reason: "rejected", errorCodes: data["error-codes"] ?? [] }, "turnstile check failed");
      return "failed";
    }
    if (!data.hostname || !allowedHostnames().includes(data.hostname)) {
      logger.warn({ reason: "hostname", hostname: data.hostname }, "turnstile check failed");
      return "failed";
    }
    return "ok";
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "turnstile unavailable");
    return "unavailable";
  }
}

/** For Express routes: the token from the header, checked against the visitor's IP. */
export function checkTurnstile(req: Request) {
  const header = req.get("x-captcha-response");
  return verifyTurnstile(header, req.ctx?.ip ?? undefined);
}

export const TURNSTILE_MESSAGES: Record<Exclude<TurnstileResult, "ok">, { status: number; code: ErrorCode; message: string }> = {
  missing: { status: 400, code: "MISSING_RESPONSE", message: "Please wait a moment for the security check, then try again." },
  failed: { status: 403, code: "VERIFICATION_FAILED", message: "The security check didn't pass. Refresh the page and try again." },
  unavailable: { status: 503, code: "CAPTCHA_UNAVAILABLE", message: "The security check isn't answering right now. Please try again in a minute." },
};
