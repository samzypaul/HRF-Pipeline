import Link from "next/link";
import { sql } from "drizzle-orm";
import { q } from "@/lib/db/client";
import { PENDING_CORRECTION } from "@/lib/data";
import { CONF_COLOR, CardHeader, Empty, PageHeader, Stat, StackedBar, StatusBadge, fmt, fmtDate, pct } from "@/components/ui";

export const dynamic = "force-dynamic";

const CONF_ORDER = ["high", "medium", "low", "unchecked"] as const;
const CONF_LABEL: Record<string, string> = { high: "High", medium: "Medium", low: "Low", unchecked: "Not checked" };

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
  const byRegion = await q<{ region: string; n: number; high: number; medium: number; low: number; outside: number }>(sql`
    SELECT coalesce(f.region_name, 'Unknown') region, count(*)::int n,
           count(*) FILTER (WHERE g.confidence = 'high')::int high,
           count(*) FILTER (WHERE g.confidence = 'medium')::int medium,
           count(*) FILTER (WHERE g.confidence = 'low')::int low,
           count(*) FILTER (WHERE g.in_ward = false)::int outside
    FROM facilities f LEFT JOIN geo_validation g USING (facility_code)
    WHERE f.removed_at IS NULL GROUP BY 1 ORDER BY 2 DESC`);
  const [attention] = await q<{ pending: number; outside_village: number; village_fix: number; outside_ward: number }>(sql`
    SELECT count(*) FILTER (WHERE ${PENDING_CORRECTION})::int pending,
           count(*) FILTER (WHERE f.removed_at IS NULL AND 'outside_village' = ANY(g.sanity_flags))::int outside_village,
           count(*) FILTER (WHERE f.removed_at IS NULL AND 'village_fix' = ANY(g.sanity_flags))::int village_fix,
           count(*) FILTER (WHERE f.removed_at IS NULL AND g.in_ward = false)::int outside_ward
    FROM facilities f JOIN geo_validation g ON g.facility_code = f.facility_code`);
  const runs = await q<{ id: number; kind: string; status: string; phase: string | null; started_at: string; finished_at: string | null }>(sql`
    SELECT id, kind, status, phase, started_at, finished_at FROM job_runs ORDER BY id DESC LIMIT 5`);
  const live = runs.find((r) => r.status === "running");
  const [progress] = live
    ? await q<{ done: number; total: number }>(sql`
        SELECT count(*) FILTER (WHERE status = 'done')::int done, count(*)::int total FROM job_tasks WHERE run_id = ${live.id}`)
    : [];
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
          <Empty title="No facilities loaded yet.">
            Go to <Link className="link" href="/admin">Admin</Link>, check that the HFR portal is reachable, then start a pilot run for one region before the full
            national load.
          </Empty>
        </div>
      </div>
    );
  }

  const active = Number(totals.active);
  const lastDone = runs.find((r) => r.finished_at);
  const segments = CONF_ORDER.map((k) => ({ key: k, label: CONF_LABEL[k], value: confMap[k] ?? 0, color: CONF_COLOR[k] }));
  const needs = [
    { label: "Corrected points awaiting approval", n: attention?.pending ?? 0, href: "/quality?issue=pending_approval", note: "a better point was found; approve or reject it" },
    { label: "Outside their HFR village", n: attention?.outside_village ?? 0, href: "/quality?issue=outside_village", note: "no point inside the village was found" },
    { label: "Outside their ward", n: attention?.outside_ward ?? 0, href: "/quality?issue=outside_ward", note: "the point is in another ward" },
    { label: "No coordinates from the portal", n: active - Number(totals.with_coords), href: "/quality?issue=missing_coords", note: "located by geocoding or village centre" },
    { label: "No ward assigned", n: Number(totals.no_ward), href: "/quality?issue=no_ward", note: "cannot be checked against a ward" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        subtitle={
          <>
            {fmt(active)} active facilities
            {lastDone && <> · last run finished {fmtDate(lastDone.finished_at)}</>}
          </>
        }
      >
        {latestReport && (
          <Link className="btn" href={`/reports/${latestReport.id}`}>
            Latest {latestReport.kind} report →
          </Link>
        )}
        <Link className="btn btn-primary" href="/map">
          Open the map
        </Link>
      </PageHeader>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Facilities in registry" value={fmt(active)} hint={`${fmt(totals.operating)} operating`} />
        <Stat
          label="With HFR coordinates"
          value={pct(Number(totals.with_coords), active)}
          progress={(Number(totals.with_coords) / active) * 100}
          hint={`${fmt(active - Number(totals.with_coords))} have none from the portal`}
          href="/quality?issue=missing_coords"
        />
        <Stat
          label="High confidence"
          value={pct(confMap.high ?? 0, active)}
          progress={((confMap.high ?? 0) / active) * 100}
          hint={`${fmt(confMap.high ?? 0)} of ${fmt(active)} facilities`}
          href="/quality?confidence=high"
        />
        <Stat label="Placed in their village" value={fmt(attention?.village_fix ?? 0)} hint="by a geocoder or the village centre" href="/quality?issue=village_fix" />
      </section>

      {lastWeekly && (
        <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="New this week" value={fmt(ch.new ?? 0)} />
          <Stat label="Changed this week" value={fmt(ch.updated ?? 0)} />
          <Stat label="Closed this week" value={fmt(ch.closed ?? 0)} />
          <Stat label="Removed this week" value={fmt(ch.removed ?? 0)} />
        </section>
      )}

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <CardHeader title="Location quality" hint="How sure the pipeline is of each facility's location" />
          <StackedBar segments={segments} height={12} />
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {segments.map((s) => (
              <li key={s.key} className="flex items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
                <span className="text-muted">{s.label}</span>
                <span className="font-medium tabular-nums">{fmt(s.value)}</span>
                <span className="text-xs text-faint tabular-nums">{pct(s.value, active)}</span>
              </li>
            ))}
          </ul>

          <h3 className="eyebrow mt-6 mb-2">By region</h3>
          <div className="-mx-5 overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Region</th>
                  <th className="text-right">Facilities</th>
                  <th className="w-48">Confidence</th>
                  <th className="text-right">High</th>
                  <th className="text-right">Outside ward</th>
                </tr>
              </thead>
              <tbody>
                {byRegion.map((r) => (
                  <tr key={r.region}>
                    <td className="font-medium">{r.region}</td>
                    <td className="text-right tabular-nums">{fmt(r.n)}</td>
                    <td className="align-middle">
                      <StackedBar
                        height={8}
                        segments={[
                          { key: "high", label: "High", value: r.high, color: CONF_COLOR.high },
                          { key: "medium", label: "Medium", value: r.medium, color: CONF_COLOR.medium },
                          { key: "low", label: "Low", value: r.low, color: CONF_COLOR.low },
                          { key: "unchecked", label: "Not checked", value: r.n - r.high - r.medium - r.low, color: CONF_COLOR.unchecked },
                        ]}
                      />
                    </td>
                    <td className="text-right tabular-nums">{pct(r.high, r.n)}</td>
                    <td className="text-right tabular-nums">{fmt(r.outside)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-4">
          <div className="card">
            <CardHeader title="Needs attention" />
            <ul className="-mx-2">
              {needs.map((n) => (
                <li key={n.label}>
                  <Link href={n.href} className="group flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 hover:bg-canvas">
                    <span>
                      <span className="block text-sm font-medium">{n.label}</span>
                      <span className="block text-xs text-muted">{n.note}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-lg font-semibold tabular-nums">{fmt(n.n)}</span>
                      <span className="text-faint transition-transform group-hover:translate-x-0.5" aria-hidden>
                        →
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div className="card">
            <CardHeader title="Recent runs">
              <Link className="link text-xs" href="/admin#runs">
                All runs
              </Link>
            </CardHeader>
            <ul className="space-y-3 text-sm">
              {runs.map((r) => (
                <li key={r.id}>
                  <div className="flex items-center justify-between gap-2">
                    <span>
                      <span className="font-medium">
                        #{r.id} {r.kind}
                      </span>
                      <span className="block text-xs text-muted">{fmtDate(r.started_at)}</span>
                    </span>
                    <StatusBadge value={r.status} />
                  </div>
                  {live && r.id === live.id && progress && (
                    <div className="mt-2">
                      <div className="progress">
                        <span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        {r.phase ? `${r.phase} · ` : ""}
                        {fmt(progress.done)} of {fmt(progress.total)} tasks done so far
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
