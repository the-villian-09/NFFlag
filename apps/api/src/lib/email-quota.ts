/**
 * Daily per-address email limits (Nov 10 hardening). Anyone can type someone
 * else's address into sign-up, "forgot password" or the contact form, so each
 * kind of email an outsider can trigger is capped per address per day.
 *
 * The count lives in Postgres (email_quota), so it holds through restarts and
 * is shared by every API instance. Over the limit, the email is simply not
 * sent and the request answers as usual: the response never reveals whether
 * an address has an account or has hit its limit.
 */
import { lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { emailQuota } from "../db/schema/index.js";
import { logger } from "./logger.js";

export const DAILY_EMAIL_LIMITS = {
  /** Account confirmation links (sign-up, resend, sign-in before confirming). */
  verify: 5,
  /** Password reset links. */
  reset: 5,
  /** Emailed sign-in codes. */
  login_code: 10,
  /** Contact-form messages from one sender address. */
  contact: 3,
} as const;

export type EmailQuotaKind = keyof typeof DAILY_EMAIL_LIMITS;

/** Lower-cased and trimmed, so "Pat@X.com " and "pat@x.com" share one count. */
export function quotaAddress(email: string) {
  return email.trim().toLowerCase();
}

/**
 * Counts one email of `kind` to `email` for today (UTC) and says whether it
 * may be sent. One statement, so two requests at once can't both slip under
 * the limit.
 */
export async function takeEmailQuota(email: string, kind: EmailQuotaKind): Promise<boolean> {
  const address = quotaAddress(email);
  const [row] = await db
    .insert(emailQuota)
    .values({ address, kind, day: sql`(now() at time zone 'utc')::date`, count: 1 })
    .onConflictDoUpdate({
      target: [emailQuota.address, emailQuota.kind, emailQuota.day],
      set: { count: sql`${emailQuota.count} + 1` },
    })
    .returning({ count: emailQuota.count });
  const allowed = (row?.count ?? 1) <= DAILY_EMAIL_LIMITS[kind];
  if (!allowed) {
    // No address in the log: the domain is enough to spot a pattern.
    logger.warn({ kind, domain: address.split("@")[1] ?? "", count: row?.count }, "daily email limit reached; not sent");
  }
  return allowed;
}

/** Worker cleanup: counts older than two days are no longer needed. */
export async function cleanupEmailQuota() {
  const gone = await db
    .delete(emailQuota)
    .where(lt(emailQuota.day, sql`((now() at time zone 'utc')::date - 2)`))
    .returning({ address: emailQuota.address });
  return gone.length;
}
