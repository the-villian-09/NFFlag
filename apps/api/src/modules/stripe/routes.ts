/**
 * Stripe webhook: POST /api/v1/webhooks/stripe
 *
 * Settles payments whose result the checkout didn't see (connection dropped,
 * bank check finished later) and records refund updates, including refunds
 * made in the Stripe dashboard. Subscribe the endpoint to:
 *   payment_intent.succeeded, payment_intent.payment_failed, payment_intent.canceled,
 *   refund.created, refund.updated, refund.failed
 */
import { eq } from "drizzle-orm";
import express from "express";
import { db } from "../../db/client.js";
import { payments, squareWebhookEvents } from "../../db/schema/index.js";
import { handler } from "../../http/context.js";
import { HttpError } from "../../http/errors.js";
import { fromStripe } from "../payments/gateway.js";
import { applyRefundEvent } from "../payments/refund-events.js";
import { recordCompletedPayment, revertToPending } from "../registration/service.js";
import { parseReference } from "../square/client.js";
import { failApplicationPayment, recordApplicationPayment } from "../staff/service.js";
import { refundStatus, retrieveIntent, stripeConfigured, stripeEnvironment, verifyStripeSignature, type PaymentIntent, type StripeRefund } from "./client.js";

interface StripeEvent {
  id: string;
  type: string;
  livemode: boolean;
  data?: { object?: Record<string, unknown> };
}

/** Mount before express.json(): the signature covers the exact raw body. */
export const stripeWebhook = [
  express.raw({ type: "*/*", limit: "1mb" }),
  handler(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    if (!verifyStripeSignature(raw, req.header("stripe-signature"))) {
      throw new HttpError(403, "FORBIDDEN", "Invalid signature.");
    }
    const event = JSON.parse(raw) as StripeEvent;
    // Shared with Square's event ids (Stripe's start with evt_, so they can't collide).
    const [fresh] = await db.insert(squareWebhookEvents).values({ eventId: event.id, eventType: event.type }).onConflictDoNothing().returning();
    if (!fresh) {
      res.json({ ok: true, duplicate: true });
      return;
    }
    try {
      await handleEvent(event);
    } catch (err) {
      // Let Stripe retry: forget the event id.
      await db.delete(squareWebhookEvents).where(eq(squareWebhookEvents.eventId, event.id));
      throw err;
    }
    res.json({ ok: true });
  }),
];

async function handleEvent(event: StripeEvent) {
  // Only events from the mode our keys are in (a test event never touches live records).
  if (!stripeConfigured() || event.livemode !== (stripeEnvironment() === "live")) return;
  const obj = event.data?.object;
  if (!obj) return;

  if (event.type.startsWith("payment_intent.")) {
    const pi = obj as unknown as PaymentIntent;
    const ref = parseReference(pi.metadata?.reference);
    if (!ref) return; // not a payment this app made
    if (event.type === "payment_intent.succeeded") {
      // Re-read with the charge expanded, for the card brand, last 4 and receipt.
      const payment = fromStripe(await retrieveIntent(pi.id));
      if (payment.status !== "COMPLETED") return;
      if ("applicationId" in ref) await recordApplicationPayment(payment, { userId: null });
      else await recordCompletedPayment(payment, { userId: null });
      return;
    }
    if (event.type === "payment_intent.payment_failed" || event.type === "payment_intent.canceled") {
      const payment = fromStripe(pi);
      await db.update(payments).set({ status: payment.status, updatedAt: new Date() }).where(eq(payments.providerPaymentId, pi.id));
      // Frees the registration / application only if this was its current attempt.
      if ("applicationId" in ref) await failApplicationPayment(payment);
      else await revertToPending(ref.registrationId, payment.failureMessage ?? "The payment didn't go through.", payment.createdAt);
    }
    return;
  }

  if (event.type === "refund.created" || event.type === "refund.updated" || event.type === "refund.failed" || event.type === "charge.refund.updated") {
    const r = obj as unknown as StripeRefund;
    if (!r.payment_intent) return;
    await applyRefundEvent({
      id: r.id,
      paymentId: typeof r.payment_intent === "string" ? r.payment_intent : String((r.payment_intent as { id?: string }).id ?? ""),
      status: refundStatus(r.status),
      amountCents: r.amount,
      externalReason: "Refund reported by Stripe",
    });
  }
}
