/**
 * Public photos and league news.
 *
 *   GET  /site-images/:id                       a photo (public, cached for good: ids never change)
 *   GET  /news · GET /news/:id                  published news, pinned first
 *   PUT  /admin/content/images/slots/:slot      replace a home page photo (raw body: the file)
 *   DELETE /admin/content/images/slots/:slot    back to the built-in photo
 *   POST /admin/content/images                  upload a photo for a news post or sponsor logo
 *   GET/POST/PUT/DELETE /admin/content/news     manage news
 */
import { IMAGE_SLOT_KEYS, type ImageSlot, type ImageSlots, siteImageUrl } from "@nffl/shared";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import express, { Router, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import sharp from "sharp";
import { z } from "zod";
import { env } from "../../config.js";
import { db, type DbOrTx } from "../../db/client.js";
import { newsPosts, siteImages, siteSettings } from "../../db/schema/index.js";
import { adminIdleTimeout, handler, requireAuth, requireMfa, requirePermission } from "../../http/context.js";
import { HttpError } from "../../http/errors.js";
import { writeAudit } from "../platform/audit.js";
import { sniff } from "../documents/service.js";
import { getSetting } from "./routes.js";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/* ---------------- photos ---------------- */

/** Checks it's a photo and re-saves it as a JPEG (no hidden data such as GPS), at most `max` pixels wide/tall. */
async function cleanPhoto(buf: Buffer, max: number) {
  if (!buf.length) throw new HttpError(400, "VALIDATION_FAILED", "Choose a photo to upload.");
  if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(400, "VALIDATION_FAILED", "That photo is too large. The limit is 8 MB.");
  const type = sniff(buf);
  if (!type || type === "application/pdf") throw new HttpError(400, "VALIDATION_FAILED", "Upload a photo (JPG, PNG or WebP).");
  try {
    const { data, info } = await sharp(buf, { failOn: "error", limitInputPixels: 80_000_000 })
      .rotate()
      .resize({ width: max, height: max, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#011322" })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch {
    throw new HttpError(400, "VALIDATION_FAILED", "That photo couldn't be read. Try a different file.");
  }
}

async function saveImage(tx: DbOrTx, buf: Buffer, max: number, userId: string) {
  const p = await cleanPhoto(buf, max);
  const [row] = await tx.insert(siteImages).values({ contentType: "image/jpeg", data: p.data, width: p.width, height: p.height, uploadedBy: userId }).returning({ id: siteImages.id });
  return { id: row!.id, url: siteImageUrl(row!.id), width: p.width, height: p.height };
}

/** Deletes photos nothing uses any more (home page slots, news posts, sponsor logos). */
async function dropUnused(tx: DbOrTx, ids: (string | null | undefined)[]) {
  const candidates = [...new Set(ids.filter((x): x is string => !!x))];
  if (!candidates.length) return;
  const slots = Object.values((await getSetting("images")) as ImageSlots);
  const logos = ((await getSetting("seasonHome")).sponsors ?? []).map((s) => s.logoId);
  const news = await tx.select({ id: newsPosts.imageId }).from(newsPosts).where(inArray(newsPosts.imageId, candidates));
  const used = new Set([...slots, ...logos, ...news.map((n) => n.id)]);
  const drop = candidates.filter((id) => !used.has(id));
  if (drop.length) await tx.delete(siteImages).where(inArray(siteImages.id, drop));
}

async function setSlots(tx: DbOrTx, next: ImageSlots, before: ImageSlots, actor: string, req: Request) {
  await tx
    .insert(siteSettings)
    .values({ key: "images", value: next, updatedBy: actor, updatedAt: new Date() })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value: next, updatedBy: actor, updatedAt: new Date() } });
  await writeAudit(tx, { actorUserId: actor, action: "content.images.update", targetType: "site_setting", targetId: "images", before, after: next, requestId: req.ctx.requestId, ipAddress: req.ctx.ip });
}

/* ---------------- news ---------------- */

const newsInput = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().max(4000).default(""),
  imageId: z.uuid().nullable().default(null),
  linkText: z.string().trim().max(40).optional().transform((v) => v || null),
  linkUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || v.startsWith("/") || /^https:\/\/[^\s]+$/i.test(v), "Use a path like /schedule or an https:// link")
    .optional()
    .transform((v) => v || null),
  pinned: z.boolean().default(false),
  /** Blank = now. A future time keeps the post hidden until then. */
  publishedAt: z
    .union([z.iso.datetime({ offset: true }), z.literal("")])
    .optional()
    .transform((v) => (v ? new Date(v) : null)),
});

type NewsRow = typeof newsPosts.$inferSelect;
const publicNews = (n: NewsRow) => ({
  id: n.id,
  title: n.title,
  body: n.body,
  imageUrl: n.imageId ? siteImageUrl(n.imageId) : null,
  linkText: n.linkText,
  linkUrl: n.linkUrl,
  pinned: n.pinned,
  publishedAt: n.publishedAt,
});

async function requireImage(tx: DbOrTx, id: string | null) {
  if (!id) return;
  const [row] = await tx.select({ id: siteImages.id }).from(siteImages).where(eq(siteImages.id, id));
  if (!row) throw new HttpError(400, "VALIDATION_FAILED", "That photo is no longer available. Upload it again.");
}

/* ---------------- public routes ---------------- */

export const publicSiteRouter = Router();

publicSiteRouter.get(
  "/site-images/:id",
  handler(async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw new HttpError(404, "NOT_FOUND", "Not found.");
    const [img] = await db.select({ data: siteImages.data, contentType: siteImages.contentType }).from(siteImages).where(eq(siteImages.id, id.data));
    if (!img) throw new HttpError(404, "NOT_FOUND", "Not found.");
    res.setHeader("content-type", img.contentType);
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    res.setHeader("cross-origin-resource-policy", "same-site");
    res.send(img.data);
  }),
);

publicSiteRouter.get(
  "/news",
  handler(async (req, res) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query);
    const rows = await db
      .select()
      .from(newsPosts)
      .where(lte(newsPosts.publishedAt, new Date()))
      .orderBy(desc(newsPosts.pinned), desc(newsPosts.publishedAt))
      .limit(limit);
    res.set("cache-control", "public, max-age=30");
    res.json({ items: rows.map(publicNews) });
  }),
);

publicSiteRouter.get(
  "/news/:id",
  handler(async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw new HttpError(404, "NOT_FOUND", "Post not found.");
    const [n] = await db.select().from(newsPosts).where(and(eq(newsPosts.id, id.data), lte(newsPosts.publishedAt, new Date())));
    if (!n) throw new HttpError(404, "NOT_FOUND", "Post not found.");
    res.set("cache-control", "public, max-age=30");
    res.json({ post: publicNews(n) });
  }),
);

/* ---------------- admin routes ---------------- */

export const adminSiteRouter = Router();
adminSiteRouter.use(requireAuth, requireMfa, adminIdleTimeout, requirePermission("content.manage"));

const raw = express.raw({ type: ["image/*", "application/octet-stream"], limit: MAX_IMAGE_BYTES + 1024 });
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: env.NODE_ENV === "test" ? 1000 : 60,
  keyGenerator: (req) => req.ctx?.auth?.user.id ?? "anon",
  validate: false,
  handler: (req, res) => res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many uploads. Please try again later.", requestId: req.ctx?.requestId } }),
});
const body = (req: Request) => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
const slotParam = (req: Request) => {
  const s = String(req.params.slot);
  if (!(IMAGE_SLOT_KEYS as string[]).includes(s)) throw new HttpError(404, "NOT_FOUND", "Unknown photo.");
  return s as ImageSlot;
};

adminSiteRouter.put(
  "/images/slots/:slot",
  uploadLimiter,
  raw,
  handler(async (req, res) => {
    const slot = slotParam(req);
    const actor = req.ctx.auth!.user.id;
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('site-images'))`);
      const before = (await getSetting("images")) as ImageSlots;
      const img = await saveImage(tx, body(req), 2400, actor);
      await setSlots(tx, { ...before, [slot]: img.id }, before, actor, req);
      return { img, old: before[slot] };
    });
    await db.transaction((tx) => dropUnused(tx, [result.old]));
    res.json({ slot, image: result.img });
  }),
);

adminSiteRouter.delete(
  "/images/slots/:slot",
  handler(async (req, res) => {
    const slot = slotParam(req);
    const actor = req.ctx.auth!.user.id;
    const old = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('site-images'))`);
      const before = (await getSetting("images")) as ImageSlots;
      if (before[slot]) await setSlots(tx, { ...before, [slot]: null }, before, actor, req);
      return before[slot];
    });
    await db.transaction((tx) => dropUnused(tx, [old]));
    res.json({ slot, image: null });
  }),
);

/** A photo for a news post or a sponsor logo; it's kept once a post or the sponsor list uses it. */
adminSiteRouter.post(
  "/images",
  uploadLimiter,
  raw,
  handler(async (req, res) => {
    const { use } = z.object({ use: z.enum(["news", "logo"]).default("news") }).parse(req.query);
    const img = await saveImage(db, body(req), use === "logo" ? 600 : 1800, req.ctx.auth!.user.id);
    res.status(201).json({ image: img });
  }),
);

adminSiteRouter.get(
  "/news",
  handler(async (_req, res) => {
    const rows = await db.select().from(newsPosts).orderBy(desc(newsPosts.pinned), desc(newsPosts.publishedAt));
    res.json({ items: rows.map((n) => ({ ...publicNews(n), imageId: n.imageId, updatedAt: n.updatedAt })) });
  }),
);

adminSiteRouter.post(
  "/news",
  handler(async (req, res) => {
    const input = newsInput.parse(req.body);
    const actor = req.ctx.auth!.user.id;
    const post = await db.transaction(async (tx) => {
      await requireImage(tx, input.imageId);
      const [n] = await tx
        .insert(newsPosts)
        .values({ ...input, publishedAt: input.publishedAt ?? new Date(), createdBy: actor })
        .returning();
      await writeAudit(tx, { actorUserId: actor, action: "news.create", targetType: "news_post", targetId: n!.id, after: { ...n, body: undefined }, requestId: req.ctx.requestId, ipAddress: req.ctx.ip });
      return n!;
    });
    res.status(201).json({ post: publicNews(post) });
  }),
);

adminSiteRouter.put(
  "/news/:id",
  handler(async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const input = newsInput.parse(req.body);
    const actor = req.ctx.auth!.user.id;
    const { post, oldImage } = await db.transaction(async (tx) => {
      const [before] = await tx.select().from(newsPosts).where(eq(newsPosts.id, id)).for("update");
      if (!before) throw new HttpError(404, "NOT_FOUND", "Post not found.");
      await requireImage(tx, input.imageId);
      const [n] = await tx
        .update(newsPosts)
        .set({ ...input, publishedAt: input.publishedAt ?? before.publishedAt, updatedAt: new Date() })
        .where(eq(newsPosts.id, id))
        .returning();
      await writeAudit(tx, { actorUserId: actor, action: "news.update", targetType: "news_post", targetId: id, before: { ...before, body: undefined }, after: { ...n, body: undefined }, requestId: req.ctx.requestId, ipAddress: req.ctx.ip });
      return { post: n!, oldImage: before.imageId !== n!.imageId ? before.imageId : null };
    });
    await db.transaction((tx) => dropUnused(tx, [oldImage]));
    res.json({ post: publicNews(post) });
  }),
);

adminSiteRouter.delete(
  "/news/:id",
  handler(async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const actor = req.ctx.auth!.user.id;
    const image = await db.transaction(async (tx) => {
      const [before] = await tx.delete(newsPosts).where(eq(newsPosts.id, id)).returning();
      if (!before) throw new HttpError(404, "NOT_FOUND", "Post not found.");
      await writeAudit(tx, { actorUserId: actor, action: "news.delete", targetType: "news_post", targetId: id, before: { ...before, body: undefined }, requestId: req.ctx.requestId, ipAddress: req.ctx.ip });
      return before.imageId;
    });
    await db.transaction((tx) => dropUnused(tx, [image]));
    res.json({ ok: true });
  }),
);
