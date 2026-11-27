/** Team spaces (My teams), push sign-up, and the admin reports queue. */
import { and, eq } from "drizzle-orm";
import { Router, type Request } from "express";
import { z } from "zod";
import { env } from "../../config.js";
import { db } from "../../db/client.js";
import { pushSubscriptions } from "../../db/schema/index.js";
import { adminIdleTimeout, handler, requireAuth, requireMfa, requirePermission } from "../../http/context.js";
import { HttpError } from "../../http/errors.js";
import { writeAudit } from "../platform/audit.js";
import { FLAG, requireFlag } from "../platform/flags.js";
import { openStream, setEnricher } from "./live.js";
import { spaceFor } from "./membership.js";
import { pushReady } from "./push.js";
import * as svc from "./service.js";

setEnricher(async (e) => (e.type === "message" ? await svc.presentById(e.id) : e));

export const teamChatRouter = Router();
teamChatRouter.use("/team-spaces", requireAuth, requireMfa, requireFlag(FLAG.teamChat, "teams.manage"));

const isAdmin = (req: Request) => req.ctx.access!.leagueWide.has("teams.manage");
const me = (req: Request) => req.ctx.auth!.user.id;

async function space(req: Request) {
  const s = await spaceFor(me(req), String(req.params.teamId), isAdmin(req));
  // Same answer for "no such team" and "not your team", so ids can't be probed.
  if (!s) throw new HttpError(404, "NOT_FOUND", "Team not found.");
  return s;
}

const view = z.enum(["feed", "chat", "staff"]);
const eventType = z.enum(["game", "practice"]);

teamChatRouter.get(
  "/team-spaces",
  handler(async (req, res) => {
    res.set("cache-control", "no-store");
    res.json({ items: await svc.mySpaces(me(req)), push: { available: pushReady() } });
  }),
);

/** One live stream for all of this person's teams. */
teamChatRouter.get(
  "/team-spaces/stream",
  handler(async (req, res) => {
    await openStream(me(req), res);
  }),
);

teamChatRouter.get(
  "/team-spaces/:teamId",
  handler(async (req, res) => {
    res.set("cache-control", "no-store");
    res.json(await svc.spaceDetail(await space(req)));
  }),
);

teamChatRouter.get(
  "/team-spaces/:teamId/messages",
  handler(async (req, res) => {
    const v = view.parse(req.query.view ?? "feed");
    res.set("cache-control", "no-store");
    res.json(await svc.listMessages(await space(req), v, typeof req.query.before === "string" ? req.query.before : undefined));
  }),
);

const postInput = z.object({
  view,
  body: z.string().trim().min(1, "Write a message first.").max(2000),
  alert: z.boolean().optional(),
  pin: z.boolean().optional(),
  eventType: eventType.optional(),
  eventId: z.uuid().optional(),
});
teamChatRouter.post(
  "/team-spaces/:teamId/messages",
  handler(async (req, res) => {
    res.status(201).json({ message: await svc.postMessage(me(req), await space(req), postInput.parse(req.body)) });
  }),
);

teamChatRouter.delete(
  "/team-spaces/:teamId/messages/:messageId",
  handler(async (req, res) => {
    const s = await space(req);
    await svc.deleteMessage(me(req), s, String(req.params.messageId));
    if (s.role === "admin") {
      await writeAudit(db, { actorUserId: me(req), action: "team_message.remove", targetType: "team_message", targetId: String(req.params.messageId), requestId: req.ctx.requestId, ipAddress: req.ctx.ip });
    }
    res.status(204).end();
  }),
);

teamChatRouter.post(
  "/team-spaces/:teamId/messages/:messageId/pin",
  handler(async (req, res) => {
    await svc.setPinned(await space(req), String(req.params.messageId), z.object({ pinned: z.boolean() }).parse(req.body).pinned);
    res.status(204).end();
  }),
);

teamChatRouter.post(
  "/team-spaces/:teamId/messages/:messageId/report",
  handler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(3, "Tell us briefly what's wrong.").max(500) }).parse(req.body);
    await svc.report(me(req), await space(req), String(req.params.messageId), reason);
    res.status(204).end();
  }),
);

teamChatRouter.post(
  "/team-spaces/:teamId/read",
  handler(async (req, res) => {
    await svc.markRead(me(req), await space(req), view.parse(req.body?.view));
    res.status(204).end();
  }),
);

teamChatRouter.put(
  "/team-spaces/:teamId/prefs",
  handler(async (req, res) => {
    await svc.setMuted(me(req), await space(req), z.object({ muted: z.boolean() }).parse(req.body).muted);
    res.status(204).end();
  }),
);

teamChatRouter.get(
  "/team-spaces/:teamId/events",
  handler(async (req, res) => {
    res.set("cache-control", "no-store");
    res.json({ items: await svc.events(await space(req)) });
  }),
);

const rsvpInput = z.object({ eventType, eventId: z.uuid(), playerId: z.uuid(), status: z.enum(["yes", "maybe", "no"]), note: z.string().trim().max(200).optional() });
teamChatRouter.put(
  "/team-spaces/:teamId/rsvp",
  handler(async (req, res) => {
    await svc.setRsvp(me(req), await space(req), rsvpInput.parse(req.body));
    res.status(204).end();
  }),
);

teamChatRouter.get(
  "/team-spaces/:teamId/events/:type/:eventId/rsvps",
  handler(async (req, res) => {
    res.set("cache-control", "no-store");
    res.json(await svc.eventRsvps(await space(req), eventType.parse(req.params.type), z.uuid().parse(req.params.eventId)));
  }),
);

teamChatRouter.post(
  "/team-spaces/:teamId/events/:type/:eventId/remind",
  handler(async (req, res) => {
    res.json(await svc.remindUnanswered(await space(req), eventType.parse(req.params.type), z.uuid().parse(req.params.eventId)));
  }),
);

/* ---------------- push sign-up ---------------- */

teamChatRouter.get(
  "/push/key",
  handler(async (_req, res) => {
    res.json({ publicKey: pushReady() ? env.VAPID_PUBLIC_KEY : null });
  }),
);

const subInput = z.object({
  endpoint: z.url().max(1000).refine((u) => u.startsWith("https://"), "Push endpoints use https."),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
});
teamChatRouter.post(
  "/push/subscriptions",
  requireAuth,
  handler(async (req, res) => {
    const s = subInput.parse(req.body);
    await db
      .insert(pushSubscriptions)
      .values({ userId: me(req), endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, userAgent: String(req.headers["user-agent"] ?? "").slice(0, 200) })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId: me(req), p256dh: s.keys.p256dh, auth: s.keys.auth } });
    res.status(204).end();
  }),
);
teamChatRouter.delete(
  "/push/subscriptions",
  requireAuth,
  handler(async (req, res) => {
    const { endpoint } = z.object({ endpoint: z.string().max(1000) }).parse(req.body);
    await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, me(req))));
    res.status(204).end();
  }),
);

/* ---------------- league admins: reported messages ---------------- */

export const adminTeamChatRouter = Router();
adminTeamChatRouter.use(requireAuth, requireMfa, adminIdleTimeout, requirePermission("teams.manage"));

adminTeamChatRouter.get(
  "/reports",
  handler(async (_req, res) => {
    res.set("cache-control", "no-store");
    res.json({ items: await svc.openReports() });
  }),
);

adminTeamChatRouter.post(
  "/reports/:reportId",
  handler(async (req, res) => {
    const { remove } = z.object({ remove: z.boolean() }).parse(req.body);
    await svc.resolveReport(me(req), String(req.params.reportId), remove);
    await writeAudit(db, { actorUserId: me(req), action: remove ? "team_message.remove" : "team_report.dismiss", targetType: "team_message_report", targetId: String(req.params.reportId), requestId: req.ctx.requestId, ipAddress: req.ctx.ip });
    res.status(204).end();
  }),
);
