import { sql } from "drizzle-orm";
import { headers } from "next/headers";
import { q } from "@/lib/db/client";
import { env } from "@/lib/env";
import { leaseInfo } from "@/lib/jobs/queue";
import { PageHeader, StatusBadge, fmt, fmtDate } from "@/components/ui";
import { monthKey } from "@/lib/util";
import {
  cancelRunAction,
  kickAction,
  manualWardLinkAction,
  approveWardSuggestionAction,
  matchWardsAction,
  rejectWardSuggestionAction,
  suggestWardLinksAction,
  resumeRunAction,
  retryFailedAction,
  saveAccessAction,
  saveSettingsAction,
  startRunAction,
} from "../actions";
import { GEO_LAYER_INFO, WEEKDAYS, canManageAccess, getSettings } from "@/lib/settings";
import { resolveProvider } from "@/lib/geo/provider";
import HealthCheck from "./HealthCheck";
import LiveStatus from "./LiveStatus";
import { HFR_REGIONS } from "@/lib/hfr/regions";

export const dynamic = "force-dynamic";

export default async function AdminPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const notice = (await searchParams).notice;
  const canEditAccess = canManageAccess((await headers()).get("x-user-email"));
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
  const settings = await getSettings();
  const providerReady = resolveProvider(settings.geoProvider) != null;
  const suggestions = await q<{ ward_code: string; boundary_id: number; ward: string | null; council: string | null; boundary: string; boundary_district: string | null }>(sql`
    SELECT s.ward_code, s.boundary_id, w.name ward, c.name council, b.name boundary, b.district_name boundary_district
    FROM ward_suggestions s
    JOIN ward_boundaries b ON b.id = s.boundary_id
    LEFT JOIN admin_units w ON w.code = s.ward_code
    LEFT JOIN admin_units c ON c.code = w.parent_code
    WHERE s.status = 'pending' ORDER BY s.ward_code LIMIT 50`);
  const [wardCheck] = await q<{ differs: number; unknown: number; agrees: number }>(sql`
    SELECT count(*) FILTER (WHERE ward_name_check = 'differs')::int differs,
           count(*) FILTER (WHERE ward_name_check = 'unknown')::int unknown,
           count(*) FILTER (WHERE ward_name_check = 'agrees')::int agrees
    FROM geo_validation`);
  const lease = await leaseInfo();
  const ticking = lease?.expires_at && new Date(lease.expires_at).getTime() > Date.now();

  return (
    <div className="space-y-6">
      <PageHeader title="Admin" subtitle="Start and watch runs, set the schedule and who can sign in, and link ward boundaries.">
        <form action={kickAction}>
          <button className="btn">Nudge runner</button>
        </form>
      </PageHeader>

      {notice && <div className="card border-low text-sm">{notice}</div>}

      <LiveStatus />

      <nav
        aria-label="Admin sections"
        className="sticky top-[3.75rem] z-20 flex gap-1 overflow-x-auto rounded-xl border border-line bg-panel/90 p-1 text-sm shadow-card backdrop-blur"
      >
        {[
          ["#start", "Start a run"],
          ["#access", "Who can sign in"],
          ["#automation", "Automation"],
          ["#runs", "Runs"],
          ["#wards", "Ward boundaries"],
        ].map(([href, label]) => (
          <a key={href} href={href} className="whitespace-nowrap rounded-lg px-3 py-1.5 font-medium text-muted hover:bg-canvas hover:text-ink">
            {label}
          </a>
        ))}
      </nav>

      <section id="start" className="grid scroll-mt-32 gap-4 lg:grid-cols-3">
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
                <option value="pilot">Pilot (one region, no improve step)</option>
                <option value="full">Full load (all regions, or the one chosen)</option>
                <option value="weekly">Weekly check now</option>
                <option value="improve">Improve data quality (repeats until located)</option>
                <option value="validate">Re-validate all locations</option>
                <option value="climate">Identify climate-sensitive services (no portal calls)</option>
              </select>
              <select className="input" name="region" defaultValue="">
                <option value="">All regions (whole country)</option>
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
            {["google_places", "google_geocode", "maptiler", "arcgis", "overpass", "nominatim", "gemini"].map((p) => {
              const n = Number(usage.find((u) => u.provider === p)?.calls ?? 0);
              const cap = p === "google_places" ? env.googlePlacesMonthlyCap : p === "google_geocode" ? env.googleGeocodeMonthlyCap : p === "maptiler" ? env.maptilerMonthlyCap : p === "arcgis" ? env.arcgisMonthlyCap : null;
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

      <section id="access" className="card scroll-mt-32">
        <h2 className="h2 mb-3">Who can sign in</h2>
        <form action={saveAccessAction} className="grid gap-4 text-sm lg:grid-cols-2">
          <div className="space-y-2">
            <label className="flex flex-col gap-1 text-xs text-muted">
              Allowed email addresses (comma-separated or one per line)
              <textarea
                className="input"
                name="accessEmails"
                rows={5}
                defaultValue={settings.access.emails.join(", ")}
                placeholder="name@example.org"
                disabled={!canEditAccess}
              />
            </label>
            <p className="text-xs text-muted">
              Each address signs in with a one-time link emailed to it, so only people who can open that mailbox get in. A newly added address
              receives an email saying it has access, and a removed address is signed out on its next page load. Invalid addresses are dropped when
              you save. Needs RESEND_API_KEY.
            </p>
            <button className="btn btn-primary" disabled={!canEditAccess}>
              Save and email new addresses
            </button>
            {!canEditAccess && <p className="text-xs text-low">Only the owners listed in ALLOWED_EMAILS can change this list.</p>}
          </div>
          <div className="space-y-1 text-xs text-muted">
            <div className="font-semibold text-ink">Owners (ALLOWED_EMAILS, cannot be removed here)</div>
            {env.allowedEmails.length ? (
              <ul className="list-disc pl-5">
                {env.allowedEmails.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            ) : (
              <p>None set: anyone can manage this list (local use).</p>
            )}
            <p>Report and approval emails go to the recipients set in the automation settings below.</p>
          </div>
        </form>
      </section>

      <section id="automation" className="card scroll-mt-32">
        <h2 className="h2 mb-3">Automation settings</h2>
        <form action={saveSettingsAction} className="grid gap-6 text-sm lg:grid-cols-3">
          <div className="space-y-2">
            <h3 className="font-semibold">Automatic runs</h3>
            <label className="flex flex-col gap-1 text-xs text-muted">
              How often
              <select className="input" name="cadence" defaultValue={settings.schedule.cadence}>
                <option value="weekly">Once a week</option>
                <option value="daily">Every day</option>
                <option value="off">Off (manual runs only)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Day of the week (used when weekly)
              <select className="input" name="weekday" defaultValue={settings.schedule.weekday}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Start no earlier than (East Africa Time)
              <select className="input" name="hour" defaultValue={settings.schedule.hour}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, "0")}:00
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs text-muted">
              Runs are started by the hourly GitHub worker (and the daily Vercel cron at 02:00) on the chosen day, from the chosen hour, at most once a day.
              Daily runs check the whole registry every day but refresh
              facility details more slowly, so the portal sees about the same load.
            </p>
          </div>

          <div className="space-y-2">
            <h3 className="font-semibold">Daily status email</h3>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="dailyEmail" defaultChecked={settings.dailyEmail.enabled} />
              Email the current status every morning
            </label>
            <p className="text-xs text-muted">
              Sent around 07:00 East Africa Time to REPORT_RECIPIENTS: running and last finished runs, failures, confidence levels and API
              usage. Needs RESEND_API_KEY.
            </p>
          </div>

          <div className="space-y-2">
            <h3 className="font-semibold">Report emails</h3>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Send the daily and weekly reports to (comma-separated; empty = REPORT_RECIPIENTS)
              <textarea
                className="input"
                name="reportRecipients"
                rows={3}
                defaultValue={settings.reports.recipients.join(", ")}
                placeholder="name@example.org, other@example.org"
              />
            </label>
            <p className="text-xs text-muted">
              {settings.reports.recipients.length
                ? `Currently ${settings.reports.recipients.length} address${settings.reports.recipients.length === 1 ? "" : "es"}.`
                : "Currently using the REPORT_RECIPIENTS environment variable."}{" "}
              Invalid addresses are dropped when you save. Needs RESEND_API_KEY.
            </p>
          </div>

          <div className="space-y-2">
            <h3 className="font-semibold">Approval emails</h3>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="approvalEmail" defaultChecked={settings.approvals.emailEnabled} />
              Email corrected locations that need approval
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Send to (comma-separated; empty = the report recipients)
              <input className="input" name="approvalRecipients" defaultValue={settings.approvals.recipients.join(", ")} placeholder="approver@example.org" />
            </label>
            <p className="text-xs text-muted">
              After each run, new corrected points are emailed once with a link to the review page, where they can be approved in bulk. A second email lists the facilities placed inside their HFR village (by a geocoder, or at the village centre when there were no coordinates and geocoding failed). Both go to these recipients. Needs RESEND_API_KEY.
            </p>
          </div>

          <div className="space-y-2">
            <h3 className="font-semibold">Location check layers</h3>
            <p className="text-xs text-muted">Sanity checks and the ward-boundary check always run. Switch off the rest to save quota or test their effect.</p>
            {GEO_LAYER_INFO.map((l) => (
              <label key={l.key} className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" name={`layer_${l.key}`} defaultChecked={settings.geoLayers[l.key]} />
                <span>
                  {l.label}
                  <span className="block text-xs text-muted">{l.hint}</span>
                </span>
              </label>
            ))}
            <label className="flex flex-col gap-1 text-xs text-muted">
              Extra geocoder provider
              <select className="input" name="geoProvider" defaultValue={settings.geoProvider}>
                <option value="all">All at once (MapTiler, ArcGIS and Google: every one that has a key)</option>
                <option value="auto">Automatic (MapTiler, else Google, else ArcGIS, whichever has a key)</option>
                <option value="maptiler">MapTiler (MAPTILER_API_KEY)</option>
                <option value="google">Google (GOOGLE_MAPS_API_KEY, counts toward the Geocoding cap)</option>
                <option value="arcgis">ArcGIS (ARCGIS_API_KEY)</option>
              </select>
            </label>
            <p className="text-xs text-muted">Applies to facilities checked from now on. Run “Re-validate all locations” to apply it everywhere.</p>
          </div>

          <div className="lg:col-span-3">
            <button className="btn btn-primary">Save settings</button>
          </div>
        </form>
      </section>

      <section id="runs" className="card scroll-mt-32 overflow-x-auto p-0">
        <h2 className="h2 px-5 pt-5">Runs</h2>
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
                    {c.improveRound != null && (
                      <>
                        {" "}· improve round {fmt(c.improveRound)} · still without location {fmt(c.improveRemaining)}
                        {c.improveStopped ? ` (${c.improveStopped})` : ""}
                      </>
                    )}
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

      <section id="wards" className="card scroll-mt-32">
        <h2 className="h2 mb-3">Ward boundaries</h2>
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
        <div className="mt-3 border-t border-line pt-3 text-sm">
          <h3 className="font-semibold">Geocoder checks</h3>
          <p className="text-xs text-muted">
            Ward name of each point (reverse geocoding): {fmt(wardCheck?.agrees ?? 0)} agree · {fmt(wardCheck?.differs ?? 0)} differ (flagged{" "}
            <code>geocoder_ward_differs</code>) · {fmt(wardCheck?.unknown ?? 0)} unknown.
          </p>
          <form action={suggestWardLinksAction} className="mt-2">
            <button className="btn" disabled={!providerReady}>
              Suggest links for unlinked wards (25 at a time)
            </button>
            {!providerReady && <span className="ml-2 text-xs text-muted">Set MAPTILER_API_KEY, GOOGLE_MAPS_API_KEY or ARCGIS_API_KEY for the chosen provider.</span>}
          </form>
          {suggestions.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs">
              {suggestions.map((s) => (
                <li key={s.ward_code} className="flex flex-wrap items-center gap-2">
                  <span>
                    {s.ward_code} {s.ward} ({s.council}) → boundary #{s.boundary_id} “{s.boundary}”{s.boundary_district ? `, ${s.boundary_district}` : ""}
                  </span>
                  <form action={approveWardSuggestionAction}>
                    <input type="hidden" name="wardCode" value={s.ward_code} />
                    <button className="btn px-2 py-1 text-xs">Approve</button>
                  </form>
                  <form action={rejectWardSuggestionAction}>
                    <input type="hidden" name="wardCode" value={s.ward_code} />
                    <button className="btn px-2 py-1 text-xs">Reject</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
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
