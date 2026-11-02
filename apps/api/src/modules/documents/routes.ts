/**
 * Uploads (R6):
 *   GET /players/:id/documents        a child's required files and whether each is in
 *   PUT /players/:id/documents/:kind  upload/replace one (raw body: the file)
 *   GET /me/photo · PUT /me/photo     the signed-in person's headshot (coaches, team moms, referees)
 *   GET /documents/:id/file           the file, if the viewer may see it
 */
import express, { Router, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { env } from "../../config.js";
import { handler, requireAuth, requireMfa } from "../../http/context.js";
import { familyDocuments, MAX_UPLOAD_BYTES, myPhoto, PLAYER_KINDS, readDocument, uploadMyPhoto, uploadPlayerDocument } from "./service.js";

export const documentsRouter = Router();

const raw = express.raw({ type: ["image/*", "application/pdf", "application/octet-stream"], limit: MAX_UPLOAD_BYTES + 1024 });
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: env.NODE_ENV === "test" ? 1000 : 40,
  keyGenerator: (req) => req.ctx?.auth?.user.id ?? "anon",
  validate: false,
  handler: (req, res) => res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many uploads. Please try again later.", requestId: req.ctx?.requestId } }),
});
const body = (req: Request) => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));

documentsRouter.get(
  "/players/:id/documents",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    res.json(await familyDocuments(req.ctx.auth!.user.id, z.uuid().parse(req.params.id)));
  }),
);

documentsRouter.put(
  "/players/:id/documents/:kind",
  requireAuth,
  requireMfa,
  uploadLimiter,
  raw,
  handler(async (req, res) => {
    const kind = z.enum(PLAYER_KINDS as [string, ...string[]]).parse(req.params.kind) as (typeof PLAYER_KINDS)[number];
    res.json({ document: await uploadPlayerDocument(req.ctx.auth!.user.id, z.uuid().parse(req.params.id), kind, body(req)) });
  }),
);

documentsRouter.get(
  "/me/photo",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    res.json(await myPhoto(req.ctx.auth!.user.id));
  }),
);

documentsRouter.put(
  "/me/photo",
  requireAuth,
  requireMfa,
  uploadLimiter,
  raw,
  handler(async (req, res) => {
    res.json({ document: await uploadMyPhoto(req.ctx.auth!.user.id, body(req)) });
  }),
);

documentsRouter.get(
  "/documents/:id/file",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    const f = await readDocument(
      { userId: req.ctx.auth!.user.id, access: req.ctx.access!, requestId: req.ctx.requestId, ip: req.ctx.ip ?? undefined },
      z.uuid().parse(req.params.id),
    );
    res.setHeader("content-type", f.contentType);
    res.setHeader("cache-control", "private, no-store");
    res.setHeader("content-disposition", `inline; filename="${f.kind.replace(/_/g, "-")}.${f.contentType === "application/pdf" ? "pdf" : "jpg"}"`);
    res.send(f.data);
  }),
);
