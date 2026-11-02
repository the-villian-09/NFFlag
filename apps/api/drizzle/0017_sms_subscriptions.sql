CREATE TABLE "sms_subscriptions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"status" text NOT NULL,
	"consent_at" timestamp with time zone,
	"consent_version" text,
	"consent_ip" text,
	"stopped_via" text,
	"stopped_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sms_subscriptions" ADD CONSTRAINT "sms_subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sms_subscriptions_phone" ON "sms_subscriptions" USING btree ("phone");