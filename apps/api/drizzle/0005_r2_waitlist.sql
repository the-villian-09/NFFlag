CREATE TABLE "waitlist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_id" uuid NOT NULL,
	"division_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"created_by" text,
	"status" text DEFAULT 'waiting' NOT NULL,
	"offered_at" timestamp with time zone,
	"offer_expires_at" timestamp with time zone,
	"registration_id" uuid,
	"removed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_division_id_divisions_id_fk" FOREIGN KEY ("division_id") REFERENCES "public"."divisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "waitlist_division_status_idx" ON "waitlist_entries" USING btree ("division_id","status","created_at");--> statement-breakpoint
CREATE INDEX "waitlist_household_idx" ON "waitlist_entries" USING btree ("household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_one_active_per_player" ON "waitlist_entries" USING btree ("season_id","player_id") WHERE "waitlist_entries"."status" in ('waiting','offered');