/**
 * One way to take and refund card payments, whichever provider is behind it.
 * Stripe is the main provider; Square is the backup a Super Admin can switch
 * to (Admin → Payments). A payment is always refunded through the provider
 * that took it, whatever the current setting.
 */
import { env } from "../../config.js";
import { getPaymentSettings } from "../registration/settings.js";
import {
  createPayment,
  friendlyPaymentError,
  getCredentials,
  refundPayment,
  SquareError,
  type SquarePayment,
} from "../square/client.js";
import {
  cancelIntent,
  createConfirmedIntent,
  createRefund,
  friendlyStripeError,
  isCardProblem,
  refundStatus,
  retrieveIntent,
  stripeConfigured,
  stripeEnvironment,
  StripeError,
  type PaymentIntent,
} from "../stripe/client.js";

export type Provider = "stripe" | "square";
export const PROVIDERS = ["stripe", "square"] as const;

/** A card payment as the rest of the app sees it. */
export interface GatewayPayment {
  provider: Provider;
  /** Stripe: test | live. Square: sandbox | production. */
  environment: string;
  merchantId: string | null;
  id: string;
  /** COMPLETED | APPROVED | PENDING | ACTION_REQUIRED | FAILED | CANCELED */
  status: string;
  createdAt?: Date;
  amountCents?: number;
  /** Registration id, or "app:" + application id. */
  referenceId?: string;
  receiptUrl?: string | null;
  locationId?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  /** Stripe: finishes a bank check (3-D Secure) in the browser. */
  clientSecret?: string | null;
  /** Why it failed, in words the cardholder can act on. */
  failureMessage?: string;
}

/** What was sent to the provider, kept until the outcome is known so it can be asked again. */
export interface PaymentRequest {
  /** Missing on requests saved before Stripe was added: those were Square. */
  provider?: Provider;
  idempotencyKey: string;
  /** Square: card nonce. Stripe: ConfirmationToken id (ctoken_…). */
  sourceId: string;
  verificationToken?: string;
  amountCents: number;
  note: string;
  buyerEmail?: string;
  /** Stripe: the PaymentIntent, once created, so it's read back instead of re-sent. */
  intentId?: string;
}

/** The card was declined or its details are wrong: the cardholder can fix it. */
export class CardDeclinedError extends Error {}
/** Our setup (keys, account) or request is wrong: not the cardholder's card. */
export class GatewaySetupError extends Error {}
/** The provider isn't set up on this server. */
export class GatewayUnavailableError extends Error {}

/**
 * Stripe when chosen and its keys are on this server. A server without Stripe
 * keys yet (e.g. production before go-live) keeps taking payments with Square.
 */
export async function activeProvider(): Promise<Provider> {
  const chosen = (await getPaymentSettings()).provider;
  return chosen === "stripe" && !stripeConfigured() ? "square" : chosen;
}

export type CheckoutConfig =
  | { provider: "stripe"; publishableKey: string; environment: "test" | "live" }
  | { provider: "square"; applicationId: string; locationId: string; environment: "sandbox" | "production" };

/** Public values for the card form. null = online payment unavailable right now. */
export async function checkoutConfig(): Promise<CheckoutConfig | null> {
  if ((await activeProvider()) === "stripe") {
    return stripeConfigured() ? { provider: "stripe", publishableKey: env.STRIPE_PUBLISHABLE_KEY!.trim(), environment: stripeEnvironment() } : null;
  }
  const creds = await getCredentials().catch(() => null);
  return creds && env.SQUARE_APPLICATION_ID
    ? { provider: "square", applicationId: env.SQUARE_APPLICATION_ID, locationId: creds.locationId, environment: creds.environment }
    : null;
}

/* ---------------- conversions ---------------- */

export function fromSquare(p: SquarePayment, source: { environment: string; merchantId: string | null }): GatewayPayment {
  return {
    provider: "square",
    environment: source.environment,
    merchantId: source.merchantId,
    id: p.id,
    status: p.status,
    createdAt: p.created_at ? new Date(p.created_at) : undefined,
    amountCents: p.amount_money?.amount,
    referenceId: p.reference_id,
    receiptUrl: p.receipt_url ?? null,
    locationId: p.location_id ?? null,
    cardBrand: p.card_details?.card?.card_brand ?? null,
    cardLast4: p.card_details?.card?.last_4 ?? null,
  };
}

export function stripeStatus(s: string) {
  switch (s) {
    case "succeeded":
      return "COMPLETED";
    case "requires_action":
      return "ACTION_REQUIRED";
    case "canceled":
      return "CANCELED";
    // A confirmed intent that's back to needing a card: the attempt failed.
    case "requires_payment_method":
      return "FAILED";
    default:
      return "PENDING";
  }
}

export function fromStripe(pi: PaymentIntent): GatewayPayment {
  const charge = pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  const card = charge?.payment_method_details?.card;
  const err = pi.last_payment_error;
  return {
    provider: "stripe",
    environment: stripeEnvironment(),
    merchantId: null,
    id: pi.id,
    status: stripeStatus(pi.status),
    createdAt: new Date(pi.created * 1000),
    amountCents: pi.amount,
    referenceId: pi.metadata?.reference,
    receiptUrl: charge?.receipt_url ?? null,
    locationId: null,
    cardBrand: card?.brand ? card.brand.toUpperCase() : null,
    cardLast4: card?.last4 ?? null,
    clientSecret: pi.client_secret ?? null,
    failureMessage: err ? friendlyStripeError(err.code, err.decline_code) : undefined,
  };
}

/* ---------------- charge ---------------- */

/**
 * Charges (or, with the same request, asks again about) a card payment.
 * `onIntent` saves a new Stripe PaymentIntent id with the request.
 * Throws CardDeclinedError, GatewaySetupError or GatewayUnavailableError;
 * anything else means the outcome is unknown.
 */
export async function chargeCard(request: PaymentRequest, reference: string, onIntent?: (intentId: string) => Promise<void>): Promise<GatewayPayment> {
  if ((request.provider ?? "square") === "stripe") {
    if (!stripeConfigured()) throw new GatewayUnavailableError("Stripe isn't set up.");
    let pi: PaymentIntent;
    try {
      pi = request.intentId
        ? await retrieveIntent(request.intentId)
        : await createConfirmedIntent({
            confirmationToken: request.sourceId,
            amountCents: request.amountCents,
            reference,
            description: request.note,
            idempotencyKey: request.idempotencyKey,
          });
    } catch (err) {
      if (err instanceof StripeError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        if (isCardProblem(err)) throw new CardDeclinedError(friendlyStripeError(err.code, err.declineCode));
        throw new GatewaySetupError(`${err.type}${err.code ? `/${err.code}` : ""}: ${err.message}`);
      }
      throw err;
    }
    if (!request.intentId && onIntent) await onIntent(pi.id);
    return fromStripe(pi);
  }

  const creds = await getCredentials().catch(() => null);
  if (!creds) throw new GatewayUnavailableError("Square isn't connected.");
  try {
    const p = await createPayment(creds, { ...request, referenceId: reference });
    return fromSquare(p, { environment: creds.environment, merchantId: creds.merchantId });
  } catch (err) {
    if (err instanceof SquareError && err.status >= 400 && err.status < 500) {
      if (err.errors.some((e) => e.category === "PAYMENT_METHOD_ERROR") || err.status === 402) {
        throw new CardDeclinedError(friendlyPaymentError(err));
      }
      throw new GatewaySetupError(JSON.stringify(err.errors.map((e) => ({ code: e.code, category: e.category, field: e.field, detail: e.detail }))));
    }
    throw err;
  }
}

/**
 * The cardholder left the bank check unfinished: cancel the Stripe intent so it
 * can't complete later. If it completed meanwhile, that result is returned.
 */
export async function abandonAction(payment: GatewayPayment): Promise<GatewayPayment> {
  if (payment.provider !== "stripe" || payment.status !== "ACTION_REQUIRED") return payment;
  try {
    return fromStripe(await cancelIntent(payment.id));
  } catch (err) {
    if (err instanceof StripeError && err.status === 400) return fromStripe(await retrieveIntent(payment.id));
    throw err;
  }
}

/* ---------------- refund ---------------- */

/** Refunds through the provider that took the payment. Throws GatewayUnavailableError or GatewaySetupError before any money moves. */
export async function refundCard(p: {
  provider: string;
  environment: string;
  paymentId: string;
  amountCents: number;
  reason: string;
  idempotencyKey: string;
}): Promise<{ id: string; status: string }> {
  if (p.provider === "stripe") {
    if (!stripeConfigured()) throw new GatewayUnavailableError("Stripe isn't set up, so refunds can't be issued right now.");
    if (p.environment !== stripeEnvironment()) throw new GatewaySetupError(`This payment was taken in Stripe ${p.environment} mode.`);
    const r = await createRefund({ paymentIntentId: p.paymentId, amountCents: p.amountCents, note: p.reason, idempotencyKey: p.idempotencyKey });
    return { id: r.id, status: refundStatus(r.status) };
  }
  const creds = await getCredentials().catch(() => null);
  if (!creds) throw new GatewayUnavailableError("Square isn't connected, so refunds of Square payments can't be issued right now.");
  if (p.environment !== creds.environment) throw new GatewaySetupError("This payment was taken in a different Square environment.");
  return refundPayment(creds, { paymentId: p.paymentId, amountCents: p.amountCents, idempotencyKey: p.idempotencyKey, reason: p.reason });
}

/** Provider set-up as the admin Payments page shows it (no secrets). */
export function stripeSetup() {
  return {
    configured: stripeConfigured(),
    environment: stripeEnvironment(),
    webhookConfigured: !!env.STRIPE_WEBHOOK_SECRET,
  };
}
