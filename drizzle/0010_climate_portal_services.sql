-- The climate tables now hold the real HFR services, not renamed ones: clear the old derived data (it is rebuilt from facility_services).
DELETE FROM "facility_climate_services";--> statement-breakpoint
DELETE FROM "climate_services";--> statement-breakpoint
CREATE TABLE "service_translations" (
	"category" text NOT NULL,
	"description" text NOT NULL,
	"category_sw" text,
	"description_sw" text,
	"needs_review" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_translations_category_description_pk" PRIMARY KEY("category","description")
);
--> statement-breakpoint
ALTER TABLE "climate_services" DROP COLUMN "category_key";