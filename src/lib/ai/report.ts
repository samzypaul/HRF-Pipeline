import Anthropic from "@anthropic-ai/sdk";
import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { env } from "../env";
import { countCall } from "../geo/usage";
import { sendReportEmail } from "../notify/email";
import { verifyNumbers } from "./verify";

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

const REPORT_TOOL = {
  name: "weekly_report",
  description: "Return the weekly health facility registry report.",
  input_schema: {
    type: "object" as const,
    properties: {
      summary_md: {
        type: "string",
        description:
          "Markdown summary for Ministry of Health and partner staff: 2–4 short sections (What changed, Data quality, Needs attention). Plain language, no more than 350 words.",
      },
      anomalies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            detail: { type: "string" },
            facility_codes: { type: "array", items: { type: "string" } },
          },
          required: ["title", "detail"],
        },
      },
      review_list: {
        type: "array",
        description: "Facilities a person should check, most important first (max 15).",
        items: {
          type: "object",
          properties: { facility_code: { type: "string" }, reason: { type: "string" } },
          required: ["facility_code", "reason"],
        },
      },
    },
    required: ["summary_md", "anomalies", "review_list"],
  },
};

const SYSTEM = `You write the weekly data-quality report for Tanzania's Health Facility Registry (HFR) pipeline.
Rules:
- Use ONLY the numbers and facts in the JSON digest. Never estimate, extrapolate or invent figures.
- If something is zero or missing, say so plainly; do not speculate about causes beyond "may indicate".
- Refer to facilities by name and facility code exactly as given.
- Flag reconciliation gaps (portal total vs rows seen, list task failures, facilities without a ward).
- Keep it short and useful for MoH staff deciding what to check this week.`;

export async function generateWeeklyReport(runId: number) {
  const digest = await buildDigest(runId);
  let summary = "";
  let anomalies: unknown[] = [];
  let reviewList: unknown[] = [];
  let model: string | null = null;

  if (env.anthropicKey) {
    const client = new Anthropic({ apiKey: env.anthropicKey });
    model = env.anthropicModel;
    const msg = await client.messages.create({
      model,
      max_tokens: 2000,
      system: SYSTEM,
      tools: [REPORT_TOOL],
      tool_choice: { type: "tool", name: REPORT_TOOL.name },
      messages: [{ role: "user", content: `Digest for run ${runId}:\n\n${JSON.stringify(digest, null, 2)}` }],
    });
    await countCall("anthropic");
    const block = msg.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") throw new Error("Claude did not return a report");
    const input = block.input as { summary_md: string; anomalies: unknown[]; review_list: unknown[] };
    summary = input.summary_md;
    anomalies = input.anomalies ?? [];
    reviewList = input.review_list ?? [];
  } else {
    summary = fallbackSummary(digest);
  }

  const texts = [summary, JSON.stringify(anomalies), JSON.stringify(reviewList)];
  const verification = verifyNumbers(texts, digest);

  await q(sql`
    INSERT INTO weekly_reports (run_id, summary_md, anomalies, review_list, digest, model, verified, verification)
    VALUES (${runId}, ${summary}, ${JSON.stringify(anomalies)}::jsonb, ${JSON.stringify(reviewList)}::jsonb,
            ${JSON.stringify(digest)}::jsonb, ${model}, ${verification.ok}, ${JSON.stringify(verification)}::jsonb)
    ON CONFLICT (run_id) DO UPDATE SET summary_md = EXCLUDED.summary_md, anomalies = EXCLUDED.anomalies,
      review_list = EXCLUDED.review_list, digest = EXCLUDED.digest, model = EXCLUDED.model,
      verified = EXCLUDED.verified, verification = EXCLUDED.verification, created_at = now()`);

  // Only a report whose numbers all check out is emailed.
  if (verification.ok) {
    const sent = await sendReportEmail(runId, summary);
    if (sent) await q(sql`UPDATE weekly_reports SET emailed_at = now() WHERE run_id = ${runId}`);
  }
  return { verification };
}

/** Plain summary used when no Claude API key is configured. */
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
