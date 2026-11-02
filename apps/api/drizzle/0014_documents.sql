CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"player_id" uuid,
	"user_id" text,
	"season_id" uuid,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by" text,
	"replaced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "documents_kind" CHECK ("documents"."kind" in ('birth_certificate','insurance_card','player_photo','staff_photo')),
	CONSTRAINT "documents_owner" CHECK (("documents"."kind" = 'staff_photo' and "documents"."user_id" is not null and "documents"."player_id" is null) or ("documents"."kind" <> 'staff_photo' and "documents"."player_id" is not null and "documents"."user_id" is null)),
	CONSTRAINT "documents_season" CHECK (("documents"."kind" = 'birth_certificate') = ("documents"."season_id" is null))
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_player_idx" ON "documents" USING btree ("player_id","kind");--> statement-breakpoint
CREATE INDEX "documents_user_idx" ON "documents" USING btree ("user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_one_current" ON "documents" USING btree ("kind",coalesce("player_id"::text, "user_id"),coalesce("season_id"::text, '')) WHERE "documents"."replaced_at" is null;