CREATE TABLE "satellite_checks" (
	"facility_code" text PRIMARY KEY NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"source" text,
	"model" text,
	"zoom" smallint,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "satellite_checks" ADD CONSTRAINT "satellite_checks_facility_code_facilities_facility_code_fk" FOREIGN KEY ("facility_code") REFERENCES "public"."facilities"("facility_code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "satellite_checks_status_idx" ON "satellite_checks" USING btree ("status");--> statement-breakpoint
-- A village centre is graded medium now (the point is in the right village, though not on the building): bring the stored grades in line.
UPDATE "geo_validation" SET "confidence" = 'medium'
WHERE "geocode_source" = 'village_centroid' AND "confidence" = 'low';
