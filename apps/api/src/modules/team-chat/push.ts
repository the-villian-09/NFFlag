/**
 * Push alerts to phones and browsers (Web Push). Alerts (rainouts, time
 * changes) always go through; posts and chat respect each person's mute and
 * league quiet hours (9 PM – 7 AM Eastern). Dead subscriptions are removed.
 */
import { and, eq, inArray } from "drizzle-orm";
import webpush from "web-push";
import { env } from "../../config.js";
import { db } from "../../db/client.js";
import { pushSubscriptions, teamPrefs } from "../../db/schema/index.js";
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
 * Sends to everyone listed. urgent = alert: ignores mute and quiet hours.
 * Fire-and-forget: never throws.
 */
export async function pushTo(userIds: string[], teamId: string | null, msg: PushMessage, opts: { urgent?: boolean } = {}) {
  try {
    if (!pushReady() || !userIds.length) return;
    let targets = userIds;
    if (!opts.urgent) {
      if (inQuietHours()) return;
      if (teamId) {
        const muted = await db
          .select({ userId: teamPrefs.userId })
          .from(teamPrefs)
          .where(and(eq(teamPrefs.teamId, teamId), eq(teamPrefs.muted, true), inArray(teamPrefs.userId, userIds)));
        const m = new Set(muted.map((r) => r.userId));
        targets = userIds.filter((u) => !m.has(u));
      }
    }
    if (!targets.length) return;
    const subs = await db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, targets));
    const payload = JSON.stringify({ ...msg, body: msg.body.slice(0, 180) });
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
            TTL: opts.urgent ? 6 * 3600 : 3600,
            urgency: opts.urgent ? "high" : "normal",
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
