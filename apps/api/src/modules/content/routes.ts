/**
 * Site content: public pages, announcement banner, contact details and the
 * contact form. Admins edit everything here from the portal; every change is
 * audited.
 */
import { desc, eq } from "drizzle-orm";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { env } from "../../config.js";
import { db, type DbOrTx } from "../../db/client.js";
import { contactMessages, contentPages, siteSettings } from "../../db/schema/index.js";
import { adminIdleTimeout, handler, requireAuth, requireMfa, requirePermission } from "../../http/context.js";
import { HttpError } from "../../http/errors.js";
import { getEmailSender } from "../../lib/email.js";
import { templates } from "../../lib/email-templates.js";
import { logger } from "../../lib/logger.js";
import { writeAudit } from "../platform/audit.js";
import { DEFAULT_PAGES, DEFAULT_SETTINGS, PAGE_SLUGS, type Announcement, type ContactInfo } from "./defaults.js";

/* ---------- validation ---------- */

/** Internal paths ("/sign-up") or full https links only. */
const safeHref = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === "" || v.startsWith("/") || /^https:\/\//i.test(v), "Use a path like /sign-up or an https:// link");

const announcementSchema = z.object({
  enabled: z.boolean(),
  message: z.string().trim().max(200),
  linkText: z.string().trim().max(60).optional(),
  linkHref: safeHref.optional(),
});

const contactSchema = z.object({
  inboxEmail: z.union([z.email(), z.literal("")]),
  publicEmail: z.union([z.email(), z.literal("")]).optional(),
  phone: z.string().trim().max(32).optional(),
});

const SETTING_SCHEMAS = { announcement: announcementSchema, contact: contactSchema } as const;
type SettingKey = keyof typeof SETTING_SCHEMAS;

const pageInput = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().max(50_000),
});

const contactInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  phone: z.string().trim().max(32).optional(),
  topic: z.enum(["registration", "volunteering", "general"]).default("general"),
  message: z.string().trim().min(5).max(5000),
  /** Honeypot: hidden on the form; bots fill it in. */
  website: z.string().max(200).optional(),
});

/* ---------- data helpers ---------- */

export async function seedContent(conn: DbOrTx = db) {
  await conn
    .insert(contentPages)
    .values(DEFAULT_PAGES.map((p) => ({ ...p, isPlaceholder: true })))
    .onConflictDoNothing();
  await conn
    .insert(siteSettings)
    .values(Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({ key, value })))
    .onConflictDoNothing();
}

async function getSetting<K extends SettingKey>(key: K): Promise<z.infer<(typeof SETTING_SCHEMAS)[K]>> {
  const [row] = await db.select().from(siteSettings).where(eq(siteSettings.key, key));
  const parsed = SETTING_SCHEMAS[key].safeParse(row?.value ?? DEFAULT_SETTINGS[key]);
  return (parsed.success ? parsed.data : DEFAULT_SETTINGS[key]) as z.infer<(typeof SETTING_SCHEMAS)[K]>;
}

function isSlug(s: string): s is (typeof PAGE_SLUGS)[number] {
  return (PAGE_SLUGS as readonly string[]).includes(s);
}

/* ---------- public ---------- */

export const publicContentRouter = Router();

publicContentRouter.get(
  "/pages/:slug",
  handler(async (req, res) => {
    const slug = String(req.params.slug);
    if (!isSlug(slug)) throw new HttpError(404, "NOT_FOUND", "Page not found.");
    const [page] = await db.select().from(contentPages).where(eq(contentPages.slug, slug));
    if (!page) throw new HttpError(404, "NOT_FOUND", "Page not found.");
    res.set("cache-control", "public, max-age=30");
    res.json({ page: { slug: page.slug, title: page.title, body: page.body, isPlaceholder: page.isPlaceholder, updatedAt: page.updatedAt } });
  }),
);

/** Banner + public contact details for the site chrome. */
publicContentRouter.get(
  "/site",
  handler(async (_req, res) => {
    const announcement = (await getSetting("announcement")) as Announcement;
    const contact = (await getSetting("contact")) as ContactInfo;
    res.set("cache-control", "public, max-age=30");
    res.json({
      announcement: announcement.enabled && announcement.message ? announcement : null,
      contact: { publicEmail: contact.publicEmail || null, phone: contact.phone || null },
    });
  }),
);

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: env.NODE_ENV === "test" ? 1000 : 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      error: { code: "RATE_LIMITED", message: "Too many messages. Please try again later.", requestId: req.ctx?.requestId },
    }),
});

publicContentRouter.post(
  "/contact",
  contactLimiter,
  handler(async (req, res) => {
    const input = contactInput.parse(req.body);
    // Bots fill the hidden field: pretend success, store nothing.
    if (input.website) {
      res.status(202).json({ ok: true });
      return;
    }
    const [saved] = await db
      .insert(contactMessages)
      .values({
        name: input.name,
        email: input.email,
        phone: input.phone || null,
        topic: input.topic,
        message: input.message,
        ipAddress: req.ctx.ip,
      })
      .returning();

    const contact = (await getSetting("contact")) as ContactInfo;
    if (contact.inboxEmail) {
      try {
        await getEmailSender().send(
          templates.contactMessage(contact.inboxEmail, {
            name: input.name,
            email: input.email,
            phone: input.phone || null,
            topic: input.topic,
            message: input.message,
            adminUrl: `${env.APP_BASE_URL.replace(/\/$/, "")}/admin/content`,
          }),
        );
        await db.update(contactMessages).set({ emailedAt: new Date() }).where(eq(contactMessages.id, saved!.id));
      } catch (err) {
        logger.error({ err, messageId: saved!.id }, "contact message saved but email failed");
      }
    } else {
      logger.warn({ messageId: saved!.id }, "contact message saved; no inbox email set in Site content");
    }
    res.status(202).json({ ok: true });
  }),
);

/* ---------- admin ---------- */

export const adminContentRouter = Router();
adminContentRouter.use(requireAuth, requireMfa, adminIdleTimeout, requirePermission("content.manage"));

adminContentRouter.get(
  "/pages",
  handler(async (_req, res) => {
    const rows = await db
      .select({ slug: contentPages.slug, title: contentPages.title, isPlaceholder: contentPages.isPlaceholder, updatedAt: contentPages.updatedAt })
      .from(contentPages);
    rows.sort((a, b) => PAGE_SLUGS.indexOf(a.slug as never) - PAGE_SLUGS.indexOf(b.slug as never));
    res.json({ items: rows });
  }),
);

adminContentRouter.get(
  "/pages/:slug",
  handler(async (req, res) => {
    const [page] = await db.select().from(contentPages).where(eq(contentPages.slug, String(req.params.slug)));
    if (!page) throw new HttpError(404, "NOT_FOUND", "Page not found.");
    res.json({ page });
  }),
);

adminContentRouter.put(
  "/pages/:slug",
  handler(async (req, res) => {
    const slug = String(req.params.slug);
    if (!isSlug(slug)) throw new HttpError(404, "NOT_FOUND", "Page not found.");
    const input = pageInput.parse(req.body);
    const actor = req.ctx.auth!.user.id;
    const page = await db.transaction(async (tx) => {
      const [before] = await tx.select().from(contentPages).where(eq(contentPages.slug, slug));
      if (!before) throw new HttpError(404, "NOT_FOUND", "Page not found.");
      const [after] = await tx
        .update(contentPages)
        .set({ title: input.title, body: input.body, isPlaceholder: false, updatedBy: actor, updatedAt: new Date() })
        .where(eq(contentPages.slug, slug))
        .returning();
      await writeAudit(tx, {
        actorUserId: actor,
        action: "content.page.update",
        targetType: "content_page",
        targetId: slug,
        before: { title: before.title, body: before.body },
        after: { title: after!.title, body: after!.body },
        requestId: req.ctx.requestId,
        ipAddress: req.ctx.ip,
      });
      return after!;
    });
    res.json({ page });
  }),
);

adminContentRouter.get(
  "/settings",
  handler(async (_req, res) => {
    res.json({ announcement: await getSetting("announcement"), contact: await getSetting("contact") });
  }),
);

adminContentRouter.put(
  "/settings/:key",
  handler(async (req, res) => {
    const key = String(req.params.key);
    if (!(key in SETTING_SCHEMAS)) throw new HttpError(404, "NOT_FOUND", "Unknown setting.");
    const value = SETTING_SCHEMAS[key as SettingKey].parse(req.body);
    const actor = req.ctx.auth!.user.id;
    await db.transaction(async (tx) => {
      const [before] = await tx.select().from(siteSettings).where(eq(siteSettings.key, key));
      await tx
        .insert(siteSettings)
        .values({ key, value, updatedBy: actor, updatedAt: new Date() })
        .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedBy: actor, updatedAt: new Date() } });
      await writeAudit(tx, {
        actorUserId: actor,
        action: "content.setting.update",
        targetType: "site_setting",
        targetId: key,
        before: before?.value ?? null,
        after: value,
        requestId: req.ctx.requestId,
        ipAddress: req.ctx.ip,
      });
    });
    res.json({ [key]: value });
  }),
);

adminContentRouter.get(
  "/contact-messages",
  handler(async (_req, res) => {
    const rows = await db.select().from(contactMessages).orderBy(desc(contactMessages.createdAt)).limit(100);
    res.json({ items: rows.map(({ ipAddress: _ip, ...r }) => r) });
  }),
);
