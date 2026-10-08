import { sql } from "drizzle-orm";
import { q } from "@/lib/db/client";
import { env } from "@/lib/env";
import { leaseInfo } from "@/lib/jobs/queue";
import { PageHeader, StatusBadge, fmt, fmtDate } from "@/components/ui";
import { monthKey } from "@/lib/util";
import {
  cancelRunAction,
  kickAction,
  manualWardLinkAction,
  matchWardsAction,
  resumeRunAction,
  retryFailedAction,
  startRunAction,
} from "../actions";
import HealthCheck from "./HealthCheck";
import { HFR_REGIONS } from "@/lib/hfr/regions";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const runs = await q<{
    id: number;
    kind: string;
    status: string;
    phase: string | null;
    params: Record<string, unknown>;
    counts: Record<string, unknown>;
    error: string | null;
    started_at: string;
    finished_at: string | null;
    heartbeat_at: string | null;
  }>(sql`SELECT * FROM job_runs ORDER BY id DESC LIMIT 15`);
  const taskStats = await q<{ run_id: number; status: string; n: number }>(sql`
    SELECT run_id, status, count(*)::int n FROM job_tasks
    WHERE run_id IN (SELECT id FROM job_runs ORDER BY id DESC LIMIT 15) GROUP BY 1, 2`);
  const statsByRun = new Map<number, Record<string, number>>();
  for (const t of taskStats) {
    const m = statsByRun.get(t.run_id) ?? {};
    m[t.status] = Number(t.n);
    statsByRun.set(t.run_id, m);
  }
  const recentErrors = await q<{ run_id: number; type: string; last_error: string; n: number }>(sql`
    SELECT run_id, type, last_error, count(*)::int n FROM job_tasks
    WHERE status = 'failed' AND run_id IN (SELECT id FROM job_runs ORDER BY id DESC LIMIT 5)
    GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 10`);
  const loadedRegions = await q<{ code: string; name: string }>(sql`SELECT code, name FROM admin_units WHERE level = 1 ORDER BY name`);
  const regions = loadedRegions.length ? loadedRegions : HFR_REGIONS;
  const [wardStats] = await q<{ wards: number; linked: number; boundaries: number; manual: number }>(sql`
    SELECT (SELECT count(*) FROM admin_units WHERE level = 4)::int wards,
           (SELECT count(*) FROM ward_crosswalk)::int linked,
           (SELECT count(*) FROM ward_boundaries)::int boundaries,
           (SELECT count(*) FROM ward_crosswalk WHERE method = 'manual')::int manual`);
  const unmatched = await q<{ code: string; name: string; council: string | null }>(sql`
    SELECT w.code, w.name, c.name council FROM admin_units w LEFT JOIN admin_units c ON c.code = w.parent_code
    WHERE w.level = 4 AND NOT EXISTS (SELECT 1 FROM ward_crosswalk x WHERE x.ward_code = w.code)
    ORDER BY w.code LIMIT 25`);
  const usage = await q<{ provider: string; calls: number }>(sql`SELECT provider, calls FROM api_usage WHERE month = ${monthKey()} ORDER BY provider`);
  const lease = await leaseInfo();
  const ticking = lease?.expires_at && new Date(lease.expires_at).getTime() > Date.now();

  return (
    <div className="space-y-6">
      <PageHeader title="Admin">
        <form action={kickAction}>
          <button className="btn">Nudge runner</button>
        </form>
      </PageHeader>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="card">
          <h2 className="h2 mb-2">1. Portal reachability</h2>
          <p className="mb-2 text-xs text-muted">Checks that this deployment can fetch the HFR facility list.</p>
          <HealthCheck />
        </div>
        <div className="card">
          <h2 className="h2 mb-2">2. Start a run</h2>
          <form action={startRunAction} className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-2">
              <select className="input" name="kind" defaultValue="pilot">
                <option value="pilot">Pilot (one region)</option>
                <option value="full">Full national load</option>
                <option value="weekly">Weekly check now</option>
                <option value="validate">Re-validate all locations</option>
              </select>
              <select className="input" name="region" defaultValue="">
                <option value="">Region (pilot only)</option>
                {regions.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn btn-primary">Start</button>
          </form>
          <p className="mt-2 text-xs text-muted">Runner: {ticking ? `working (lease until ${fmtDate(lease!.expires_at)})` : "idle"}</p>
        </div>
        <div className="card">
          <h2 className="h2 mb-2">API usage this month</h2>
          <ul className="space-y-1 text-sm">
            {["google_places", "google_geocode", "overpass", "nominatim", "gemini"].map((p) => {
              const n = Number(usage.find((u) => u.provider === p)?.calls ?? 0);
              const cap = p === "google_places" ? env.googlePlacesMonthlyCap : p === "google_geocode" ? env.googleGeocodeMonthlyCap : null;
              return (
                <li key={p} className="flex justify-between">
                  <span>{p}</span>
                  <span className="tabular-nums">
                    {fmt(n)}
                    {cap ? ` / ${fmt(cap)}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-muted">Google stops being called when its cap is reached, keeping usage in the free tier.</p>
        </div>
      </section>

      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-4 pt-4">Runs</h2>
        <table className="table mt-2">
          <thead>
            <tr>
              <th>#</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Phase</th>
              <th>Tasks (done / open / failed)</th>
              <th>Key counts</th>
              <th>Started</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const s = statsByRun.get(r.id) ?? {};
              const c = r.counts ?? {};
              const diff = (c.diff ?? {}) as Record<string, number>;
              return (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>
                    {r.kind}
                    {r.params?.region ? <span className="text-xs text-muted"> {String(r.params.region)}</span> : null}
                  </td>
                  <td>
                    <StatusBadge value={r.status} />
                    {r.error && <div className="mt-1 max-w-xs text-xs text-low">{r.error}</div>}
                  </td>
                  <td>{r.phase ?? "—"}</td>
                  <td className="tabular-nums">
                    {fmt(s.done ?? 0)} / {fmt((s.pending ?? 0) + (s.running ?? 0))} / {fmt(s.failed ?? 0)}
                  </td>
                  <td className="text-xs text-muted">
                    {c.listTotal != null && <>portal total {fmt(c.listTotal)} · </>}
                    {diff.seen != null && <>seen {fmt(diff.seen)} · new {fmt(diff.new)} · </>}
                    {c.details != null && <>details {fmt(c.details)} · </>}
                    {c.validated != null && <>validated {fmt(c.validated)}</>}
                  </td>
                  <td className="text-xs">{fmtDate(r.started_at)}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {(r.status === "paused" || r.status === "failed") && (
                        <form action={resumeRunAction}>
                          <input type="hidden" name="runId" value={r.id} />
                          <button className="btn px-2 py-1 text-xs">Resume</button>
                        </form>
                      )}
                      {(s.failed ?? 0) > 0 && (
                        <form action={retryFailedAction}>
                          <input type="hidden" name="runId" value={r.id} />
                          <button className="btn px-2 py-1 text-xs">Retry failed</button>
                        </form>
                      )}
                      {(r.status === "running" || r.status === "paused") && (
                        <form action={cancelRunAction}>
                          <input type="hidden" name="runId" value={r.id} />
                          <button className="btn px-2 py-1 text-xs">Cancel</button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {recentErrors.length > 0 && (
          <div className="border-t border-line p-4 text-xs">
            <h3 className="mb-1 font-semibold">Recent task failures</h3>
            <ul className="space-y-1 text-muted">
              {recentErrors.map((e, i) => (
                <li key={i}>
                  run #{e.run_id} · {e.type} × {e.n}: {e.last_error}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="h2 mb-2">Ward boundaries</h2>
        <p className="text-sm">
          {fmt(wardStats?.boundaries ?? 0)} boundary polygons loaded · {fmt(wardStats?.linked ?? 0)} of {fmt(wardStats?.wards ?? 0)} HFR wards
          linked ({fmt(wardStats?.manual ?? 0)} manual).
        </p>
        {Number(wardStats?.boundaries ?? 0) === 0 && (
          <p className="mt-1 text-xs text-muted">
            Load them once from your computer: <code>npx tsx scripts/load-wards.ts wards.geojson</code> (see README).
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <form action={matchWardsAction}>
            <button className="btn">Re-run automatic matching</button>
          </form>
          <form action={manualWardLinkAction} className="flex flex-wrap items-end gap-2 text-xs">
            <label className="flex flex-col gap-1 text-muted">
              HFR ward code
              <input className="input" name="wardCode" placeholder="TZ.CL.DO.BA.6.7" />
            </label>
            <label className="flex flex-col gap-1 text-muted">
              Boundary id
              <input className="input w-28" name="boundaryId" placeholder="1234" />
            </label>
            <button className="btn">Link manually</button>
          </form>
        </div>
        {unmatched.length > 0 && (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-muted">First {unmatched.length} unlinked wards</summary>
            <ul className="mt-1 columns-2 text-muted">
              {unmatched.map((u) => (
                <li key={u.code}>
                  {u.code} {u.name} ({u.council})
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}
