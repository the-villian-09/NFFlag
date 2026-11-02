"use client";

/**
 * The card form for whichever provider the league uses (Stripe, or Square as
 * the backup), plus the shared pay flow: charge, finish a bank check if the
 * card's bank asks for one, then confirm.
 */
import { forwardRef, useImperativeHandle, useRef } from "react";
import { api, ApiError } from "@/lib/api";
import { SquareCard, type SquareCardHandle } from "./square-card";
import { StripeCard, type StripeCardHandle } from "./stripe-card";

export type CheckoutConfig =
  | { provider: "stripe"; publishableKey: string; environment: "test" | "live" }
  | { provider: "square"; applicationId: string; locationId: string; environment: "sandbox" | "production" };

export interface CardFormHandle {
  /** One-time token for the server to charge, or throws an Error with a message to show. */
  tokenize(d: { amountCents: number; name: string; email: string }): Promise<string>;
  handleAction(clientSecret: string): Promise<void>;
}

export const CardForm = forwardRef<CardFormHandle, { checkout: CheckoutConfig; amountCents: number; onReady?: (ready: boolean) => void }>(
  function CardForm({ checkout, amountCents, onReady }, ref) {
    const stripe = useRef<StripeCardHandle>(null);
    const square = useRef<SquareCardHandle>(null);

    useImperativeHandle(ref, () => ({
      async tokenize(d) {
        if (checkout.provider === "stripe") return stripe.current!.tokenize(d);
        const [givenName, ...rest] = d.name.trim().split(/\s+/);
        return square.current!.tokenize({ amountCents: d.amountCents, givenName: givenName ?? "", familyName: rest.join(" "), email: d.email });
      },
      async handleAction(clientSecret) {
        if (checkout.provider === "stripe") await stripe.current!.handleAction(clientSecret);
      },
    }));

    return checkout.provider === "stripe" ? (
      <StripeCard ref={stripe} publishableKey={checkout.publishableKey} environment={checkout.environment} amountCents={amountCents} onReady={onReady} />
    ) : (
      <SquareCard ref={square} applicationId={checkout.applicationId} locationId={checkout.locationId} environment={checkout.environment} onReady={onReady} />
    );
  },
);

/** Who processes the card, for the line under the Pay button. */
export const providerName = (c: CheckoutConfig) => (c.provider === "stripe" ? "Stripe" : "Square");

/**
 * Pays `payPath` with the card, finishing a bank check (3-D Secure) in the
 * browser if needed, then asks `payPath/confirm` for the outcome.
 */
export async function payWithCard<T>(
  card: CardFormHandle,
  payPath: string,
  d: { amountCents: number; name: string; email: string; expectedTotalCents: number },
): Promise<T> {
  const sourceId = await card.tokenize(d);
  try {
    return await api.post<T>(payPath, { sourceId, expectedTotalCents: d.expectedTotalCents });
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== "PAYMENT_ACTION_REQUIRED") throw err;
    const clientSecret = String(err.body.clientSecret ?? "");
    if (clientSecret) await card.handleAction(clientSecret);
    return api.post<T>(`${payPath}/confirm`);
  }
}
