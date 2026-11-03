ALTER TABLE "payments" ADD COLUMN "auto_refund_reason" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "auto_refund_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referee_payouts" ADD COLUMN "sending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_idempotency_key" ON "refunds" USING btree ("idempotency_key");