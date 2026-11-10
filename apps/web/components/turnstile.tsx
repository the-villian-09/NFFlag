"use client";

/**
 * Cloudflare Turnstile — the invisible "are you human" check.
 *
 *   const human = useTurnstile();
 *   ...
 *   <form>{human.slot} ...</form>
 *   await authApi.signUp(body, await human.getToken());
 *
 * The widget runs in the background as soon as the form shows. getToken()
 * waits for its answer (normally ready before anyone finishes typing), and
 * starts a fresh check for the next submit (each token works once).
 *
 * Off when NEXT_PUBLIC_TURNSTILE_SITE_KEY isn't set: getToken() returns
 * undefined and nothing loads. The API decides whether a token is required.
 */
import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const WAIT_MS = 15_000;

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptLoad: Promise<void> | null = null;
function loadScript() {
  scriptLoad ??= new Promise<void>((resolve, reject) => {
    if (window.turnstile) return resolve();
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptLoad = null;
      reject(new Error("turnstile script failed"));
    };
    document.head.appendChild(s);
  });
  return scriptLoad;
}

const NOT_READY = "The security check didn't finish. Check your connection, refresh the page and try again.";

export function useTurnstile() {
  // A callback ref, so the check moves with the slot if the page swaps views.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const widget = useRef<string | null>(null);
  const token = useRef<string | null>(null);
  const waiting = useRef<((t: string | null) => void)[]>([]);

  useEffect(() => {
    if (!SITE_KEY || !node) return;
    let gone = false;
    const settle = (t: string | null) => {
      token.current = t;
      if (t) waiting.current.splice(0).forEach((w) => w(t));
    };
    loadScript()
      .then(() => {
        if (gone || !window.turnstile) return;
        widget.current = window.turnstile.render(node, {
          sitekey: SITE_KEY,
          callback: (t: string) => settle(t),
          "expired-callback": () => settle(null),
          "refresh-expired": "auto",
        });
      })
      .catch(() => waiting.current.splice(0).forEach((w) => w(null)));
    return () => {
      gone = true;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
      token.current = null;
    };
  }, [node]);

  async function getToken(): Promise<string | undefined> {
    if (!SITE_KEY) return undefined;
    const t =
      token.current ??
      (await new Promise<string | null>((resolve) => {
        waiting.current.push(resolve);
        setTimeout(() => resolve(null), WAIT_MS);
      }));
    // One use per token: start the next check now.
    token.current = null;
    if (widget.current && window.turnstile) window.turnstile.reset(widget.current);
    if (!t) throw new ApiError(400, "MISSING_RESPONSE", NOT_READY);
    return t;
  }

  const slot = SITE_KEY ? (
    <>
      <div ref={setNode} className="turnstile-slot" />
      <p className="turnstile-note muted">
        Protected by Cloudflare Turnstile (
        <a href="https://www.cloudflare.com/turnstile-privacy-policy/" target="_blank" rel="noopener noreferrer">
          privacy
        </a>
        ).
      </p>
    </>
  ) : null;

  return { slot, getToken };
}
