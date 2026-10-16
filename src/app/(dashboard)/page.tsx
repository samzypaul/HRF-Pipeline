import Link from "next/link";
import { sql } from "drizzle-orm";
import { q } from "@/lib/db/client";
import { ConfidenceBadge, PageHeader, Stat, StatusBadge, fmt, fmtDate } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const [totals] = await q<{ active: number; operating: number; with_coords: number; no_ward: number; removed: number }>(sql`
    SELECT count(*) FILTER (WHERE removed_at IS NULL)::int active,
           count(*) FILTER (WHERE removed_at IS NULL AND operating_status ILIKE 'operating')::int operating,
           count(*) FILTER (WHERE removed_at IS NULL AND hfr_lat IS NOT NULL)::int with_coords,
           count(*) FILTER (WHERE removed_at IS NULL AND ward_code IS NULL)::int no_ward,
           count(*) FILTER (WHERE removed_at IS NOT NULL)::int removed
    FROM facilities`);
  const conf = await q<{ confidence: string | null; n: number }>(sql`
    SELECT g.confidence, count(*)::int n FROM facilities f LEFT JOIN geo_validation g USING (facility_code)
    WHERE f.removed_at IS NULL GROUP BY 1 ORDER BY 1`);
  const byRegion = await q<{ region: string; n: number; high: number; low: number; outside: number }>(sql`
    SELECT coalesce(f.region_name, 'Unknown') region, count(*)::int n,
           count(*) FILTER (WHERE g.confidence = 'high')::int high,
           count(*) FILTER (WHERE g.confidence = 'low')::int low,
           count(*) FILTER (WHERE g.in_ward = false)::int outside
    FROM facilities f LEFT JOIN geo_validation g USING (facility_code)
    WHERE f.removed_at IS NULL GROUP BY 1 ORDER BY 2 DESC`);
  const runs = await q<{ id: number; kind: string; status: string; phase: string | null; started_at: string; finished_at: string | null }>(sql`
    SELECT id, kind, status, phase, started_at, finished_at FROM job_runs ORDER BY id DESC LIMIT 5`);
  const [latestReport] = await q<{ id: number; kind: string }>(sql`
    SELECT id, kind FROM reports ORDER BY period_start DESC, kind ASC, id DESC LIMIT 1`);
  const lastWeekly = runs.find((r) => r.kind === "weekly");
  const changes = lastWeekly
    ? await q<{ change_type: string; n: number }>(sql`
        SELECT change_type, count(DISTINCT facility_code)::int n FROM facility_changes WHERE run_id = ${lastWeekly.id} GROUP BY 1`)
    : [];
  const ch = Object.fromEntries(changes.map((c) => [c.change_type, Number(c.n)]));
  const confMap = Object.fromEntries(conf.map((c) => [c.confidence ?? "unchecked", Number(c.n)]));

  if (!totals || Number(totals.active) === 0) {
    return (
      <div>
        <PageHeader title="Overview" />
        <div className="card">
          <p className="font-medium">No facilities loaded yet.</p>
          <p className="mt-1 text-sm text-muted">
            Go to <Link className="text-brand underline" href="/admin">Admin</Link>, check that the HFR portal is reachable, then start a
            pilot run for one region before the full national load.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" />
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Facilities in registry" value={fmt(totals.active)} hint={`${fmt(totals.operating)} operating`} />
        <Stat label="With HFR coordinates" value={fmt(totals.with_coords)} hint={`${fmt(totals.active - totals.with_coords)} missing`} href="/quality?issue=missing_coords" />
        <Stat label="High confidence" value={fmt(confMap.high ?? 0)} hint={`${fmt(confMap.medium ?? 0)} medium · ${fmt(confMap.low ?? 0)} low`} href="/quality?confidence=high" />
        <Stat label="No ward assigned" value={fmt(totals.no_ward)} href="/quality?issue=no_ward" />
      </section>

      {lastWeekly && (
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="New this week" value={fmt(ch.new ?? 0)} />
          <Stat label="Changed this week" value={fmt(ch.updated ?? 0)} />
          <Stat label="Closed this week" value={fmt(ch.closed ?? 0)} />
          <Stat label="Removed this week" value={fmt(ch.removed ?? 0)} />
        </section>
      )}

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <h2 className="h2 mb-2">Location quality by region</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Region</th>
                <th className="text-right">Facilities</th>
                <th className="text-right">High</th>
                <th className="text-right">Low</th>
                <th className="text-right">Outside ward</th>
              </tr>
            </thead>
            <tbody>
              {byRegion.map((r) => (
                <tr key={r.region}>
                  <td>{r.region}</td>
                  <td className="text-right tabular-nums">{fmt(r.n)}</td>
                  <td className="text-right tabular-nums">{fmt(r.high)}</td>
                  <td className="text-right tabular-nums">{fmt(r.low)}</td>
                  <td className="text-right tabular-nums">{fmt(r.outside)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-4">
          <div className="card">
            <h2 className="h2 mb-2">Confidence</h2>
            <ul className="space-y-1 text-sm">
              {["high", "medium", "low", "unchecked"].map((k) => (
                <li key={k} className="flex items-center justify-between">
                  <ConfidenceBadge value={k} />
                  <span className="tabular-nums">{fmt(confMap[k] ?? 0)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="card">
            <h2 className="h2 mb-2">Recent runs</h2>
            <ul className="space-y-2 text-sm">
              {runs.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2">
                  <span>
                    #{r.id} {r.kind} <span className="text-xs text-muted">{fmtDate(r.started_at)}</span>
                  </span>
                  <StatusBadge value={r.status} />
                </li>
              ))}
            </ul>
            {latestReport && (
              <Link className="mt-3 inline-block text-sm text-brand underline" href={`/reports/${latestReport.id}`}>
                Latest {latestReport.kind} report →
              </Link>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
