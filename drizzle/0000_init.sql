CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE TABLE "admin_units" (
	"code" text PRIMARY KEY NOT NULL,
	"level" integer NOT NULL,
	"name" text NOT NULL,
	"parent_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_usage" (
	"provider" text NOT NULL,
	"month" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "api_usage_provider_month_pk" PRIMARY KEY("provider","month")
);
--> statement-breakpoint
CREATE TABLE "facilities" (
	"facility_code" text PRIMARY KEY NOT NULL,
	"hfr_id" integer,
	"name" text NOT NULL,
	"common_name" text,
	"facility_type" text,
	"zone" text,
	"region_name" text,
	"district_name" text,
	"council_name" text,
	"ward_name" text,
	"village_name" text,
	"region_code" text,
	"council_code" text,
	"ward_code" text,
	"ownership_category" text,
	"ownership_authority" text,
	"ownership_details" text,
	"moh_authority" text,
	"operating_status" text,
	"registration_status" text,
	"date_opened" text,
	"phone" text,
	"website" text,
	"nearest_facility" text,
	"ctc_id" text,
	"msd_id" text,
	"mtuha_id" text,
	"hfr_lat" double precision,
	"hfr_lng" double precision,
	"geom" geometry(Point, 4326),
	"list_hash" text,
	"detail_hash" text,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_detail_at" timestamp with time zone,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "facility_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"facility_code" text NOT NULL,
	"change_type" text NOT NULL,
	"field_diffs" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facility_services" (
	"id" serial PRIMARY KEY NOT NULL,
	"facility_code" text NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facility_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"facility_code" text NOT NULL,
	"data" jsonb NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geo_validation" (
	"facility_code" text PRIMARY KEY NOT NULL,
	"has_boundary" boolean,
	"in_ward" boolean,
	"in_council" boolean,
	"distance_to_ward_m" double precision,
	"sanity_flags" text[],
	"match_source" text,
	"matched_name" text,
	"name_score" real,
	"match_distance_m" double precision,
	"osm_id" text,
	"google_place_id" text,
	"google_checked_at" timestamp with time zone,
	"geocode_source" text,
	"final_lat" double precision,
	"final_lng" double precision,
	"confidence" text,
	"notes" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"phase" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_tasks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "list_rows" (
	"run_id" integer NOT NULL,
	"facility_code" text NOT NULL,
	"hfr_id" integer,
	"data" jsonb NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "list_rows_run_id_facility_code_pk" PRIMARY KEY("run_id","facility_code")
);
--> statement-breakpoint
CREATE TABLE "osm_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_decisions" (
	"facility_code" text PRIMARY KEY NOT NULL,
	"decision" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"note" text,
	"reviewer" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_lease" (
	"id" integer PRIMARY KEY NOT NULL,
	"holder" text,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ward_boundaries" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" text,
	"name" text NOT NULL,
	"district_name" text,
	"region_name" text,
	"properties" jsonb,
	"geom" geometry(MultiPolygon, 4326) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ward_crosswalk" (
	"ward_code" text PRIMARY KEY NOT NULL,
	"boundary_id" integer NOT NULL,
	"method" text NOT NULL,
	"score" real,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ward_rows" (
	"run_id" integer NOT NULL,
	"facility_code" text NOT NULL,
	"ward_code" text NOT NULL,
	CONSTRAINT "ward_rows_run_id_facility_code_pk" PRIMARY KEY("run_id","facility_code")
);
--> statement-breakpoint
CREATE TABLE "weekly_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"summary_md" text,
	"anomalies" jsonb,
	"review_list" jsonb,
	"digest" jsonb,
	"model" text,
	"verified" boolean DEFAULT false NOT NULL,
	"verification" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"emailed_at" timestamp with time zone,
	CONSTRAINT "weekly_reports_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE INDEX "admin_units_parent_idx" ON "admin_units" USING btree ("parent_code");--> statement-breakpoint
CREATE INDEX "admin_units_level_idx" ON "admin_units" USING btree ("level");--> statement-breakpoint
CREATE INDEX "facilities_ward_idx" ON "facilities" USING btree ("ward_code");--> statement-breakpoint
CREATE INDEX "facilities_council_idx" ON "facilities" USING btree ("council_code");--> statement-breakpoint
CREATE INDEX "facilities_region_idx" ON "facilities" USING btree ("region_code");--> statement-breakpoint
CREATE INDEX "facilities_geom_idx" ON "facilities" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "facility_changes_run_idx" ON "facility_changes" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "facility_changes_code_idx" ON "facility_changes" USING btree ("facility_code");--> statement-breakpoint
CREATE UNIQUE INDEX "facility_services_uq" ON "facility_services" USING btree ("facility_code","category","description");--> statement-breakpoint
CREATE INDEX "facility_snapshots_code_idx" ON "facility_snapshots" USING btree ("facility_code");--> statement-breakpoint
CREATE INDEX "geo_validation_conf_idx" ON "geo_validation" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX "job_tasks_claim_idx" ON "job_tasks" USING btree ("status","priority","id");--> statement-breakpoint
CREATE INDEX "job_tasks_run_idx" ON "job_tasks" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "ward_boundaries_geom_idx" ON "ward_boundaries" USING gist ("geom");