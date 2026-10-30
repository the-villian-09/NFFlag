ALTER TABLE "registrations" ADD COLUMN "payment_request" jsonb;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "processing_started_at" timestamp with time zone;