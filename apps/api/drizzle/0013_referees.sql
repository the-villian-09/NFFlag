CREATE TABLE "game_officials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'assigned' NOT NULL,
	"source" text DEFAULT 'assigned' NOT NULL,
	"rate_cents" integer NOT NULL,
	"payout_id" uuid,
	"assigned_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_officials_status" CHECK ("game_officials"."status" in ('assigned','worked','no_show','removed')),
	CONSTRAINT "game_officials_rate" CHECK ("game_officials"."rate_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "referee_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"stripe_account_id" text NOT NULL,
	"environment" text NOT NULL,
	"details_submitted" boolean DEFAULT false NOT NULL,
	"transfers_active" boolean DEFAULT false NOT NULL,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"requirements_due" integer DEFAULT 0 NOT NULL,
	"disabled_reason" text,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referee_accounts_stripe_account_id_unique" UNIQUE("stripe_account_id")
);
--> statement-breakpoint
CREATE TABLE "referee_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"phone" text NOT NULL,
	"birth_date" date NOT NULL,
	"experience" text,
	"certification" text NOT NULL,
	"certification_expires_on" date,
	"certification_verified_by" text,
	"certification_verified_at" timestamp with time zone,
	"status" text DEFAULT 'submitted' NOT NULL,
	"screening_status" text DEFAULT 'not_started' NOT NULL,
	"screening_provider" text,
	"screening_completed_on" date,
	"screening_expires_on" date,
	"screening_notes" text,
	"screening_updated_by" text,
	"screening_updated_at" timestamp with time zone,
	"decision_reason" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ref_app_status" CHECK ("referee_applications"."status" in ('submitted','approved','rejected','withdrawn','revoked'))
);
--> statement-breakpoint
CREATE TABLE "referee_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"environment" text NOT NULL,
	"stripe_transfer_id" text,
	"idempotency_key" text NOT NULL,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"approved_by" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referee_payouts_stripe_transfer_id_unique" UNIQUE("stripe_transfer_id"),
	CONSTRAINT "ref_payouts_status" CHECK ("referee_payouts"."status" in ('pending','paid','failed','void')),
	CONSTRAINT "ref_payouts_amount" CHECK ("referee_payouts"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "divisions" ADD COLUMN "referee_rate_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "referee_slots" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "game_officials" ADD CONSTRAINT "game_officials_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_officials" ADD CONSTRAINT "game_officials_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_officials" ADD CONSTRAINT "game_officials_payout_id_referee_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."referee_payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_officials" ADD CONSTRAINT "game_officials_assigned_by_user_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referee_accounts" ADD CONSTRAINT "referee_accounts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referee_applications" ADD CONSTRAINT "referee_applications_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referee_applications" ADD CONSTRAINT "referee_applications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referee_applications" ADD CONSTRAINT "referee_applications_certification_verified_by_user_id_fk" FOREIGN KEY ("certification_verified_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referee_applications" ADD CONSTRAINT "referee_applications_screening_updated_by_user_id_fk" FOREIGN KEY ("screening_updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referee_applications" ADD CONSTRAINT "referee_applications_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referee_payouts" ADD CONSTRAINT "referee_payouts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referee_payouts" ADD CONSTRAINT "referee_payouts_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_officials_one" ON "game_officials" USING btree ("game_id","user_id") WHERE "game_officials"."status" <> 'removed';--> statement-breakpoint
CREATE INDEX "game_officials_user_idx" ON "game_officials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "game_officials_payout_idx" ON "game_officials" USING btree ("payout_id");--> statement-breakpoint
CREATE INDEX "ref_app_season_status_idx" ON "referee_applications" USING btree ("season_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ref_app_one_active" ON "referee_applications" USING btree ("season_id","user_id") WHERE "referee_applications"."status" in ('submitted','approved');--> statement-breakpoint
CREATE INDEX "ref_payouts_user_idx" ON "referee_payouts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ref_payouts_status_idx" ON "referee_payouts" USING btree ("status");