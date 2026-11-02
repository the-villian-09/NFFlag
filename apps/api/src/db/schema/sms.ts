/** Text message opt-ins (NFFL Text Alerts). One row per person. */
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.js";

export const smsSubscriptions = pgTable(
  "sms_subscriptions",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    /** +1XXXXXXXXXX */
    phone: text("phone").notNull(),
    /** subscribed | stopped */
    status: text("status").notNull(),
    /** Proof of consent: when, which wording, from where. */
    consentAt: timestamp("consent_at", { withTimezone: true }),
    consentVersion: text("consent_version"),
    consentIp: text("consent_ip"),
    /** account (unticked on the site) | keyword (replied STOP) */
    stoppedVia: text("stopped_via"),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sms_subscriptions_phone").on(t.phone)],
);
