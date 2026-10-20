CREATE TABLE "climate_services" (
	"code" text PRIMARY KEY NOT NULL,
	"tier" smallint NOT NULL,
	"category_key" text NOT NULL,
	"tier_en" text NOT NULL,
	"tier_sw" text NOT NULL,
	"category_en" text NOT NULL,
	"category_sw" text NOT NULL,
	"name_en" text NOT NULL,
	"name_sw" text NOT NULL,
	"desc_en" text NOT NULL,
	"desc_sw" text NOT NULL,
	"rationale" text NOT NULL,
	"source" text NOT NULL,
	"confidence" text NOT NULL,
	"mapping_note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facility_climate_services" (
	"facility_code" text NOT NULL,
	"service_code" text NOT NULL,
	"tier" smallint NOT NULL,
	CONSTRAINT "facility_climate_services_facility_code_service_code_pk" PRIMARY KEY("facility_code","service_code")
);
--> statement-breakpoint
ALTER TABLE "facility_climate_services" ADD CONSTRAINT "facility_climate_services_facility_code_facilities_facility_code_fk" FOREIGN KEY ("facility_code") REFERENCES "public"."facilities"("facility_code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "facility_climate_service_idx" ON "facility_climate_services" USING btree ("service_code");--> statement-breakpoint
CREATE INDEX "facility_climate_tier_idx" ON "facility_climate_services" USING btree ("tier");