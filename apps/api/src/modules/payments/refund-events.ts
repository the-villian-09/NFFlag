/**
 * Refund updates reported by a provider's webhook (Stripe or Square), applied
 * to our payments and refunds. Safe to repeat and safe to arrive before or
 * after the app's own record of the refund.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { payments, refunds } from "../../db/schema/index.js";

const failed = (s: string) => s === "FAILED" || s === "REJECTED";

export async function applyRefundEvent(r: {
  /** Provider's refund id. */
  id: string;
  /** Provider's payment id (Square payment / Stripe PaymentIntent). */
  paymentId: string;
  /** PENDING | COMPLETED | FAILED | REJECTED */
  status: string;
  amountCents: number;
  /** Reason recorded for a refund made outside the app (provider dashboard). */
  externalReason: string;
}) {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(refunds).where(eq(refunds.providerRefundId, r.id)).for("update");
    if (!row) {
      // Not (yet) recorded by the app: made in the provider's dashboard, or this event beat our own insert.
      const [p] = await tx.select().from(payments).where(eq(payments.providerPaymentId, r.paymentId)).for("update");
      if (!p || r.amountCents <= 0) return;
      const [ins] = await tx
        .insert(refunds)
        .values({ paymentId: p.id, providerRefundId: r.id, status: r.status, amountCents: r.amountCents, reason: r.externalReason })
        .onConflictDoNothing()
        .returning();
      if (ins && !failed(r.status)) {
        await tx
          .update(payments)
          .set({ refundedCents: sql`least(${payments.amountCents}, ${payments.refundedCents} + ${r.amountCents})`, updatedAt: new Date() })
          .where(eq(payments.id, p.id));
      }
      return;
    }
    if (row.status === r.status) return;
    await tx.update(refunds).set({ status: r.status, updatedAt: new Date() }).where(eq(refunds.id, row.id));
    // A refund the provider couldn't complete gives the money back to the payment's refundable balance.
    if (failed(r.status) && !failed(row.status)) {
      await tx
        .update(payments)
        .set({ refundedCents: sql`greatest(0, ${payments.refundedCents} - ${row.amountCents})`, updatedAt: new Date() })
        .where(eq(payments.id, row.paymentId));
    }
  });
}
