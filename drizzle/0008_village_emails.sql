ALTER TABLE "geo_validation" ADD COLUMN "village_emailed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "geo_validation" ADD COLUMN "village_emailed_lat" double precision;--> statement-breakpoint
ALTER TABLE "geo_validation" ADD COLUMN "village_emailed_lng" double precision;