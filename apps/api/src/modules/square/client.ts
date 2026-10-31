/**
 * Thin Square REST client (no SDK): payments, refunds, OAuth and webhook
 * signatures. Everything else in the app goes through `getCredentials()`, which
 * picks the account to charge:
 *   1. the account a Super Admin connected through OAuth (production, and
 *      optionally Sandbox test accounts on staging), else
 *   2. Sandbox only: the developer app's Sandbox access token + location.
 */
import { eq } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config.js";
import { db } from "../../db/client.js";
import { squareConnection } from "../../db/schema/index.js";
import { decryptSecret, encryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";

export const SQUARE_VERSION = "2026-01-22";
export const OAUTH_SCOPES = ["PAYMENTS_WRITE", "PAYMENTS_READ", "MERCHANT_PROFILE_READ"];

export const squareBaseUrl = () =>
  env.SQUARE_ENVIRONMENT === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";

export const oauthRedirectUrl = () => `${env.APP_BASE_URL.replace(/\/$/, "")}/api/v1/square/oauth/callback`;
export const webhookUrl = () => `${env.APP_BASE_URL.replace(/\/$/, "")}/api/v1/webhooks/square`;

export class SquareError extends Error {
  constructor(
    public status: number,
    public errors: { code?: string; detail?: string; category?: string; field?: string }[],
  ) {
    super(errors.map((e) => e.detail ?? e.code).join("; ") || `Square request failed (${status})`);
  }
  get code() {
    return this.errors[0]?.code;
  }
}

async function call<T>(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> }) {
  const res = await fetch(`${squareBaseUrl()}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "square-version": SQUARE_VERSION,
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    // Don't hang a request (or Cloud Run's request timeout) on a slow Square.
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    const errors = (data.errors as SquareError["errors"]) ?? [
      { code: String(data.type ?? data.error ?? "ERROR"), detail: String(data.message ?? data.error_description ?? "") },
    ];
    throw new SquareError(res.status, errors);
  }
  return data as T;
}

/* ---------------- credentials ---------------- */

export interface SquareCredentials {
  environment: "sandbox" | "production";
  accessToken: string;
  locationId: string;
  merchantId: string | null;
  source: "oauth" | "sandbox_token";
}

/** Refresh an OAuth access token when it is within this window of expiring (they last 30 days). */
const REFRESH_WITHIN_MS = 7 * 24 * 3600 * 1000;

export async function getCredentials(): Promise<SquareCredentials | null> {
  const [conn] = await db.select().from(squareConnection).where(eq(squareConnection.id, "default"));
  if (conn && conn.environment === env.SQUARE_ENVIRONMENT && conn.locationId) {
    let accessToken = decryptSecret(conn.accessTokenEnc);
    const recentlyTried = conn.lastRefreshedAt && Date.now() - conn.lastRefreshedAt.getTime() < 3600_000;
    if (!recentlyTried && conn.accessTokenExpiresAt && conn.accessTokenExpiresAt.getTime() - Date.now() < REFRESH_WITHIN_MS) {
      accessToken = (await refreshConnection()) ?? accessToken;
    }
    return {
      environment: env.SQUARE_ENVIRONMENT,
      accessToken,
      locationId: conn.locationId,
      merchantId: conn.merchantId,
      source: "oauth",
    };
  }
  if (env.SQUARE_ENVIRONMENT === "sandbox" && env.SQUARE_ACCESS_TOKEN && env.SQUARE_LOCATION_ID) {
    return {
      environment: "sandbox",
      accessToken: env.SQUARE_ACCESS_TOKEN.trim(),
      locationId: env.SQUARE_LOCATION_ID.trim(),
      merchantId: null,
      source: "sandbox_token",
    };
  }
  return null;
}

/** Refreshes the stored OAuth token. Returns the new access token, or null on failure (recorded on the row). */
export async function refreshConnection(): Promise<string | null> {
  const [conn] = await db.select().from(squareConnection).where(eq(squareConnection.id, "default"));
  if (!conn?.refreshTokenEnc || !env.SQUARE_APPLICATION_ID || !env.SQUARE_APPLICATION_SECRET) return null;
  try {
    const t = await call<TokenResponse>("POST", "/oauth2/token", {
      body: {
        client_id: env.SQUARE_APPLICATION_ID,
        client_secret: env.SQUARE_APPLICATION_SECRET,
        grant_type: "refresh_token",
        refresh_token: decryptSecret(conn.refreshTokenEnc),
      },
    });
    await db
      .update(squareConnection)
      .set({
        accessTokenEnc: encryptSecret(t.access_token),
        ...(t.refresh_token ? { refreshTokenEnc: encryptSecret(t.refresh_token) } : {}),
        accessTokenExpiresAt: t.expires_at ? new Date(t.expires_at) : null,
        lastRefreshedAt: new Date(),
        lastRefreshError: null,
      })
      .where(eq(squareConnection.id, "default"));
    return t.access_token;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Square token refresh failed");
    await db
      .update(squareConnection)
      .set({ lastRefreshError: message, lastRefreshedAt: new Date() })
      .where(eq(squareConnection.id, "default"));
    return null;
  }
}

/* ---------------- OAuth ---------------- */

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  merchant_id: string;
  token_type?: string;
}

export function oauthConfigured() {
  return !!(env.SQUARE_APPLICATION_ID && env.SQUARE_APPLICATION_SECRET);
}

export function authorizeUrl(state: string) {
  const q = new URLSearchParams({
    client_id: env.SQUARE_APPLICATION_ID ?? "",
    scope: OAUTH_SCOPES.join(" "),
    session: "false",
    state,
    redirect_uri: oauthRedirectUrl(),
  });
  return `${squareBaseUrl()}/oauth2/authorize?${q.toString()}`;
}

export function exchangeCode(code: string) {
  return call<TokenResponse>("POST", "/oauth2/token", {
    body: {
      client_id: env.SQUARE_APPLICATION_ID,
      client_secret: env.SQUARE_APPLICATION_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: oauthRedirectUrl(),
    },
  });
}

/** Revokes every token the app holds for the merchant (Square's side of "Disconnect"). */
export function revokeMerchant(merchantId: string) {
  return call<{ success: boolean }>("POST", "/oauth2/revoke", {
    headers: { authorization: `Client ${env.SQUARE_APPLICATION_SECRET ?? ""}` },
    body: { client_id: env.SQUARE_APPLICATION_ID, merchant_id: merchantId },
  });
}

export async function getMerchantAndMainLocation(token: string) {
  const [m, l] = await Promise.all([
    call<{ merchant?: { business_name?: string } }>("GET", "/v2/merchants/me", { token }),
    call<{ location?: { id: string; name?: string; status?: string } }>("GET", "/v2/locations/main", { token }),
  ]);
  return { merchantName: m.merchant?.business_name ?? null, locationId: l.location?.id ?? null, locationName: l.location?.name ?? null };
}

/* ---------------- payments ---------------- */

export interface SquarePayment {
  id: string;
  status: string;
  created_at?: string;
  amount_money?: { amount: number; currency: string };
  reference_id?: string;
  receipt_url?: string;
  location_id?: string;
  card_details?: { card?: { card_brand?: string; last_4?: string } };
}

export async function createPayment(
  creds: SquareCredentials,
  p: { sourceId: string; verificationToken?: string; idempotencyKey: string; amountCents: number; referenceId: string; note: string; buyerEmail?: string },
) {
  const r = await call<{ payment: SquarePayment }>("POST", "/v2/payments", {
    token: creds.accessToken,
    body: {
      source_id: p.sourceId,
      verification_token: p.verificationToken,
      idempotency_key: p.idempotencyKey,
      amount_money: { amount: p.amountCents, currency: "USD" },
      location_id: creds.locationId,
      reference_id: p.referenceId,
      note: p.note.slice(0, 500),
      buyer_email_address: p.buyerEmail,
      autocomplete: true,
    },
  });
  return r.payment;
}

export async function refundPayment(
  creds: SquareCredentials,
  p: { paymentId: string; amountCents: number; idempotencyKey: string; reason: string },
) {
  const r = await call<{ refund: { id: string; status: string } }>("POST", "/v2/refunds", {
    token: creds.accessToken,
    body: {
      idempotency_key: p.idempotencyKey,
      payment_id: p.paymentId,
      amount_money: { amount: p.amountCents, currency: "USD" },
      reason: p.reason.slice(0, 192),
    },
  });
  return r.refund;
}

/* ---------------- webhooks ---------------- */

/** Square signs `notificationUrl + rawBody` with HMAC-SHA256 (base64). */
export function verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
  const key = env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  if (!key || !signature) return false;
  const expected = createHmac("sha256", key).update(webhookUrl() + rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Plain-English message for a card error the family can act on. */
export function friendlyPaymentError(err: unknown): string {
  if (!(err instanceof SquareError)) return "We couldn't reach the payment processor. Please try again in a minute.";
  switch (err.code) {
    case "CARD_DECLINED":
    case "GENERIC_DECLINE":
    case "CARD_DECLINED_CALL_ISSUER":
      return "Your card was declined. Please try another card or contact your bank.";
    case "CVV_FAILURE":
    case "VERIFY_CVV_FAILURE":
      return "The security code (CVV) didn't match. Please check it and try again.";
    case "ADDRESS_VERIFICATION_FAILURE":
    case "VERIFY_AVS_FAILURE":
    case "INVALID_POSTAL_CODE":
      return "The billing ZIP code didn't match your card. Please check it and try again.";
    case "INVALID_EXPIRATION":
    case "CARD_EXPIRED":
      return "The card's expiration date is invalid or the card has expired.";
    case "INSUFFICIENT_FUNDS":
      return "The card was declined for insufficient funds.";
    case "INVALID_CARD":
    case "INVALID_CARD_DATA":
    case "INVALID_ACCOUNT":
      return "The card number isn't valid. Please check it and try again.";
    default:
      return "The payment didn't go through. Please check your card details and try again.";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Our Square reference_id: a registration id, or "app:" + an application id. Anything else isn't ours. */
export function parseReference(ref: string | undefined): { registrationId: string } | { applicationId: string } | null {
  if (!ref) return null;
  if (ref.startsWith("app:")) return UUID.test(ref.slice(4)) ? { applicationId: ref.slice(4) } : null;
  return UUID.test(ref) ? { registrationId: ref } : null;
}
