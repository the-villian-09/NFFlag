/**
 * Push alerts to phones and browsers (Web Push). Alerts (rainouts, time
 * changes) always go through; posts and chat respect each person's mute for
 * that team and, if they turned it on, their "quiet overnight" setting
 * (9 PM – 7 AM Eastern). Dead subscriptions are removed.
 */
import { and, eq, inArray } from "drizzle-orm";
import webpush from "web-push";
import { env } from "../../config.js";
import { db } from "../../db/client.js";
import { notificationPrefs, pushSubscriptions, teamPrefs } from "../../db/schema/index.js";
import { logger } from "../../lib/logger.js";

let configured: boolean | null = null;
export function pushReady() {
  if (configured === null) {
    configured = !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
    if (configured) webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
  }
  return configured;
}

/** True between 9 PM and 7 AM league time. */
export function inQuietHours(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "America/New_York" }).format(now)) % 24;
  return hour >= 21 || hour < 7;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Where tapping the notification goes, e.g. /team/<id>. */
  url: string;
  /** Replaces an earlier notification with the same tag. */
  tag?: string;
}

/**
 * Who should actually get a non-urgent push: drops people who muted this team
 * and, between 9 PM and 7 AM, people who turned on quiet overnight.
 */
export async function pushRecipients(userIds: string[], teamId: string | null, urgent: boolean, now = new Date()) {
  if (urgent || !userIds.length) return userIds;
  const skip = new Set<string>();
  if (teamId) {
    const muted = await db
      .select({ userId: teamPrefs.userId })
      .from(teamPrefs)
      .where(and(eq(teamPrefs.teamId, teamId), eq(teamPrefs.muted, true), inArray(teamPrefs.userId, userIds)));
    for (const m of muted) skip.add(m.userId);
  }
  if (inQuietHours(now)) {
    const quiet = await db
      .select({ userId: notificationPrefs.userId })
      .from(notificationPrefs)
      .where(and(eq(notificationPrefs.quietOvernight, true), inArray(notificationPrefs.userId, userIds)));
    for (const q of quiet) skip.add(q.userId);
  }
  return userIds.filter((u) => !skip.has(u));
}

/**
 * Sends to everyone listed. urgent = alert: ignores mute and quiet overnight.
 * Fire-and-forget: never throws.
 */
export async function pushTo(userIds: string[], teamId: string | null, msg: PushMessage, opts: { urgent?: boolean } = {}) {
  try {
    if (!pushReady() || !userIds.length) return;
    const targets = await pushRecipients(userIds, teamId, !!opts.urgent);
    if (!targets.length) return;
    const subs = await db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, targets));
    const payload = JSON.stringify({ ...msg, body: msg.body.slice(0, 180) });
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
            TTL: opts.urgent ? 6 * 3600 : 3600,
            // Always high, like a text: every push shows a visible notification, so
            // Android and iPhone deliver it right away without penalty.
            urgency: "high",
          });
          await db.update(pushSubscriptions).set({ lastUsedAt: new Date() }).where(eq(pushSubscriptions.id, s.id));
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
          else logger.warn({ status }, "push send failed");
        }
      }),
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "push fan-out failed");
  }
}

/**
 * "Send a test notification": pushes straight to this person's devices (no
 * mute or quiet overnight) and reports what happened, so a family can tell
 * whether the problem is the server, the sign-up or the phone's settings.
 */
export async function sendTest(userId: string) {
  if (!pushReady()) return { ready: false, devices: 0, sent: 0, failed: 0, removed: 0 };
  const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  let sent = 0;
  let failed = 0;
  let removed = 0;
  const payload = JSON.stringify({ title: "NFFL", body: "Notifications are working on this device.", url: "/team", tag: "nffl-test" });
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 600, urgency: "high" });
      await db.update(pushSubscriptions).set({ lastUsedAt: new Date() }).where(eq(pushSubscriptions.id, s.id));
      sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
        removed++;
      } else {
        logger.warn({ status, body: String((err as { body?: unknown }).body ?? "").slice(0, 200) }, "push test failed");
        failed++;
      }
    }
  }
  return { ready: true, devices: subs.length, sent, failed, removed };
}
