"use client";

/**
 * Square Web Payments SDK card form. Card numbers are typed into Square's
 * own iframe and never reach our servers; we only receive a one-time token.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

interface SquareCardInstance {
  attach(selector: string | HTMLElement): Promise<void>;
  tokenize(details?: unknown): Promise<{ status: string; token?: string; errors?: { message: string }[] }>;
  destroy(): Promise<boolean>;
}
declare global {
  interface Window {
    Square?: { payments(appId: string, locationId: string): { card(): Promise<SquareCardInstance> } };
  }
}

const SDK_URL = {
  sandbox: "https://sandbox.web.squarecdn.com/v1/square.js",
  production: "https://web.squarecdn.com/v1/square.js",
};

function loadSdk(env: "sandbox" | "production"): Promise<void> {
  if (window.Square) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>(`script[data-square-sdk]`);
  if (existing) return new Promise((resolve, reject) => {
    existing.addEventListener("load", () => resolve());
    existing.addEventListener("error", () => reject(new Error("load")));
  });
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SDK_URL[env];
    s.async = true;
    s.dataset.squareSdk = env;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("load"));
    document.head.appendChild(s);
  });
}

export interface SquareCardHandle {
  /** Returns a card token, or throws an Error with a message to show. */
  tokenize(details: { amountCents: number; givenName: string; familyName: string; email: string }): Promise<string>;
}

export const SquareCard = forwardRef<
  SquareCardHandle,
  { applicationId: string; locationId: string; environment: "sandbox" | "production"; onReady?: (ready: boolean) => void }
>(function SquareCard({ applicationId, locationId, environment, onReady }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const card = useRef<SquareCardInstance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadSdk(environment)
      .then(async () => {
        if (cancelled || !window.Square || !box.current) return;
        const c = await window.Square.payments(applicationId, locationId).card();
        if (cancelled) {
          await c.destroy();
          return;
        }
        await c.attach(box.current);
        card.current = c;
        onReady?.(true);
      })
      .catch(() => setError("The card form couldn't load. Check your connection, turn off ad blockers for this page, and refresh."));
    return () => {
      cancelled = true;
      card.current?.destroy().catch(() => undefined);
      card.current = null;
      onReady?.(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applicationId, locationId, environment]);

  useImperativeHandle(ref, () => ({
    async tokenize(d) {
      if (!card.current) throw new Error("The card form isn't ready yet.");
      const result = await card.current.tokenize({
        amount: (d.amountCents / 100).toFixed(2),
        currencyCode: "USD",
        intent: "CHARGE",
        customerInitiated: true,
        sellerKeyedIn: false,
        billingContact: { givenName: d.givenName, familyName: d.familyName, email: d.email },
      });
      if (result.status === "OK" && result.token) return result.token;
      throw new Error(result.errors?.[0]?.message ?? "Please check your card details.");
    },
  }));

  return (
    <div>
      {error ? <div className="alert error">{error}</div> : <div ref={box} className="card-box" />}
      {environment === "sandbox" && (
        <p className="hint" style={{ marginTop: 8 }}>
          Test mode: use card 4111 1111 1111 1111, any future date, any CVV and ZIP. No real money moves.
        </p>
      )}
    </div>
  );
});
