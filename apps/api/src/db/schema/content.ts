/**
 * Site content the league edits from the admin portal (no deploy needed):
 * public pages, site settings (announcement banner, contact details) and
 * contact-form messages.
 */
import { boolean, customType, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

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

/**
 * Public photos the league uploads (home page pictures, news photos, sponsor
 * logos). Re-saved as JPEG without hidden data; small enough to keep in the
 * database. Each upload gets a new id, so the files can be cached forever.
 */
export const siteImages = pgTable("site_images", {
  id: uuid("id").primaryKey().defaultRandom(),
  contentType: text("content_type").notNull(),
  data: bytea("data").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  uploadedBy: text("uploaded_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** League news on the in-season home page and /news. Hidden until publishedAt. */
export const newsPosts = pgTable(
  "news_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    /** Plain text; blank lines start new paragraphs. */
    body: text("body").notNull().default(""),
    imageId: uuid("image_id").references(() => siteImages.id, { onDelete: "set null" }),
    linkText: text("link_text"),
    linkUrl: text("link_url"),
    pinned: boolean("pinned").notNull().default(false),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("news_posts_published").on(t.publishedAt)],
);
