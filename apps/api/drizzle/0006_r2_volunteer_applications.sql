CREATE TABLE "volunteer_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role_key" text NOT NULL,
	"preferred_division_id" uuid,
	"player_id" uuid,
	"phone" text NOT NULL,
	"experience" text,
	"notes" text,
	"shirt_size" text,
	"agreements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending_payment' NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"processing_fee_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"payment_request" jsonb,
	"processing_started_at" timestamp with time zone,
	"payment_error" text,
	"paid_at" timestamp with time zone,
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
	"role_assignment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "va_role" CHECK ("volunteer_applications"."role_key" in ('head_coach','assistant_coach','team_manager'))
);
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "registration_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "application_id" uuid;--> statement-breakpoint
ALTER TABLE "volunteer_applications" ADD CONSTRAINT "volunteer_applications_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_applications" ADD CONSTRAINT "volunteer_applications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_applications" ADD CONSTRAINT "volunteer_applications_preferred_division_id_divisions_id_fk" FOREIGN KEY ("preferred_division_id") REFERENCES "public"."divisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_applications" ADD CONSTRAINT "volunteer_applications_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_applications" ADD CONSTRAINT "volunteer_applications_screening_updated_by_user_id_fk" FOREIGN KEY ("screening_updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_applications" ADD CONSTRAINT "volunteer_applications_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "va_season_status_idx" ON "volunteer_applications" USING btree ("season_id","status");--> statement-breakpoint
CREATE INDEX "va_user_idx" ON "volunteer_applications" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "va_one_active_per_role" ON "volunteer_applications" USING btree ("season_id","user_id","role_key") WHERE "volunteer_applications"."status" in ('pending_payment','processing','submitted','approved');--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_application_id_volunteer_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."volunteer_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_app_idx" ON "payments" USING btree ("application_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_one_owner" CHECK (("payments"."registration_id" is null) <> ("payments"."application_id" is null));