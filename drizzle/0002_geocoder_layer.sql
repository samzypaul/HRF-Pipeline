CREATE TABLE "ward_suggestions" (
	"ward_code" text PRIMARY KEY NOT NULL,
	"boundary_id" integer,
	"lat" double precision,
	"lng" double precision,
	"query" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_validation" ADD COLUMN "ward_name_check" text;--> statement-breakpoint
ALTER TABLE "geo_validation" ADD COLUMN "ward_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "geo_validation" ADD COLUMN "ward_check_lat" double precision;--> statement-breakpoint
ALTER TABLE "geo_validation" ADD COLUMN "ward_check_lng" double precision;