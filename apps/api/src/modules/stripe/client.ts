/**
 * Thin Stripe REST client (no SDK): PaymentIntents confirmed on the server from
 * a ConfirmationToken made by the Payment Element, refunds and webhook
 * signatures. Card details never reach our servers.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config.js";

const BASE = "https://api.stripe.com";
/** Pinned so Stripe's response shapes don't change under us. */
export const STRIPE_VERSION = "2025-03-31.basil";

export const stripeWebhookUrl = () => `${env.APP_BASE_URL.replace(/\/$/, "")}/api/v1/webhooks/stripe`;

export function stripeConfigured() {
  return !!(env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY);
}

/** "test" or "live", from the key itself (sk_test_ / rk_test_ vs sk_live_ / rk_live_). */
export function stripeEnvironment(): "test" | "live" {
  return /_live_/.test(env.STRIPE_SECRET_KEY ?? "") ? "live" : "test";
}

export class StripeError extends Error {
  constructor(
    public status: number,
    public type: string,
    public code: string | undefined,
    public declineCode: string | undefined,
    message: string,
  ) {
    super(message || `Stripe request failed (${status})`);
  }
}

/** Stripe's form encoding: nested objects as a[b]=c, arrays as a[0]=c. */
export function formEncode(params: Record<string, unknown>, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" ? formEncode(item as Record<string, unknown>, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === "object") formEncode(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function call<T>(method: "GET" | "POST", path: string, params?: Record<string, unknown>, idempotencyKey?: string) {
  const body = params ? formEncode(params).toString() : "";
  const url = method === "GET" && body ? `${BASE}${path}?${body}` : `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${(env.STRIPE_SECRET_KEY ?? "").trim()}`,
      "stripe-version": STRIPE_VERSION,
      ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: method === "POST" ? body : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    const e = (data.error ?? {}) as { type?: string; code?: string; decline_code?: string; message?: string };
    throw new StripeError(res.status, e.type ?? "api_error", e.code, e.decline_code, e.message ?? "");
  }
  return { data: data as T, replayed: res.headers.get("idempotent-replayed") === "true" };
}

/* ---------------- payment intents ---------------- */

export interface StripeCharge {
  id: string;
  receipt_url?: string | null;
  payment_method_details?: { card?: { brand?: string; last4?: string } } | null;
}

export interface PaymentIntent {
  id: string;
  /** requires_payment_method | requires_confirmation | requires_action | processing | requires_capture | canceled | succeeded */
  status: string;
  amount: number;
  created: number;
  client_secret?: string | null;
  metadata?: Record<string, string>;
  latest_charge?: StripeCharge | string | null;
  last_payment_error?: { code?: string; decline_code?: string; message?: string } | null;
}

const EXPAND = ["latest_charge"];

/**
 * Creates and confirms a card PaymentIntent. Re-sending the same idempotency key
 * returns the original response (possibly stale), so a replay is re-read fresh.
 */
export async function createConfirmedIntent(p: {
  confirmationToken: string;
  amountCents: number;
  reference: string;
  description: string;
  idempotencyKey: string;
}) {
  const r = await call<PaymentIntent>(
    "POST",
    "/v1/payment_intents",
    {
      amount: p.amountCents,
      currency: "usd",
      confirm: true,
      confirmation_token: p.confirmationToken,
      payment_method_types: ["card"],
      // Lets Stripe.js finish a bank check (3-D Secure) in the browser.
      use_stripe_sdk: true,
      description: p.description.slice(0, 500),
      metadata: { reference: p.reference },
      expand: EXPAND,
    },
    p.idempotencyKey,
  );
  return r.replayed ? retrieveIntent(r.data.id) : r.data;
}

export async function retrieveIntent(id: string) {
  return (await call<PaymentIntent>("GET", `/v1/payment_intents/${encodeURIComponent(id)}`, { expand: EXPAND })).data;
}

export async function cancelIntent(id: string) {
  return (await call<PaymentIntent>("POST", `/v1/payment_intents/${encodeURIComponent(id)}/cancel`, { expand: EXPAND })).data;
}

/* ---------------- refunds ---------------- */

export interface StripeRefund {
  id: string;
  /** pending | requires_action | succeeded | failed | canceled */
  status: string;
  amount: number;
  payment_intent?: string | null;
}

export async function createRefund(p: { paymentIntentId: string; amountCents: number; note: string; idempotencyKey: string }) {
  return (
    await call<StripeRefund>(
      "POST",
      "/v1/refunds",
      { payment_intent: p.paymentIntentId, amount: p.amountCents, metadata: { note: p.note.slice(0, 450) } },
      p.idempotencyKey,
    )
  ).data;
}

/** Our refund statuses (shared with Square): PENDING | COMPLETED | FAILED | REJECTED. */
export function refundStatus(s: string) {
  if (s === "succeeded") return "COMPLETED";
  if (s === "failed") return "FAILED";
  if (s === "canceled") return "REJECTED";
  return "PENDING";
}

/* ---------------- webhooks ---------------- */

/**
 * Stripe-Signature: t=<unix>,v1=<hex hmac of "t.rawBody">. Rejects stale
 * signatures (5 minutes) so a captured event can't be replayed later.
 */
export function verifyStripeSignature(rawBody: string, header: string | undefined, now = Date.now()): boolean {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(now / 1000 - Number(t)) > 300) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
  return sigs.some((s) => {
    const b = Buffer.from(s);
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
}

/* ---------------- messages ---------------- */

/** A decline the cardholder can fix, as opposed to a problem with our Stripe setup. */
export function isCardProblem(err: StripeError) {
  return err.type === "card_error" || err.status === 402;
}

/** Plain-English message for a card error the family can act on. */
export function friendlyStripeError(code?: string, declineCode?: string): string {
  switch (declineCode ?? code) {
    case "insufficient_funds":
      return "The card was declined for insufficient funds.";
    case "incorrect_cvc":
    case "invalid_cvc":
      return "The security code (CVC) didn't match. Please check it and try again.";
    case "incorrect_zip":
      return "The billing ZIP code didn't match your card. Please check it and try again.";
    case "expired_card":
    case "invalid_expiry_month":
    case "invalid_expiry_year":
      return "The card's expiration date is invalid or the card has expired.";
    case "incorrect_number":
    case "invalid_number":
      return "The card number isn't valid. Please check it and try again.";
    case "authentication_required":
    case "payment_intent_authentication_failure":
      return "Your bank's verification wasn't completed, so no payment was taken. Please try again.";
    case "card_declined":
    case "generic_decline":
    case "do_not_honor":
    case "call_issuer":
      return "Your card was declined. Please try another card or contact your bank.";
    default:
      return "The payment didn't go through. Please check your card details and try again.";
  }
}

/* ---------------- Connect: referee accounts and pay ---------------- */

export interface ConnectedAccount {
  id: string;
  details_submitted?: boolean;
  payouts_enabled?: boolean;
  capabilities?: { transfers?: string };
  requirements?: { currently_due?: string[]; past_due?: string[]; disabled_reason?: string | null };
}

/**
 * A connected account for a referee. The league (platform) is responsible for
 * fees, losses and keeping their details current (as in the platform profile), and the referee manages everything through Stripe's
 * embedded components on our site (no Stripe dashboard of their own).
 */
export async function createConnectedAccount(p: { email: string; userId: string; idempotencyKey: string }) {
  return (
    await call<ConnectedAccount>(
      "POST",
      "/v1/accounts",
      {
        country: "US",
        email: p.email,
        business_type: "individual",
        controller: {
          fees: { payer: "application" },
          losses: { payments: "application" },
          stripe_dashboard: { type: "none" },
          requirement_collection: "application",
        },
        capabilities: { transfers: { requested: true } },
        business_profile: { mcc: "7941", product_description: "Youth flag football referee paid by the North Florida Flag League" },
        metadata: { user_id: p.userId },
      },
      p.idempotencyKey,
    )
  ).data;
}

export async function retrieveAccount(id: string) {
  return (await call<ConnectedAccount>("GET", `/v1/accounts/${encodeURIComponent(id)}`)).data;
}

/** Short-lived secret for Stripe's embedded components (onboarding, payouts, tax forms). */
export async function createAccountSession(accountId: string) {
  return (
    await call<{ client_secret: string }>("POST", "/v1/account_sessions", {
      account: accountId,
      components: {
        account_onboarding: { enabled: true, features: { external_account_collection: true } },
        account_management: { enabled: true, features: { external_account_collection: true } },
        notification_banner: { enabled: true, features: { external_account_collection: true } },
        payouts: { enabled: true, features: { instant_payouts: true, standard_payouts: true, edit_payout_schedule: false, external_account_collection: true } },
        documents: { enabled: true },
      },
    })
  ).data.client_secret;
}

export interface StripeTransfer {
  id: string;
  amount: number;
  destination: string;
}

/**
 * Moves money from the league's Stripe balance into a referee's account.
 * `transferGroup` is our payout id, so a transfer whose response was lost can
 * be found again (findTransfer) before anything is re-sent.
 */
export async function createTransfer(p: {
  amountCents: number;
  destination: string;
  description: string;
  idempotencyKey: string;
  transferGroup: string;
  sourceType?: "card" | "bank_account";
  metadata: Record<string, string>;
}) {
  return (
    await call<StripeTransfer>(
      "POST",
      "/v1/transfers",
      {
        amount: p.amountCents,
        currency: "usd",
        destination: p.destination,
        description: p.description.slice(0, 500),
        transfer_group: p.transferGroup,
        source_type: p.sourceType,
        metadata: p.metadata,
      },
      p.idempotencyKey,
    )
  ).data;
}

/** A transfer already made for this payout (looked up by transfer group), if any. */
export async function findTransfer(transferGroup: string) {
  const r = (await call<{ data: StripeTransfer[] }>("GET", "/v1/transfers", { transfer_group: transferGroup, limit: 3 })).data;
  return r.data[0] ?? null;
}

/**
 * The league's Stripe balance in cents: available now (in total and by where
 * the money came from: card payments vs. bank top-ups), and still settling.
 */
export async function retrieveBalance() {
  type Part = { amount: number; currency: string; source_types?: Record<string, number> };
  const b = (await call<{ available: Part[]; pending: Part[] }>("GET", "/v1/balance")).data;
  const usd = (l: Part[]) => l.filter((x) => x.currency === "usd");
  const sum = (l: Part[]) => usd(l).reduce((n, x) => n + x.amount, 0);
  const source = (k: string) => usd(b.available).reduce((n, x) => n + (x.source_types?.[k] ?? 0), 0);
  return { availableCents: sum(b.available), pendingCents: sum(b.pending), availableBySource: { card: source("card"), bank_account: source("bank_account") } };
}

/** Pulls money from the league's verified bank account into its Stripe balance (takes a few business days). */
export async function createTopup(p: { amountCents: number; idempotencyKey: string }) {
  return (
    await call<{ id: string; status: string; amount: number; expected_availability_date?: number | null }>(
      "POST",
      "/v1/topups",
      { amount: p.amountCents, currency: "usd", description: "Referee pay", statement_descriptor: "NFFL REF PAY" },
      p.idempotencyKey,
    )
  ).data;
}
