"use client";

/**
 * Stripe's embedded Connect components (payout setup, payouts with "Get paid
 * now", tax forms). They run in Stripe's own frames on our page; the referee's
 * tax ID and bank details go straight to Stripe and never reach our servers.
 */
import { useEffect, useRef, useState } from "react";
import { loadConnectAndInitialize } from "@stripe/connect-js/pure";
import type { StripeConnectInstance } from "@stripe/connect-js";
import { api } from "@/lib/api";

type Tag = "account-onboarding" | "payouts" | "notification-banner" | "documents" | "account-management";

let cached: { userId: string; instance: Promise<StripeConnectInstance> } | null = null;

/**
 * One Connect instance per signed-in referee; each component asks our API for
 * a fresh session. Keyed by user so another person signing in on the same tab
 * never sees the previous referee's account.
 */
function connect(userId: string) {
  if (cached && cached.userId !== userId) {
    void cached.instance.then((c) => c.logout()).catch(() => undefined);
    cached = null;
  }
  if (!cached) {
    const instance = api.post<{ clientSecret: string; publishableKey: string }>("/referees/payouts/session").then((first) => {
      let used = false;
      return loadConnectAndInitialize({
        publishableKey: first.publishableKey,
        fetchClientSecret: async () => {
          if (!used) {
            used = true;
            return first.clientSecret;
          }
          return (await api.post<{ clientSecret: string }>("/referees/payouts/session")).clientSecret;
        },
        appearance: {
          variables: {
            colorPrimary: "#0062d6",
            colorBackground: "#ffffff",
            colorText: "#011322",
            fontFamily: "system-ui, sans-serif",
            borderRadius: "4px",
          },
        },
      });
    });
    cached = { userId, instance };
    instance.catch(() => {
      if (cached?.instance === instance) cached = null;
    });
  }
  return cached.instance;
}

export function StripeConnectComponent({ tag, userId, onExit }: { tag: Tag; userId: string; onExit?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let el: (HTMLElement & { setOnExit?: (l: (() => void) | undefined) => void }) | null = null;
    let cancelled = false;
    connect(userId)
      .then((c) => {
        if (cancelled || !box.current) return;
        el = c.create(tag) as HTMLElement & { setOnExit?: (l: (() => void) | undefined) => void };
        if (onExit && el.setOnExit) el.setOnExit(onExit);
        box.current.appendChild(el);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Stripe couldn't load. Check your connection and refresh."));
    return () => {
      cancelled = true;
      el?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag, userId]);

  return error ? <div className="alert error">{error}</div> : <div ref={box} className="connect-box" />;
}
