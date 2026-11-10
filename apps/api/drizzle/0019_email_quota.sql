CREATE TABLE "email_quota" (
	"address" text NOT NULL,
	"kind" text NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "email_quota_address_kind_day_pk" PRIMARY KEY("address","kind","day")
);
