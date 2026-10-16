import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { sendReportEmail } from "../notify/email";
import { eatDay } from "../settings";
import type { Digest } from "./report";
import { verifyNumbers } from "./verify";
import { RULES, writeReport, type Recommendation } from "./write";

const DAY_MS = 86_400_000;

/** Add days to a YYYY-MM-DD date. */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Monday and Sunday (YYYY-MM-DD) of the week that contains `date`. */
export function weekOf(date: string): { start: string; end: string } {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const start = addDays(date, -((weekday + 6) % 7));
  return { start, end: addDays(start, 6) };
}

type Counted = { n: number };
function mergeCounts<T extends Counted>(lists: T[][], key: keyof T): T[] {
  const m = new Map<string, number>();
  for (const l of lists) for (const r of l ?? []) m.set(String(r[key]), (m.get(String(r[key])) ?? 0) + Number(r.n));
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([k, n]) => ({ [key]: k, n }) as unknown as T);
}

export interface DailyRow {
  id: number;
  run_id: number | null;
  period_start: string;
  verified: boolean;
  summary_md: string | null;
  anomalies: { title: string; detail: string }[] | null;
  recommendations: Recommendation[] | null;
  digest: Digest | null;
}

export interface WeeklyDigest {
  period: { start: string; end: string };
  days_covered: number;
  days: { date: string; report_id: number; changes: Record<string, number>; numbers_checked: boolean }[];
  changes_total: Record<string, number>;
  new_by_region: { region: string; n: number }[];
  new_by_type: { facility_type: string; n: number }[];
  closed_by_region: { region: string; n: number }[];
  changed_fields: { field: string; n: number }[];
  latest_totals: Digest["totals"] | null;
  latest_confidence: Record<string, number> | null;
  daily_anomalies: { date: string; title: string; detail: string }[];
  daily_recommendations: { date: string; title: string; detail: string }[];
  daily_summaries: { date: string; summary: string }[];
}

/** Combine the daily digests of one week. Counts are sums of the daily counts (a facility changed twice counts twice). */
export function buildWeeklyDigest(start: string, end: string, dailies: DailyRow[]): WeeklyDigest {
  const digests = dailies.map((d) => d.digest).filter((d): d is Digest => !!d);
  const changes_total: Record<string, number> = {};
  for (const d of digests) for (const [k, v] of Object.entries(d.changes ?? {})) changes_total[k] = (changes_total[k] ?? 0) + Number(v);
  const latest = digests[digests.length - 1] ?? null;
  return {
    period: { start, end },
    days_covered: new Set(dailies.map((d) => d.period_start)).size,
    days: dailies.map((d) => ({ date: d.period_start, report_id: d.id, changes: d.digest?.changes ?? {}, numbers_checked: d.verified })),
    changes_total,
    new_by_region: mergeCounts(digests.map((d) => d.new_by_region), "region"),
    new_by_type: mergeCounts(digests.map((d) => d.new_by_type), "facility_type"),
    closed_by_region: mergeCounts(digests.map((d) => d.closed_by_region), "region"),
    changed_fields: mergeCounts(digests.map((d) => d.changed_fields), "field"),
    latest_totals: latest?.totals ?? null,
    latest_confidence: latest?.confidence ?? null,
    daily_anomalies: dailies.flatMap((d) => (d.anomalies ?? []).map((a) => ({ date: d.period_start, title: a.title, detail: a.detail }))),
    daily_recommendations: dailies.flatMap((d) => (d.recommendations ?? []).map((r) => ({ date: d.period_start, title: r.title, detail: r.detail }))),
    daily_summaries: dailies.map((d) => ({ date: d.period_start, summary: d.summary_md ?? "" })),
  };
}

const WEEKLY_SYSTEM = `You write the weekly data-quality report for Tanzania's Health Facility Registry (HFR) pipeline.
You are given the combined digest of the week's daily reports (the daily summaries are included for context).
${RULES}
- Describe the week as a whole: trends across days, what recurred, what was resolved. Counts are sums of the daily counts.
- Recommendations should prioritise what recurred on several days or is still unresolved at the end of the week.
- Keep it short and useful for MoH staff planning next week's checks.`;

function fallbackWeekly(d: WeeklyDigest): string {
  const c = d.changes_total;
  return [
    `## What changed (${d.period.start} to ${d.period.end}, ${d.days_covered} daily report${d.days_covered === 1 ? "" : "s"})`,
    `- New facilities: ${c.new ?? 0}`,
    `- Updated: ${c.updated ?? 0}`,
    `- Closed: ${c.closed ?? 0}`,
    `- Removed from the registry list: ${c.removed ?? 0}`,
    ``,
    `## Data quality`,
    `- Facilities without a ward at the end of the week: ${d.latest_totals?.facilities_without_ward ?? "n/a"}`,
    `- Confidence: ${Object.entries(d.latest_confidence ?? {}).map(([k, v]) => `${k} ${v}`).join(", ")}`,
  ].join("\n");
}

/** Build (or rebuild) the weekly report for the week that contains `weekStart`. */
export async function generateWeeklyReport(weekStart: string) {
  const { start, end } = weekOf(weekStart);
  const dailies = await q<DailyRow>(sql`
    SELECT id, run_id, period_start::text, verified, summary_md, anomalies, recommendations, digest
    FROM reports WHERE kind = 'daily' AND period_start BETWEEN ${start} AND ${end} ORDER BY period_start, id`);
  if (dailies.length === 0) throw new Error(`There are no daily reports for ${start} to ${end} yet, so there is nothing to combine. Run a daily report first, or pick a week that has some.`);

  const digest = buildWeeklyDigest(start, end, dailies);
  const ai = await writeReport(WEEKLY_SYSTEM, `Digest for the week ${start} to ${end}:\n\n${JSON.stringify(digest, null, 2)}`, () => fallbackWeekly(digest));
  const verification = verifyNumbers([ai.summary, JSON.stringify(ai.anomalies), JSON.stringify(ai.recommendations), JSON.stringify(ai.reviewList)], digest);
  const ids = dailies.map((d) => d.id);

  const [row] = await q<{ id: number }>(sql`
    INSERT INTO reports (kind, period_start, period_end, summary_md, anomalies, recommendations, review_list, digest, source_report_ids, model, verified, verification)
    VALUES ('weekly', ${start}, ${end}, ${ai.summary}, ${JSON.stringify(ai.anomalies)}::jsonb, ${JSON.stringify(ai.recommendations)}::jsonb,
            ${JSON.stringify(ai.reviewList)}::jsonb, ${JSON.stringify(digest)}::jsonb, ${JSON.stringify(ids)}::jsonb, ${ai.model}, ${verification.ok}, ${JSON.stringify(verification)}::jsonb)
    ON CONFLICT (period_start) WHERE kind = 'weekly' DO UPDATE SET period_end = EXCLUDED.period_end, summary_md = EXCLUDED.summary_md,
      anomalies = EXCLUDED.anomalies, recommendations = EXCLUDED.recommendations, review_list = EXCLUDED.review_list, digest = EXCLUDED.digest,
      source_report_ids = EXCLUDED.source_report_ids, model = EXCLUDED.model, verified = EXCLUDED.verified, verification = EXCLUDED.verification, created_at = now()
    RETURNING id`);

  if (verification.ok) {
    const sent = await sendReportEmail({ id: row.id, title: `HFR weekly report — ${start} to ${end}`, summaryMd: ai.summary, recommendations: ai.recommendations as Recommendation[] });
    if (sent) await q(sql`UPDATE reports SET emailed_at = now() WHERE id = ${row.id}`);
  }
  return { id: row.id, verification };
}

/**
 * Write the weekly report for every recent week that is complete and has none yet.
 * A week is complete once its Sunday has been reached (`day` is the date of the daily report just written).
 */
export async function ensureWeeklyReports(day: string) {
  const today = eatDay().date;
  const weeks = await q<{ week: string }>(sql`
    SELECT DISTINCT date_trunc('week', period_start)::date::text AS week FROM reports
    WHERE kind = 'daily' ORDER BY 1 DESC LIMIT 4`);
  const have = new Set((await q<{ p: string }>(sql`SELECT period_start::text p FROM reports WHERE kind = 'weekly'`)).map((r) => r.p));
  for (const { week } of weeks.reverse()) {
    const { end } = weekOf(week);
    if (have.has(week) || (end > day && end >= today)) continue;
    await generateWeeklyReport(week);
  }
}
