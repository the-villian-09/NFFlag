/**
 * Site content the league edits from the admin portal (no deploy needed):
 * public pages, site settings (announcement banner, contact details) and
 * contact-form messages.
 */
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const contentPages = pgTable("content_pages", {
  /** URL path segment: about, rules, coaches, faq, contact, privacy, terms. */
  slug: text("slug").primaryKey(),
  title: text("title").notNull(),
  /** Markdown. Rendered without raw HTML. */
  body: text("body").notNull(),
  /** True until an admin edits it; the page shows a "placeholder text" notice. */
  isPlaceholder: boolean("is_placeholder").notNull().default(true),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Small keyed settings: "announcement", "contact". Shapes validated in the API. */
export const siteSettings = pgTable("site_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const contactMessages = pgTable(
  "contact_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    topic: text("topic"),
    message: text("message").notNull(),
    ipAddress: text("ip_address"),
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("contact_created_idx").on(t.createdAt)],
);
