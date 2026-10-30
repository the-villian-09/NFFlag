/**
 * Square account connection (Admin → Payments) and webhooks.
 *
 *   POST /api/v1/admin/payments/square/connect     → Square OAuth URL (Super Admin)
 *   GET  /api/v1/square/oauth/callback             ← Square redirects here
 *   POST /api/v1/admin/payments/square/disconnect  → revoke at Square, forget tokens
 *   POST /api/v1/webhooks/square                   ← payment, refund and revocation events
 */
import { and, eq, gt, sql } from "drizzle-orm";
import express, { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { env } from "../../config.js";
import { db } from "../../db/client.js";
import { payments, refunds, squareConnection, squareOauthStates, squareWebhookEvents, user } from "../../db/schema/index.js";
import { adminIdleTimeout, handler, requireAuth, requireMfa, requirePermission } from "../../http/context.js";
import { HttpError } from "../../http/errors.js";
import { encryptSecret } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import { can } from "../platform/access.js";
import { writeAudit } from "../platform/audit.js";
import { publish } from "../platform/outbox.js";
import { recordCompletedPayment } from "../registration/service.js";
import { getPaymentSettings } from "../registration/settings.js";
import {
  authorizeUrl,
  exchangeCode,
  getCredentials,
  getMerchantAndMainLocation,
  oauthConfigured,
  oauthRedirectUrl,
  revokeMerchant,
  SquareError,
  verifyWebhookSignature,
  webhookUrl,
  type SquarePayment,
} from "./client.js";

/* ---------------- admin ---------------- */

export const adminPaymentsRouter = Router();
adminPaymentsRouter.use(requireAuth, requireMfa, adminIdleTimeout);

adminPaymentsRouter.get(
  "/",
  requirePermission("payments.read"),
  handler(async (_req, res) => {
    const [conn] = await db
      .select({
        environment: squareConnection.environment,
        merchantId: squareConnection.merchantId,
        merchantName: squareConnection.merchantName,
        locationId: squareConnection.locationId,
        locationName: squareConnection.locationName,
        connectedAt: squareConnection.connectedAt,
        accessTokenExpiresAt: squareConnection.accessTokenExpiresAt,
        lastRefreshError: squareConnection.lastRefreshError,
        connectedByName: user.name,
      })
      .from(squareConnection)
      .leftJoin(user, eq(user.id, squareConnection.connectedBy))
      .where(eq(squareConnection.id, "default"));
    const creds = await getCredentials().catch(() => null);
    res.json({
      settings: await getPaymentSettings(),
      square: {
        environment: env.SQUARE_ENVIRONMENT,
        oauthConfigured: oauthConfigured(),
        webhookConfigured: !!env.SQUARE_WEBHOOK_SIGNATURE_KEY,
        redirectUrl: oauthRedirectUrl(),
        webhookUrl: webhookUrl(),
        connection: conn ?? null,
        /** Taking payments right now, and with what. */
        active: creds ? { source: creds.source, locationId: creds.locationId } : null,
      },
    });
  }),
);

adminPaymentsRouter.post(
  "/square/connect",
  requirePermission("platform.settings.manage"),
  handler(async (req, res) => {
    if (!oauthConfigured()) {
      throw new HttpError(409, "CONFLICT", "The Square app credentials aren't set up on the server yet.");
    }
    const state = randomBytes(24).toString("base64url");
    await db.delete(squareOauthStates).where(sql`${squareOauthStates.createdAt} < now() - interval '1 hour'`);
    await db.insert(squareOauthStates).values({ state, userId: req.ctx.auth!.user.id });
    res.json({ url: authorizeUrl(state) });
  }),
);

adminPaymentsRouter.post(
  "/square/disconnect",
  requirePermission("platform.settings.manage"),
  handler(async (req, res) => {
    const input = z.object({ confirm: z.literal("DISCONNECT"), reason: z.string().trim().max(300).optional() }).parse(req.body);
    const [conn] = await db.select().from(squareConnection).where(eq(squareConnection.id, "default"));
    if (!conn) throw new HttpError(404, "NOT_FOUND", "No Square account is connected.");
    let revokedAtSquare = true;
    try {
      await revokeMerchant(conn.merchantId);
    } catch (err) {
      // Already revoked from the Square dashboard is fine; anything else is reported but the tokens are still deleted.
      revokedAtSquare = false;
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Square revoke failed during disconnect");
    }
    await db.transaction(async (tx) => {
      await tx.delete(squareConnection).where(eq(squareConnection.id, "default"));
      await writeAudit(tx, {
        actorUserId: req.ctx.auth!.user.id,
        action: "square.disconnect",
        targetType: "square_connection",
        targetId: conn.merchantId,
        before: { merchantId: conn.merchantId, merchantName: conn.merchantName, locationId: conn.locationId },
        after: { revokedAtSquare },
        reason: input.reason ?? null,
        requestId: req.ctx.requestId,
        ipAddress: req.ctx.ip,
      });
      await publish(tx, {
        name: "square.disconnected",
        aggregateType: "square_connection",
        aggregateId: conn.merchantId,
        payload: { by: req.ctx.auth!.user.name, merchantName: conn.merchantName, reason: input.reason ?? null, source: "admin" },
      });
    });
    res.json({ ok: true, revokedAtSquare });
  }),
);

/* ---------------- OAuth callback ---------------- */

export const squareCallbackRouter = Router();

squareCallbackRouter.get(
  "/square/oauth/callback",
  handler(async (req, res) => {
    const back = (result: string) => res.redirect(302, `${env.APP_BASE_URL.replace(/\/$/, "")}/admin/payments?square=${result}`);
    const q = z
      .object({ code: z.string().max(500).optional(), state: z.string().max(100).optional(), error: z.string().max(100).optional() })
      .parse(req.query);
    if (q.error) return back(q.error === "access_denied" ? "cancelled" : "error");
    if (!q.code || !q.state) return back("error");
    const [st] = await db
      .delete(squareOauthStates)
      .where(and(eq(squareOauthStates.state, q.state), gt(squareOauthStates.createdAt, sql`now() - interval '15 minutes'`)))
      .returning();
    const me = req.ctx.auth?.user;
    if (!st || !me || st.userId !== me.id || !req.ctx.access || !can(req.ctx.access, "platform.settings.manage")) {
      return back("expired");
    }
    try {
      const t = await exchangeCode(q.code);
      const info = await getMerchantAndMainLocation(t.access_token);
      if (!info.locationId) return back("no_location");
      const row = {
        environment: env.SQUARE_ENVIRONMENT,
        merchantId: t.merchant_id,
        merchantName: info.merchantName,
        locationId: info.locationId,
        locationName: info.locationName,
        accessTokenEnc: encryptSecret(t.access_token),
        refreshTokenEnc: t.refresh_token ? encryptSecret(t.refresh_token) : null,
        accessTokenExpiresAt: t.expires_at ? new Date(t.expires_at) : null,
        scopes: "PAYMENTS_WRITE PAYMENTS_READ MERCHANT_PROFILE_READ",
        connectedBy: me.id,
        connectedAt: new Date(),
        lastRefreshedAt: null,
        lastRefreshError: null,
      };
      await db.transaction(async (tx) => {
        await tx.insert(squareConnection).values({ id: "default", ...row }).onConflictDoUpdate({ target: squareConnection.id, set: row });
        await writeAudit(tx, {
          actorUserId: me.id,
          action: "square.connect",
          targetType: "square_connection",
          targetId: t.merchant_id,
          after: { merchantId: t.merchant_id, merchantName: info.merchantName, locationId: info.locationId, environment: env.SQUARE_ENVIRONMENT },
          requestId: req.ctx.requestId,
          ipAddress: req.ctx.ip,
        });
        await publish(tx, { name: "square.connected", aggregateType: "square_connection", aggregateId: t.merchant_id });
      });
      return back("connected");
    } catch (err) {
      logger.error({ err: err instanceof SquareError ? err.errors : String(err) }, "Square OAuth exchange failed");
      return back("error");
    }
  }),
);

/* ---------------- webhooks ---------------- */

interface WebhookEvent {
  event_id: string;
  merchant_id?: string;
  type: string;
  data?: { object?: { payment?: SquarePayment; refund?: { id: string; status: string; payment_id: string } } };
}

/** Mount before express.json(): the signature covers the exact raw body. */
export const squareWebhook = [
  express.raw({ type: "*/*", limit: "1mb" }),
  handler(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    if (!verifyWebhookSignature(raw, req.header("x-square-hmacsha256-signature"))) {
      throw new HttpError(403, "FORBIDDEN", "Invalid signature.");
    }
    const event = JSON.parse(raw) as WebhookEvent;
    const [fresh] = await db
      .insert(squareWebhookEvents)
      .values({ eventId: event.event_id, eventType: event.type })
      .onConflictDoNothing()
      .returning();
    if (!fresh) {
      res.json({ ok: true, duplicate: true });
      return;
    }
    try {
      await handleEvent(event);
    } catch (err) {
      // Let Square retry: forget the event id.
      await db.delete(squareWebhookEvents).where(eq(squareWebhookEvents.eventId, event.event_id));
      throw err;
    }
    res.json({ ok: true });
  }),
];

async function handleEvent(event: WebhookEvent) {
  const [conn] = await db.select().from(squareConnection).where(eq(squareConnection.id, "default"));
  // Only act on events for the account we charge (or the Sandbox fallback account when none is connected).
  const ours = !conn || !event.merchant_id || event.merchant_id === conn.merchantId;

  if (event.type === "oauth.authorization.revoked") {
    if (!conn || event.merchant_id !== conn.merchantId) return;
    await db.transaction(async (tx) => {
      await tx.delete(squareConnection).where(eq(squareConnection.id, "default"));
      await writeAudit(tx, {
        actorUserId: null,
        action: "square.revoked",
        targetType: "square_connection",
        targetId: conn.merchantId,
        before: { merchantId: conn.merchantId, merchantName: conn.merchantName },
        reason: "Access was revoked from the Square dashboard",
      });
      await publish(tx, {
        name: "square.disconnected",
        aggregateType: "square_connection",
        aggregateId: conn.merchantId,
        payload: { by: null, merchantName: conn.merchantName, reason: "Access was revoked from the Square dashboard", source: "square" },
      });
    });
    return;
  }
  if (!ours) return;

  if (event.type === "payment.created" || event.type === "payment.updated") {
    const p = event.data?.object?.payment;
    if (!p?.reference_id) return;
    if (p.status === "COMPLETED" || p.status === "APPROVED") {
      await recordCompletedPayment(p, { environment: env.SQUARE_ENVIRONMENT, merchantId: event.merchant_id ?? null }, { userId: null });
    } else {
      await db.update(payments).set({ status: p.status, updatedAt: new Date() }).where(eq(payments.providerPaymentId, p.id));
    }
    return;
  }

  if (event.type === "refund.created" || event.type === "refund.updated") {
    const r = event.data?.object?.refund;
    if (!r) return;
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(refunds).where(eq(refunds.providerRefundId, r.id)).for("update");
      if (!row || row.status === r.status) return;
      await tx.update(refunds).set({ status: r.status, updatedAt: new Date() }).where(eq(refunds.id, row.id));
      // A refund Square couldn't complete gives the money back to the payment's refundable balance.
      const failed = (s: string) => s === "FAILED" || s === "REJECTED";
      if (failed(r.status) && !failed(row.status)) {
        await tx
          .update(payments)
          .set({ refundedCents: sql`greatest(0, ${payments.refundedCents} - ${row.amountCents})`, updatedAt: new Date() })
          .where(eq(payments.id, row.paymentId));
      }
    });
  }
}
