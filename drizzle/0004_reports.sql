CREATE TABLE "reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"run_id" integer,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"summary_md" text,
	"anomalies" jsonb,
	"recommendations" jsonb,
	"review_list" jsonb,
	"digest" jsonb,
	"source_report_ids" jsonb,
	"model" text,
	"verified" boolean DEFAULT false NOT NULL,
	"verification" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"emailed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "reports_run_uq" ON "reports" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_weekly_uq" ON "reports" USING btree ("period_start") WHERE kind = 'weekly';--> statement-breakpoint
CREATE INDEX "reports_kind_period_idx" ON "reports" USING btree ("kind","period_start");--> statement-breakpoint
INSERT INTO "reports" ("kind", "run_id", "period_start", "period_end", "summary_md", "anomalies", "review_list", "digest", "model", "verified", "verification", "created_at", "emailed_at")
SELECT 'daily', w.run_id,
       (coalesce(j.started_at, w.created_at) AT TIME ZONE 'Africa/Dar_es_Salaam')::date,
       (coalesce(j.started_at, w.created_at) AT TIME ZONE 'Africa/Dar_es_Salaam')::date,
       w.summary_md, w.anomalies, w.review_list, w.digest, w.model, w.verified, w.verification, w.created_at, w.emailed_at
FROM "weekly_reports" w LEFT JOIN "job_runs" j ON j.id = w.run_id
ON CONFLICT DO NOTHING;
