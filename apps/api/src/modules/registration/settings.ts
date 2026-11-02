/**
 * Payment settings the league changes from Admin → Payments (stored in
 * site_settings under "payments"): who pays the card processing fee, the fee
 * rate used to pass it on, and how long a spot is held during checkout.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, type DbOrTx } from "../../db/client.js";
import { siteSettings } from "../../db/schema/index.js";

export const paymentSettingsSchema = z.object({
  /** Who takes card payments: Stripe (main) or Square (backup). Only a Super Admin changes it. */
  provider: z.enum(["stripe", "square"]).default("stripe"),
  /** "league": families pay the division price and the league absorbs the card fee. "parent": a processing fee is added at checkout. */
  feeMode: z.enum(["league", "parent"]),
  /** The provider's online card rate, in basis points (290 = 2.9%). Only used when feeMode = "parent". */
  feePercentBps: z.number().int().min(0).max(1000),
  /** The provider's fixed per-payment fee in cents (30 = $0.30). */
  feeFixedCents: z.number().int().min(0).max(500),
  /** Minutes a spot is held while a family pays (D-04). */
  holdMinutes: z.number().int().min(5).max(120),
  /** Hours a waitlisted family has to claim an offered spot (R2). */
  offerHours: z.number().int().min(1).max(168).default(48),
  /** Volunteer fees in cents, paid when applying (R2). The flyer: coaching badge $25, team mom $25. */
  volunteerFees: z
    .object({
      head_coach: z.number().int().min(0).max(100_000),
      assistant_coach: z.number().int().min(0).max(100_000),
      team_manager: z.number().int().min(0).max(100_000),
    })
    .default({ head_coach: 2500, assistant_coach: 2500, team_manager: 2500 }),
});
export type PaymentSettings = z.infer<typeof paymentSettingsSchema>;

export const DEFAULT_PAYMENT_SETTINGS: PaymentSettings = {
  provider: "stripe",
  feeMode: "league",
  feePercentBps: 290,
  feeFixedCents: 30,
  holdMinutes: 15,
  offerHours: 48,
  volunteerFees: { head_coach: 2500, assistant_coach: 2500, team_manager: 2500 },
};

export async function getPaymentSettings(conn: DbOrTx = db): Promise<PaymentSettings> {
  const [row] = await conn.select().from(siteSettings).where(eq(siteSettings.key, "payments"));
  const parsed = paymentSettingsSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : DEFAULT_PAYMENT_SETTINGS;
}

export async function seedPaymentSettings(conn: DbOrTx = db) {
  await conn.insert(siteSettings).values({ key: "payments", value: DEFAULT_PAYMENT_SETTINGS }).onConflictDoNothing();
}

/**
 * Price breakdown for one registration. When families pay the fee, the total is
 * grossed up so that after the card percentage + fixed fee the league still
 * receives the full division price.
 */
export function quote(priceCents: number, s: Pick<PaymentSettings, "feeMode" | "feePercentBps" | "feeFixedCents">) {
  if (s.feeMode === "league" || priceCents === 0) return { priceCents, feeCents: 0, totalCents: priceCents };
  const rate = s.feePercentBps / 10_000;
  const totalCents = Math.ceil((priceCents + s.feeFixedCents) / (1 - rate));
  return { priceCents, feeCents: totalCents - priceCents, totalCents };
}
