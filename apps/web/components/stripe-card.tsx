"use client";

/**
 * Stripe Payment Element (cards, plus Apple Pay / Google Pay where the device
 * offers them). Card numbers are typed into Stripe's own frame and never reach
 * our servers; we get a one-time ConfirmationToken and the server charges it.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

interface StripeElement {
  mount(el: HTMLElement): void;
  destroy(): void;
  on(event: "ready" | "change", cb: (e: { complete?: boolean }) => void): void;
}
interface StripeElements {
  create(type: "payment", options?: unknown): StripeElement;
  submit(): Promise<{ error?: { message?: string } }>;
  update(options: { amount: number }): void;
}
interface StripeInstance {
  elements(options: unknown): StripeElements;
  createConfirmationToken(o: { elements: StripeElements; params?: unknown }): Promise<{ confirmationToken?: { id: string }; error?: { message?: string } }>;
  handleNextAction(o: { clientSecret: string }): Promise<{ error?: { message?: string } }>;
}
declare global {
  interface Window {
    Stripe?: (publishableKey: string) => StripeInstance;
  }
}

const SDK_URL = "https://js.stripe.com/v3/";

function loadSdk(): Promise<void> {
  if (window.Stripe) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>("script[data-stripe-sdk]");
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("load")));
    });
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SDK_URL;
    s.async = true;
    s.dataset.stripeSdk = "v3";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("load"));
    document.head.appendChild(s);
  });
}

/** One Stripe instance per key (Stripe.js asks for this). */
const instances = new Map<string, StripeInstance>();
function stripeFor(key: string) {
  if (!instances.has(key)) instances.set(key, window.Stripe!(key));
  return instances.get(key)!;
}

export interface StripeCardHandle {
  /** Returns a ConfirmationToken id, or throws an Error with a message to show. */
  tokenize(details: { amountCents: number; name: string; email: string }): Promise<string>;
  /** Finishes a bank check (3-D Secure). Resolves either way; the server decides the outcome. */
  handleAction(clientSecret: string): Promise<void>;
}

export const StripeCard = forwardRef<
  StripeCardHandle,
  { publishableKey: string; environment: "test" | "live"; amountCents: number; onReady?: (ready: boolean) => void }
>(function StripeCard({ publishableKey, environment, amountCents, onReady }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const elements = useRef<StripeElements | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let element: StripeElement | null = null;
    loadSdk()
      .then(() => {
        if (cancelled || !window.Stripe || !box.current) return;
        const els = stripeFor(publishableKey).elements({
          mode: "payment",
          amount: amountCents,
          currency: "usd",
          paymentMethodTypes: ["card"],
          appearance: {
            theme: "stripe",
            variables: { colorPrimary: "#0062d6", fontFamily: "system-ui, sans-serif", borderRadius: "4px" },
          },
        });
        element = els.create("payment", { layout: "tabs", fields: { billingDetails: { name: "never", email: "never" } } });
        element.on("ready", () => {
          if (!cancelled) onReady?.(true);
        });
        element.mount(box.current);
        elements.current = els;
      })
      .catch(() => setError("The card form couldn't load. Check your connection, turn off ad blockers for this page, and refresh."));
    return () => {
      cancelled = true;
      element?.destroy();
      elements.current = null;
      onReady?.(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishableKey]);

  // Keep the amount shown by Apple Pay / Google Pay in step with the total (e.g. after a promo code).
  useEffect(() => {
    elements.current?.update({ amount: amountCents });
  }, [amountCents]);

  useImperativeHandle(ref, () => ({
    async tokenize(d) {
      const els = elements.current;
      if (!els) throw new Error("The card form isn't ready yet.");
      const submitted = await els.submit();
      if (submitted.error) throw new Error(submitted.error.message ?? "Please check your card details.");
      const { confirmationToken, error: tokenError } = await stripeFor(publishableKey).createConfirmationToken({
        elements: els,
        params: { payment_method_data: { billing_details: { name: d.name, email: d.email } } },
      });
      if (tokenError || !confirmationToken) throw new Error(tokenError?.message ?? "Please check your card details.");
      return confirmationToken.id;
    },
    async handleAction(clientSecret) {
      await stripeFor(publishableKey).handleNextAction({ clientSecret });
    },
  }));

  return (
    <div>
      {error ? <div className="alert error">{error}</div> : <div ref={box} className="card-box" />}
      {environment === "test" && (
        <p className="hint" style={{ marginTop: 8 }}>
          Test mode: use card 4242 4242 4242 4242 (or 4000 0025 0000 3155 to try the bank check), any future date, any CVC and ZIP. No real
          money moves.
        </p>
      )}
    </div>
  );
});
