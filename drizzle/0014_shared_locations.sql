ALTER TABLE "geo_validation" ADD COLUMN "shared_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "geo_validation" ADD COLUMN "shared_with" text;--> statement-breakpoint
ALTER TABLE "geo_validation" ADD COLUMN "shared_emailed_with" text;