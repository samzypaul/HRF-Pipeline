"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Status {
  run: {
    id: number;
    kind: string;
    status: string;
    phase: string | null;
    params: Record<string, unknown>;
    counts: Record<string, unknown>;
    error: string | null;
    started_at: string;
    finished_at: string | null;
  } | null;
  ticking: boolean;
  quality?: { missing: number; confidence: Record<string, number> };
  byType?: { type: string; status: string; n: number }[];
  lastDone?: string | null;
  perMinute?: number;
  lastMinute?: number;
  current?: { type: string; payload: Record<string, unknown>; updated_at: string } | null;
  recent?: { type: string; status: string; payload: Record<string, unknown>; last_error: string | null; updated_at: string }[];
  now: number;
  error?: string;
}

const LABELS: Record<string, string> = {
  admin_regions: "Region list (one fetch, not a count of regions)",
  admin_children: "Admin tree: districts, councils and wards (one task per region, district and council)",
  list_page: "National facility list pages",
  ward_list: "Ward facility lists",
  facility_detail: "Facility details + coordinates",
  validate_batch: "Location validation (batches)",
  weekly_report: "AI weekly report",
};

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

function eta(minutes: number) {
  if (!isFinite(minutes)) return "—";
  if (minutes < 1) return "< 1 min";
  if (minutes < 90) return `~${Math.round(minutes)} min`;
  return `~${(minutes / 60).toFixed(1)} h`;
}

function describe(type: string, payload: Record<string, unknown>) {
  if (type === "list_page") return `list page ${payload.page ?? 1}`;
  if (type === "ward_list") return `ward ${payload.ward} page ${payload.page ?? 1}`;
  if (type === "facility_detail") return `facility ${payload.code}`;
  if (type === "validate_batch") return `${(payload.codes as string[] | undefined)?.length ?? 0} facilities`;
  if (type === "admin_children") {
    const kind = { 2: "districts", 3: "councils", 4: "wards" }[Number(payload.level) as 2 | 3 | 4] ?? `level ${payload.level}`;
    return `${kind} under ${payload.parent}`;
  }
  return "";
}

export default function LiveStatus() {
  const router = useRouter();
  const [s, setS] = useState<Status | null>(null);
  const [offline, setOffline] = useState(false);
  const [tickAt, setTickAt] = useState(Date.now());
  const lastDoneSeen = useRef<string | null>(null);

  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const res = await fetch("/api/jobs/status", { cache: "no-store" });
        const data: Status = await res.json();
        if (stop) return;
        setS(data);
        setOffline(false);
        // Refresh the runs table below whenever new work has completed.
        if (data.lastDone && data.lastDone !== lastDoneSeen.current) {
          lastDoneSeen.current = data.lastDone;
          router.refresh();
        }
      } catch {
        if (!stop) setOffline(true);
      }
    }
    poll();
    const id = setInterval(poll, 3000);
    const clock = setInterval(() => setTickAt(Date.now()), 1000);
    return () => {
      stop = true;
      clearInterval(id);
      clearInterval(clock);
    };
  }, [router]);

  if (!s) return <section className="card text-sm text-muted">Loading live status…</section>;
  if (!s.run) return <section className="card text-sm text-muted">No runs yet. Start one below.</section>;

  const run = s.run;
  const active = run.status === "running";
  const rows = (s.byType ?? []).reduce<Record<string, Record<string, number>>>((acc, r) => {
    (acc[r.type] ??= {})[r.status] = Number(r.n);
    return acc;
  }, {});
  const types = Object.keys(rows);
  const total = (t: string) => Object.values(rows[t]).reduce((a, b) => a + b, 0);

  // Remaining work across all task types currently queued (later phases are not queued yet).
  const open = types.reduce((a, t) => a + (rows[t].pending ?? 0) + (rows[t].running ?? 0), 0);
  const perMin = s.perMinute ?? 0;
  const sinceDone = s.lastDone ? tickAt - new Date(s.lastDone).getTime() : null;
  const sinceStart = tickAt - new Date(run.started_at).getTime();
  // "Working" only if a task finished recently; otherwise the run is not really moving.
  const moving = sinceDone != null && sinceDone < 90_000;
  const stalled = active && !moving && sinceStart > 60_000;

  let headline: { text: string; cls: string };
  if (run.status === "done") headline = { text: "Finished", cls: "bg-high/10 text-high" };
  else if (run.status === "paused") headline = { text: "Paused: " + (run.error ?? "blocked"), cls: "bg-low/10 text-low" };
  else if (run.status === "failed") headline = { text: "Failed: " + (run.error ?? ""), cls: "bg-low/10 text-low" };
  else if (moving && run.phase === "improve")
    headline = {
      text: `Improving data quality: round ${run.counts.improveRound ?? 1} of up to 8, ${(s.quality?.missing ?? 0).toLocaleString()} facilities still without a real location`,
      cls: "bg-high/10 text-high",
    };
  else if (moving) headline = { text: `Scraping: ${s.lastMinute} task(s) completed in the last minute`, cls: "bg-high/10 text-high" };
  else if (stalled && !s.ticking)
    headline = {
      text: "Nothing is processing. The run is open but no runner is active. Click “Nudge runner”, or run `npx tsx scripts/worker.ts` on your computer.",
      cls: "bg-low/10 text-low",
    };
  else if (stalled)
    headline = { text: "Runner holds the lease but no task has finished for 90s+. It may be waiting on a slow or blocked portal response.", cls: "bg-low/10 text-low" };
  else headline = { text: "Starting…", cls: "bg-muted/10 text-muted" };

  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="h2">
          Live status · run #{run.id} {run.kind}
          {run.params?.region ? ` (${String(run.params.region)})` : ""}
        </h2>
        <span className="text-xs text-muted">{offline ? "connection lost, retrying…" : "updates every 3s"}</span>
      </div>

      <div className={`rounded-md p-2 text-sm ${headline.cls}`}>{headline.text}</div>

      <div className="grid gap-2 text-xs text-muted sm:grid-cols-4">
        <div>
          Phase: <b className="text-ink">{run.phase ?? "—"}</b>
        </div>
        <div>
          Runner: <b className="text-ink">{s.ticking ? "active" : "idle"}</b>
        </div>
        <div>
          Last task finished: <b className="text-ink">{sinceDone != null ? ago(sinceDone) : "none yet"}</b>
        </div>
        <div>
          Speed: <b className="text-ink">{perMin.toFixed(1)}/min</b>
          {active && open > 0 && perMin > 0 && <> · queue left {eta(open / perMin)}</>}
        </div>
      </div>

      {s.quality && (
        <div className="rounded-md border border-line p-2 text-xs">
          <div className="mb-1 font-medium text-ink">Data quality now</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted">
            {["high", "medium", "low", "unchecked"].map((k) => (
              <span key={k}>
                {k}: <b className="text-ink">{(s.quality!.confidence[k] ?? 0).toLocaleString()}</b>
              </span>
            ))}
            <span>
              without a real location: <b className="text-ink">{s.quality.missing.toLocaleString()}</b>
            </span>
            {run.counts.improveRound != null && (
              <span>
                improve round: <b className="text-ink">{String(run.counts.improveRound)}</b>
                {run.counts.improveStopped ? ` (stopped: ${String(run.counts.improveStopped)})` : ""}
              </span>
            )}
            {run.counts.geocoded != null && (
              <span>
                geocoded this run: <b className="text-ink">{Number(run.counts.geocoded).toLocaleString()}</b>
              </span>
            )}
          </div>
        </div>
      )}

      {s.current && active && (
        <div className="text-xs text-muted">
          Working on: <b className="text-ink">{LABELS[s.current.type] ?? s.current.type}</b> {describe(s.current.type, s.current.payload)} (started{" "}
          {ago(tickAt - new Date(s.current.updated_at).getTime())})
        </div>
      )}

      <div className="space-y-2">
        {types.map((t) => {
          const done = rows[t].done ?? 0;
          const failed = rows[t].failed ?? 0;
          const n = total(t);
          const pct = n ? Math.round((done / n) * 100) : 0;
          return (
            <div key={t}>
              <div className="flex justify-between text-xs">
                <span>{LABELS[t] ?? t}</span>
                <span className="tabular-nums text-muted">
                  {done.toLocaleString()} / {n.toLocaleString()} ({pct}%){failed ? ` · ${failed} failed` : ""}
                </span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded bg-line">
                <div className="h-full bg-high" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
        {types.length === 0 && <div className="text-xs text-muted">No tasks queued yet.</div>}
      </div>

      <div className="text-xs text-muted">
        Collected so far:{" "}
        {[
          ["portal total", run.counts.listTotal],
          ["list rows", run.counts.listRows],
          ["ward rows", run.counts.wardRows],
          ["details saved", run.counts.details],
          ["validated", run.counts.validated],
          ["geocoded", run.counts.geocoded],
        ]
          .filter(([, v]) => v != null)
          .map(([k, v]) => `${k} ${Number(v).toLocaleString()}`)
          .join(" · ") || "nothing yet"}
      </div>

      {s.recent && s.recent.length > 0 && (
        <details className="text-xs" open>
          <summary className="cursor-pointer text-muted">Recent activity</summary>
          <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted">
            {s.recent.map((r, i) => (
              <li key={i} className={r.status === "failed" || r.last_error ? "text-low" : ""}>
                {new Date(r.updated_at).toLocaleTimeString()} · {r.status} · {LABELS[r.type] ?? r.type} {describe(r.type, r.payload)}
                {r.last_error ? ` — ${r.last_error.slice(0, 160)}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
