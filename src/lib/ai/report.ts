import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { sendReportEmail } from "../notify/email";
import { eatDay } from "../settings";
import { ensureWeeklyReports } from "./weekly";
import { verifyNumbers } from "./verify";
import { RULES, writeReport, type Recommendation } from "./write";

export interface Digest {
  run: { id: number; kind: string; started_at: string; finished_at: string | null };
  totals: {
    portal_reported_total: number | null;
    rows_seen_this_run: number;
    active_facilities: number;
    facilities_without_ward: number;
    list_task_failures: number;
  };
  changes: Record<string, number>;
  new_by_region: { region: string; n: number }[];
  new_by_type: { facility_type: string; n: number }[];
  closed_by_region: { region: string; n: number }[];
  changed_fields: { field: string; n: number }[];
  confidence: Record<string, number>;
  new_facilities_location: { checked: number; outside_ward: number; missing_coordinates: number };
  anomalies: {
    councils_with_many_new: { council: string; n: number }[];
    duplicate_names_in_ward: { ward_code: string; name: string; n: number }[];
    shared_coordinates: number;
  };
  samples: {
    facility_code: string;
    change_type: string;
    name: string;
    facility_type: string | null;
    region: string | null;
    council: string | null;
    fields: string[];
    confidence: string | null;
  }[];
}

export async function buildDigest(runId: number): Promise<Digest> {
  const [run] = await q<{ id: number; kind: string; started_at: string; finished_at: string | null; counts: Record<string, unknown> }>(
    sql`SELECT id, kind, started_at, finished_at, counts FROM job_runs WHERE id = ${runId}`,
  );
  if (!run) throw new Error(`Run ${runId} not found`);
  const counts = run.counts ?? {};
  const diff = (counts.diff ?? {}) as Record<string, number>;

  const changeRows = await q<{ change_type: string; n: number }>(sql`
    SELECT change_type, count(DISTINCT facility_code)::int n FROM facility_changes WHERE run_id = ${runId} GROUP BY change_type`);
  const by = async (type: string, col: string) =>
    q<{ k: string; n: number }>(sql`
      SELECT coalesce(${sql.raw(`f.${col}`)}, 'Unknown') k, count(*)::int n
      FROM facility_changes c JOIN facilities f ON f.facility_code = c.facility_code
      WHERE c.run_id = ${runId} AND c.change_type = ${type}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 15`);

  const changedFields = await q<{ field: string; n: number }>(sql`
    SELECT d->>'field' AS field, count(*)::int n
    FROM facility_changes c, jsonb_array_elements(coalesce(c.field_diffs, '[]'::jsonb)) d
    WHERE c.run_id = ${runId} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`);

  const [active] = await q<{ n: number; noward: number }>(sql`
    SELECT count(*)::int n, count(*) FILTER (WHERE ward_code IS NULL)::int noward FROM facilities WHERE removed_at IS NULL`);

  const conf = await q<{ confidence: string | null; n: number }>(sql`
    SELECT g.confidence, count(*)::int n FROM facilities f LEFT JOIN geo_validation g USING (facility_code)
    WHERE f.removed_at IS NULL GROUP BY 1`);

  const [newLoc] = await q<{ checked: number; outside: number; missing: number }>(sql`
    SELECT count(g.*)::int checked,
           count(*) FILTER (WHERE g.in_ward = false)::int outside,
           count(*) FILTER (WHERE f.hfr_lat IS NULL)::int missing
    FROM facility_changes c JOIN facilities f USING (facility_code)
    LEFT JOIN geo_validation g USING (facility_code)
    WHERE c.run_id = ${runId} AND c.change_type = 'new'`);

  const manyNew = await q<{ council: string; n: number }>(sql`
    SELECT coalesce(f.council_name, 'Unknown') council, count(*)::int n
    FROM facility_changes c JOIN facilities f USING (facility_code)
    WHERE c.run_id = ${runId} AND c.change_type = 'new'
    GROUP BY 1 HAVING count(*) >= 5 ORDER BY 2 DESC LIMIT 10`);

  const dupNames = await q<{ ward_code: string; name: string; n: number }>(sql`
    SELECT f.ward_code, upper(f.name) AS name, count(*)::int n FROM facilities f
    WHERE f.removed_at IS NULL AND f.ward_code IS NOT NULL
      AND f.ward_code IN (SELECT f2.ward_code FROM facility_changes c JOIN facilities f2 USING (facility_code) WHERE c.run_id = ${runId} AND c.change_type = 'new')
    GROUP BY 1, 2 HAVING count(*) > 1 ORDER BY 3 DESC LIMIT 10`);

  const [shared] = await q<{ n: number }>(sql`
    SELECT count(*)::int n FROM geo_validation WHERE 'shared_point' = ANY(sanity_flags)`);

  const samples = await q<Digest["samples"][number] & { diffs: { field: string }[] | null }>(sql`
    SELECT c.facility_code, c.change_type, f.name, f.facility_type, f.region_name AS region, f.council_name AS council,
           c.field_diffs AS diffs, g.confidence
    FROM facility_changes c JOIN facilities f USING (facility_code) LEFT JOIN geo_validation g USING (facility_code)
    WHERE c.run_id = ${runId}
    ORDER BY CASE c.change_type WHEN 'closed' THEN 0 WHEN 'new' THEN 1 WHEN 'removed' THEN 2 ELSE 3 END, c.id
    LIMIT 40`);

  const map = (rows: { k: string; n: number }[], key: string) => rows.map((r) => ({ [key]: r.k, n: Number(r.n) }));
  return {
    run: { id: run.id, kind: run.kind, started_at: String(run.started_at), finished_at: run.finished_at ? String(run.finished_at) : null },
    totals: {
      portal_reported_total: (counts.listTotal as number) ?? null,
      rows_seen_this_run: Number(diff.seen ?? 0),
      active_facilities: Number(active?.n ?? 0),
      facilities_without_ward: Number(active?.noward ?? 0),
      list_task_failures: Number(counts.listFailures ?? 0),
    },
    changes: Object.fromEntries(changeRows.map((r) => [r.change_type, Number(r.n)])),
    new_by_region: map(await by("new", "region_name"), "region") as Digest["new_by_region"],
    new_by_type: map(await by("new", "facility_type"), "facility_type") as Digest["new_by_type"],
    closed_by_region: map(await by("closed", "region_name"), "region") as Digest["closed_by_region"],
    changed_fields: changedFields.map((r) => ({ field: r.field, n: Number(r.n) })),
    confidence: Object.fromEntries(conf.map((c) => [c.confidence ?? "unchecked", Number(c.n)])),
    new_facilities_location: {
      checked: Number(newLoc?.checked ?? 0),
      outside_ward: Number(newLoc?.outside ?? 0),
      missing_coordinates: Number(newLoc?.missing ?? 0),
    },
    anomalies: {
      councils_with_many_new: manyNew.map((r) => ({ council: r.council, n: Number(r.n) })),
      duplicate_names_in_ward: dupNames.map((r) => ({ ...r, n: Number(r.n) })),
      shared_coordinates: Number(shared?.n ?? 0),
    },
    samples: samples.map(({ diffs, ...s }) => ({ ...s, fields: (diffs ?? []).map((d) => d.field) })),
  };
}

const DAILY_SYSTEM = `You write the daily data-quality report for Tanzania's Health Facility Registry (HFR) pipeline.
${RULES}
- Keep it short and useful for MoH staff deciding what to check today.`;

/**
 * Generate (or regenerate) the daily report for one pipeline run, email it, and refresh the weekly roll-ups.
 * With `notify: false` the report is only stored: nothing is emailed and the weekly roll-up is left alone (used to backfill old days).
 */
export async function generateDailyReport(runId: number, opts: { notify?: boolean } = {}) {
  const digest = await buildDigest(runId);
  const day = eatDay(new Date(digest.run.started_at)).date;
  const ai = await writeReport(DAILY_SYSTEM, `Digest for run ${runId} (${day}):

${JSON.stringify(digest, null, 2)}`, () => fallbackSummary(digest));

  const verification = verifyNumbers([ai.summary, JSON.stringify(ai.anomalies), JSON.stringify(ai.recommendations), JSON.stringify(ai.reviewList)], digest);

  const [row] = await q<{ id: number }>(sql`
    INSERT INTO reports (kind, run_id, period_start, period_end, summary_md, anomalies, recommendations, review_list, digest, model, verified, verification)
    VALUES ('daily', ${runId}, ${day}, ${day}, ${ai.summary}, ${JSON.stringify(ai.anomalies)}::jsonb, ${JSON.stringify(ai.recommendations)}::jsonb,
            ${JSON.stringify(ai.reviewList)}::jsonb, ${JSON.stringify(digest)}::jsonb, ${ai.model}, ${verification.ok}, ${JSON.stringify(verification)}::jsonb)
    ON CONFLICT (run_id) DO UPDATE SET period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end, summary_md = EXCLUDED.summary_md,
      anomalies = EXCLUDED.anomalies, recommendations = EXCLUDED.recommendations, review_list = EXCLUDED.review_list, digest = EXCLUDED.digest,
      model = EXCLUDED.model, verified = EXCLUDED.verified, verification = EXCLUDED.verification, created_at = now()
    RETURNING id`);

  // Only a report whose numbers all check out is emailed.
  if (opts.notify !== false && verification.ok) {
    const sent = await sendReportEmail({ id: row.id, title: `HFR daily report — ${day}`, summaryMd: ai.summary, recommendations: ai.recommendations as Recommendation[] });
    if (sent) await q(sql`UPDATE reports SET emailed_at = now() WHERE id = ${row.id}`);
  }

  // A weekly report is written once its week is complete (and refreshed on Sunday).
  if (opts.notify === false) return { id: row.id, verification };
  try {
    await ensureWeeklyReports(day);
  } catch (e) {
    console.error("[reports] weekly roll-up failed", e);
  }
  return { id: row.id, verification };
}

/** Plain summary used when no Gemini API key is configured. */
export function fallbackSummary(d: Digest): string {
  const c = d.changes;
  return [
    `## What changed`,
    `- New facilities: ${c.new ?? 0}`,
    `- Updated: ${c.updated ?? 0}`,
    `- Closed: ${c.closed ?? 0}`,
    `- Removed from the registry list: ${c.removed ?? 0}`,
    ``,
    `## Data quality`,
    `- Portal reported ${d.totals.portal_reported_total ?? "n/a"} facilities; this run saw ${d.totals.rows_seen_this_run}.`,
    `- Facilities without a ward: ${d.totals.facilities_without_ward}`,
    `- Confidence: ${Object.entries(d.confidence).map(([k, v]) => `${k} ${v}`).join(", ")}`,
  ].join("\n");
}
