CREATE TABLE "promo_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"value" integer NOT NULL,
	"applies_to" text DEFAULT 'registration' NOT NULL,
	"season_id" uuid,
	"division_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_uses" integer,
	"one_per_family" boolean DEFAULT false NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_kind" CHECK ("promo_codes"."kind" in ('percent','amount')),
	CONSTRAINT "promo_value" CHECK (("promo_codes"."kind" = 'percent' and "promo_codes"."value" between 1 and 100) or ("promo_codes"."kind" = 'amount' and "promo_codes"."value" > 0)),
	CONSTRAINT "promo_applies" CHECK ("promo_codes"."applies_to" in ('registration','staff','both'))
);
--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "promo_code_id" uuid;--> statement-breakpoint
ALTER TABLE "volunteer_applications" ADD COLUMN "discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "volunteer_applications" ADD COLUMN "promo_code_id" uuid;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "promo_code_unique" ON "promo_codes" USING btree ("code");--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_promo_code_id_promo_codes_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_applications" ADD CONSTRAINT "volunteer_applications_promo_code_id_promo_codes_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE no action ON UPDATE no action;