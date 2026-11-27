"use client";

import { useEffect, useRef } from "react";
import { api } from "./api";

export type View = "feed" | "chat" | "staff";
export type Rsvp = "yes" | "maybe" | "no";

export interface Message {
  id: string;
  teamId: string;
  channel: "team" | "staff";
  kind: "chat" | "post" | "alert";
  body: string;
  pinned: boolean;
  eventType: "game" | "practice" | null;
  eventId: string | null;
  createdAt: string;
  authorUserId: string | null;
  authorName: string;
  authorLabel: string;
  seenCount: number | null;
}

export interface Child {
  playerId: string;
  name: string;
}

export interface TeamEvent {
  type: "game" | "practice";
  id: string;
  startsAt: string;
  location: string;
  title: string;
  status: string;
  durationMinutes?: number;
  notes?: string | null;
}

export interface SpaceSummary {
  teamId: string;
  teamName: string;
  color: string | null;
  divisionName: string;
  seasonName: string;
  readOnly: boolean;
  role: "staff" | "family";
  staffRole: string | null;
  children: Child[];
  muted: boolean;
  unread: { feed: number; chat: number; staff: number };
  latest: Message | null;
  pinned: Message | null;
  next: (TeamEvent & { myRsvps: (Child & { status: Rsvp | null })[] }) | null;
}

export interface SpaceDetail {
  team: { id: string; name: string; color: string | null; divisionName: string; seasonName: string };
  role: "staff" | "family" | "admin";
  staffRole: string | null;
  readOnly: boolean;
  children: Child[];
  can: { chat: boolean; post: boolean; staffChannel: boolean; moderate: boolean; seeRsvps: boolean };
  members: { role: "staff" | "family"; name: string; label: string }[];
  counts: { families: number; staff: number };
}

export interface EventWithRsvps extends TeamEvent {
  counts: { yes: number; maybe: number; no: number; none: number };
  myRsvps: (Child & { status: Rsvp | null; note: string | null })[];
}

export const STAFF_ROLE: Record<string, string> = {
  head_coach: "Head coach",
  assistant_coach: "Assistant coach",
  team_manager: "Team mom",
};

export const RSVP_LABEL: Record<Rsvp, string> = { yes: "Going", maybe: "Maybe", no: "Can't make it" };

/** "Sat, Mar 14 · 9:00 AM" in league time. */
export function when(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

/** "2:14 PM" today, "Mon 2:14 PM" this week, else "Mar 3". */
export function stamp(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const opts = { timeZone: "America/New_York" } as const;
  const day = (x: Date) => x.toLocaleDateString("en-US", opts);
  if (day(d) === day(now)) return d.toLocaleTimeString("en-US", { ...opts, hour: "numeric", minute: "2-digit" });
  if (now.getTime() - d.getTime() < 6 * 86400_000) return d.toLocaleString("en-US", { ...opts, weekday: "short", hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString("en-US", { ...opts, month: "short", day: "numeric" });
}

export interface LiveEvent {
  type: "message" | "delete" | "pin" | "rsvp" | "read";
  data: Partial<Message> & { teamId: string; id: string; channel?: string };
}

/**
 * One live connection for all of this person's teams. The server closes it
 * every few minutes and the browser reconnects by itself; onReconnect lets
 * the page catch up on anything sent while it was away.
 */
export function useTeamLive(onEvent: (e: LiveEvent) => void, onReconnect?: () => void) {
  const handler = useRef(onEvent);
  const reconnect = useRef(onReconnect);
  handler.current = onEvent;
  reconnect.current = onReconnect;
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let opened = false;
    const open = () => {
      if (es) return;
      es = new EventSource("/api/v1/team-spaces/stream", { withCredentials: true });
      es.addEventListener("ready", () => {
        if (opened) reconnect.current?.();
        opened = true;
      });
      for (const type of ["message", "delete", "pin", "rsvp", "read"] as const) {
        es.addEventListener(type, (ev) => {
          try {
            handler.current({ type, data: JSON.parse((ev as MessageEvent).data) });
          } catch {
            /* ignore a malformed event */
          }
        });
      }
    };
    const close = () => {
      es?.close();
      es = null;
    };
    // While the page is hidden (another app, screen off) the connection is
    // dropped, so the server knows to send notifications instead.
    const onVisibility = () => (document.visibilityState === "visible" ? open() : close());
    if (document.visibilityState === "visible") open();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", close);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", close);
      close();
    };
  }, []);
}

/* ---------------- push notifications ---------------- */

export function pushSupported() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** iPhone/iPad Safari only allows notifications once the site is on the Home Screen. */
export function needsHomeScreen() {
  if (typeof window === "undefined") return false;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  return ios && !standalone;
}

function keyBytes(base64: string) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function currentPush(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Asks permission and signs this device up. Returns a message for the person. */
export async function enablePush(): Promise<{ ok: boolean; message: string }> {
  if (needsHomeScreen()) return { ok: false, message: "On iPhone, add NFFL to your Home Screen first (Share, then Add to Home Screen), then open it from there." };
  if (!pushSupported()) return { ok: false, message: "This browser can't show notifications. You'll still get alert emails." };
  const { publicKey } = await api.get<{ publicKey: string | null }>("/push/key");
  if (!publicKey) return { ok: false, message: "Notifications aren't set up on the server yet. You'll still get alert emails." };
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, message: "Notifications are blocked for this site. Turn them on in your browser's settings." };
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  await api.post("/push/subscriptions", sub.toJSON());
  return { ok: true, message: "Notifications are on for this device." };
}

export async function disablePush() {
  const sub = await currentPush();
  if (!sub) return;
  await api.del("/push/subscriptions", { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

/** Re-saves this device's sign-up on the server (in case an earlier save didn't go through). */
export async function syncPush() {
  try {
    const sub = await currentPush();
    if (sub) await api.post("/push/subscriptions", sub.toJSON());
  } catch {
    /* best effort */
  }
}

export interface PushTest {
  ready: boolean;
  devices: number;
  sent: number;
  failed: number;
  removed: number;
}
