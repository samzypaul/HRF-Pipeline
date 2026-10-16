CREATE TABLE "council_boundaries" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"district_name" text,
	"region_name" text,
	"properties" jsonb,
	"geom" geometry(MultiPolygon, 4326) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "village_boundaries" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" text,
	"name" text NOT NULL,
	"ward_name" text,
	"district_name" text,
	"region_name" text,
	"properties" jsonb,
	"geom" geometry(MultiPolygon, 4326) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_validation" ADD COLUMN "village_check" text;--> statement-breakpoint
ALTER TABLE "geo_validation" ADD COLUMN "boundary_village" text;--> statement-breakpoint
ALTER TABLE "geo_validation" ADD COLUMN "boundary_village_ward" text;--> statement-breakpoint
CREATE INDEX "council_boundaries_geom_idx" ON "council_boundaries" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "village_boundaries_geom_idx" ON "village_boundaries" USING gist ("geom");