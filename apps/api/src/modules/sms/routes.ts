/**
 * NFFL Text Alerts opt-in.
 *   GET /me/sms   the signed-in person's number and whether they get texts
 *   PUT /me/sms   { phone, subscribe } — ticking the box records consent (time, wording version, IP)
 *
 * Sending (Twilio) comes once the carrier registration is approved; STOP
 * replies will mark the number stopped here.
 */
import { SMS_CONSENT_TEXT, SMS_CONSENT_VERSION, smsPrefInput, toE164 } from "@nffl/shared";
import { eq } from "drizzle-orm";
import { Router } from "express";
import { db } from "../../db/client.js";
import { smsSubscriptions } from "../../db/schema/index.js";
import { handler, requireAuth, requireMfa } from "../../http/context.js";
import { HttpError } from "../../http/errors.js";
import { writeAudit } from "../platform/audit.js";

export const smsRouter = Router();

type Row = typeof smsSubscriptions.$inferSelect;
const view = (r: Row | undefined) => ({
  phone: r?.phone ?? null,
  subscribed: r?.status === "subscribed",
  consentAt: r?.status === "subscribed" ? r.consentAt : null,
  stoppedVia: r?.status === "stopped" ? r.stoppedVia : null,
  consentText: SMS_CONSENT_TEXT,
});

smsRouter.get(
  "/me/sms",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    const [r] = await db.select().from(smsSubscriptions).where(eq(smsSubscriptions.userId, req.ctx.auth!.user.id));
    res.set("cache-control", "no-store");
    res.json(view(r));
  }),
);

smsRouter.put(
  "/me/sms",
  requireAuth,
  requireMfa,
  handler(async (req, res) => {
    const input = smsPrefInput.parse(req.body);
    const userId = req.ctx.auth!.user.id;
    const phone = input.phone ? toE164(input.phone) : null;
    if (input.subscribe && !phone) throw new HttpError(400, "VALIDATION_FAILED", "Enter a 10-digit US mobile number.");
    if (input.phone && !phone) throw new HttpError(400, "VALIDATION_FAILED", "Enter a 10-digit US mobile number.");
    const now = new Date();
    const row = await db.transaction(async (tx) => {
      const [before] = await tx.select().from(smsSubscriptions).where(eq(smsSubscriptions.userId, userId)).for("update");
      let next: Partial<Row>;
      if (input.subscribe) {
        // A new opt-in (or a new number) records fresh consent.
        const fresh = before?.status !== "subscribed" || before.phone !== phone;
        next = fresh
          ? { phone: phone!, status: "subscribed", consentAt: now, consentVersion: SMS_CONSENT_VERSION, consentIp: req.ctx.ip ?? null, stoppedAt: null, stoppedVia: null }
          : { phone: phone! };
      } else {
        if (!before) return undefined;
        next = { ...(phone ? { phone } : {}), ...(before.status === "subscribed" ? { status: "stopped", stoppedAt: now, stoppedVia: "account" } : {}) };
      }
      const [after] = await tx
        .insert(smsSubscriptions)
        .values({ userId, phone: phone ?? before?.phone ?? "", status: "stopped", ...next, updatedAt: now })
        .onConflictDoUpdate({ target: smsSubscriptions.userId, set: { ...next, updatedAt: now } })
        .returning();
      if (before?.status !== after!.status || before?.phone !== after!.phone) {
        await writeAudit(tx, {
          actorUserId: userId,
          action: after!.status === "subscribed" ? "sms.subscribe" : "sms.unsubscribe",
          targetType: "sms_subscription",
          targetId: userId,
          before: before ? { phone: before.phone, status: before.status } : null,
          after: { phone: after!.phone, status: after!.status, consentVersion: after!.consentVersion },
          requestId: req.ctx.requestId,
          ipAddress: req.ctx.ip,
        });
      }
      return after;
    });
    res.json(view(row));
  }),
);
