import Link from "next/link";
import { sql } from "drizzle-orm";
import { q } from "@/lib/db/client";
import { PageHeader, fmtDate, fmtPeriod } from "@/components/ui";
import { addDays, weekOf } from "@/lib/ai/weekly";
import { eatDay } from "@/lib/settings";
import { generateWeekReportAction } from "../actions";

export const dynamic = "force-dynamic";

type ReportType = "daily" | "weekly" | "all";
type Sp = { type?: string; from?: string; to?: string; check?: string; notice?: string };

const isDay = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

interface Row {
  id: number;
  kind: "daily" | "weekly";
  period_start: string;
  period_end: string;
  verified: boolean;
  emailed_at: string | null;
  model: string | null;
  changes: Record<string, number> | null;
  recs: number;
  days: number | null;
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const type: ReportType = sp.type === "weekly" || sp.type === "all" ? sp.type : "daily";
  const from = isDay(sp.from);
  const to = isDay(sp.to);
  const check = sp.check === "passed" || sp.check === "failed" ? sp.check : "";

  const where = [
    type === "all" ? sql`true` : sql`kind = ${type}`,
    from ? sql`period_end >= ${from}` : sql`true`,
    to ? sql`period_start <= ${to}` : sql`true`,
    check ? sql`verified = ${check === "passed"}` : sql`true`,
  ].reduce((a, b) => sql`${a} AND ${b}`);

  const reports = await q<Row>(sql`
    SELECT id, kind, period_start::text, period_end::text, verified, emailed_at, model,
           coalesce(digest->'changes_total', digest->'changes') AS changes,
           coalesce(jsonb_array_length(recommendations), 0)::int AS recs,
           jsonb_array_length(source_report_ids)::int AS days
    FROM reports WHERE ${where}
    ORDER BY period_start DESC, kind DESC, id DESC LIMIT 200`);

  const today = eatDay().date;
  const week = weekOf(today);
  const monthStart = `${today.slice(0, 8)}01`;
  const keep = (extra: Sp) => {
    const p = new URLSearchParams();
    const merged: Sp = { type, check, ...extra };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `?${p.toString()}`;
  };
  const presets = [
    { label: "Last 7 days", from: addDays(today, -6), to: today },
    { label: "Last 30 days", from: addDays(today, -29), to: today },
    { label: "This week", from: week.start, to: week.end },
    { label: "This month", from: monthStart, to: today },
    { label: "All time", from: undefined, to: undefined },
  ];
  const tab = (t: ReportType, label: string) => (
    <Link
      key={t}
      href={keep({ type: t, from, to })}
      className={`border-b-2 px-3 py-2 text-sm font-medium ${type === t ? "border-brand text-brand" : "border-transparent text-muted hover:text-ink"}`}
    >
      {label}
    </Link>
  );

  return (
    <div>
      <PageHeader title="Reports">
        <form action={generateWeekReportAction} className="flex items-center gap-2">
          <input className="input" type="date" name="date" defaultValue={today} max={today} aria-label="A day in the week" />
          <button className="btn">Build weekly report</button>
        </form>
      </PageHeader>

      {sp.notice && <div className="card mb-4 border-medium/40 bg-medium/5 text-sm">{sp.notice.slice(0, 300)}</div>}

      <div className="mb-4 flex flex-wrap gap-1 border-b border-line">
        {tab("daily", "Daily reports")}
        {tab("weekly", "Weekly reports")}
      </div>

      <form className="card mb-4 flex flex-wrap items-end gap-3" method="get">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Report type
          <select className="input" name="type" defaultValue={type}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="all">Daily and weekly</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          From
          <input className="input" type="date" name="from" defaultValue={from ?? ""} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          To
          <input className="input" type="date" name="to" defaultValue={to ?? ""} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Numbers check
          <select className="input" name="check" defaultValue={check}>
            <option value="">Any</option>
            <option value="passed">Passed</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <button className="btn btn-primary">Apply</button>
        <Link className="btn" href={`?type=${type}`}>
          Clear
        </Link>
        <div className="flex w-full flex-wrap items-center gap-2 pt-1 text-xs text-muted">
          Quick range:
          {presets.map((p) => (
            <Link key={p.label} className="rounded-full border border-line px-2 py-0.5 hover:bg-canvas" href={keep({ from: p.from, to: p.to })}>
              {p.label}
            </Link>
          ))}
        </div>
      </form>

      {reports.length === 0 ? (
        <div className="card text-sm text-muted">
          No {type === "all" ? "" : `${type} `}reports match. Daily reports are written at the end of each scheduled run; a weekly report is built from the
          week&apos;s daily reports once the week is complete.
        </div>
      ) : (
        <div className="card p-0">
          <table className="table">
            <thead>
              <tr>
                {type === "all" && <th>Type</th>}
                <th>{type === "weekly" ? "Week" : type === "all" ? "Period" : "Day"}</th>
                <th>New</th>
                <th>Changed</th>
                <th>Closed</th>
                <th>Removed</th>
                <th>Actions suggested</th>
                <th>Numbers checked</th>
                <th>Emailed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id} className="hover:bg-canvas">
                  {type === "all" && (
                    <td>
                      <span className={`badge ${r.kind === "weekly" ? "bg-brand-soft text-brand" : "bg-line text-muted"}`}>{r.kind}</span>
                    </td>
                  )}
                  <td>
                    <Link className="font-medium text-brand hover:underline" href={`/reports/${r.id}`}>
                      {r.kind === "weekly" ? `Week of ${fmtPeriod(r.period_start, r.period_end)}` : fmtPeriod(r.period_start, r.period_end)}
                    </Link>
                    {r.kind === "weekly" && r.days != null && <div className="text-xs text-muted">{r.days} daily report{r.days === 1 ? "" : "s"}</div>}
                  </td>
                  <td className="tabular-nums">{r.changes?.new ?? 0}</td>
                  <td className="tabular-nums">{r.changes?.updated ?? 0}</td>
                  <td className="tabular-nums">{r.changes?.closed ?? 0}</td>
                  <td className="tabular-nums">{r.changes?.removed ?? 0}</td>
                  <td className="tabular-nums">{r.recs || "—"}</td>
                  <td>{r.verified ? "✓ passed" : <span className="text-low">failed</span>}</td>
                  <td>{r.emailed_at ? fmtDate(r.emailed_at) : "—"}</td>
                  <td className="text-right">
                    <Link className="text-brand hover:underline" href={`/reports/${r.id}`}>
                      Open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {reports.length === 200 && <p className="mt-2 text-xs text-muted">Showing the latest 200. Narrow the date range to see older reports.</p>}
    </div>
  );
}
