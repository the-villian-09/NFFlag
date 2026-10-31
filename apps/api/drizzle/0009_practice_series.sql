ALTER TABLE "practices" ADD COLUMN "series_id" uuid;--> statement-breakpoint
CREATE INDEX "practices_series_idx" ON "practices" USING btree ("series_id");