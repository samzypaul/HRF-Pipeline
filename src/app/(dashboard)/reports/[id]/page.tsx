import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { q } from "@/lib/db/client";
import { renderMarkdown } from "@/lib/notify/email";
import { PageHeader, fmtDate, fmtDay, fmtPeriod } from "@/components/ui";
import type { Verification } from "@/lib/ai/verify";
import type { Recommendation } from "@/lib/ai/write";
import { weekOf } from "@/lib/ai/weekly";
import { regenerateReportAction } from "../../actions";

export const dynamic = "force-dynamic";

interface Anomaly {
  title: string;
  detail: string;
  facility_codes?: string[];
}

interface DayRow {
  id: number;
  period_start: string;
  verified: boolean;
  changes: Record<string, number> | null;
  recs: number;
}

const PRIORITY_STYLE: Record<string, string> = {
  high: "bg-low/10 text-low",
  medium: "bg-medium/15 text-medium",
  low: "bg-line text-muted",
};

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const [r] = await q<{
    kind: "daily" | "weekly";
    run_id: number | null;
    period_start: string;
    period_end: string;
    summary_md: string;
    anomalies: Anomaly[];
    recommendations: Recommendation[] | null;
    review_list: { facility_code: string; reason: string }[];
    source_report_ids: number[] | null;
    verified: boolean;
    verification: Verification;
    model: string | null;
    created_at: string;
    emailed_at: string | null;
  }>(sql`SELECT kind, run_id, period_start::text, period_end::text, summary_md, anomalies, recommendations, review_list, source_report_ids,
                verified, verification, model, created_at, emailed_at FROM reports WHERE id = ${id}`);
  if (!r) notFound();
  const weekly = r.kind === "weekly";

  // Weekly: the daily reports it combines. Daily: the week report it belongs to, and its own change list.
  const days = weekly
    ? await q<DayRow>(sql`
        SELECT id, period_start::text, verified, digest->'changes' AS changes, coalesce(jsonb_array_length(recommendations), 0)::int AS recs
        FROM reports WHERE kind = 'daily' AND period_start BETWEEN ${r.period_start} AND ${r.period_end} ORDER BY period_start, id`)
    : [];
  const [parent] = weekly
    ? []
    : await q<{ id: number }>(sql`SELECT id FROM reports WHERE kind = 'weekly' AND period_start = ${weekOf(r.period_start).start}`);
  const changes =
    !weekly && r.run_id != null
      ? await q<{ change_type: string; facility_code: string; name: string; region_name: string | null }>(sql`
          SELECT c.change_type, c.facility_code, f.name, f.region_name FROM facility_changes c JOIN facilities f USING (facility_code)
          WHERE c.run_id = ${r.run_id} ORDER BY c.change_type, f.region_name, f.name LIMIT 500`)
      : [];
  // Neighbouring reports of the same kind, for previous / next links.
  const [prev] = await q<{ id: number }>(sql`SELECT id FROM reports WHERE kind = ${r.kind} AND period_start < ${r.period_start} ORDER BY period_start DESC LIMIT 1`);
  const [next] = await q<{ id: number }>(sql`SELECT id FROM reports WHERE kind = ${r.kind} AND period_start > ${r.period_start} ORDER BY period_start LIMIT 1`);

  const title = weekly ? `Weekly report — ${fmtPeriod(r.period_start, r.period_end)}` : `Daily report — ${fmtDay(r.period_start)}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Link className="text-brand hover:underline" href={`/reports?type=${r.kind}`}>
          ← All {r.kind} reports
        </Link>
        <div className="flex gap-3">
          {prev && (
            <Link className="text-brand hover:underline" href={`/reports/${prev.id}`}>
              ← Previous
            </Link>
          )}
          {next && (
            <Link className="text-brand hover:underline" href={`/reports/${next.id}`}>
              Next →
            </Link>
          )}
        </div>
      </div>
      <PageHeader title={title}>
        <form action={regenerateReportAction}>
          <input type="hidden" name="reportId" value={id} />
          <button className="btn">Regenerate</button>
        </form>
      </PageHeader>
      <p className="text-xs text-muted">
        Written {fmtDate(r.created_at)} {r.model ? `by ${r.model}` : "(plain summary: no AI used)"} · {r.emailed_at ? `emailed ${fmtDate(r.emailed_at)}` : "not emailed"}
        {!weekly && r.run_id != null && ` · pipeline run #${r.run_id}`}
        {parent && (
          <>
            {" · "}
            <Link className="text-brand underline" href={`/reports/${parent.id}`}>
              part of the weekly report
            </Link>
          </>
        )}
      </p>
      {!r.verified && (
        <div className="card border-low/40 bg-low/5 text-sm">
          <strong className="text-low">Number check failed.</strong> These figures in the text were not found in the data:{" "}
          {r.verification?.unknown?.join(", ") || "—"}. The report was not emailed; regenerate it or read it with care.
        </div>
      )}

      {weekly && (
        <div className="card p-0">
          <h2 className="h2 px-4 pt-4">Daily reports in this week</h2>
          <table className="table mt-2">
            <thead>
              <tr>
                <th>Day</th>
                <th>New</th>
                <th>Changed</th>
                <th>Closed</th>
                <th>Removed</th>
                <th>Actions suggested</th>
                <th>Numbers checked</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link className="font-medium text-brand hover:underline" href={`/reports/${d.id}`}>
                      {fmtDay(d.period_start)}
                    </Link>
                  </td>
                  <td className="tabular-nums">{d.changes?.new ?? 0}</td>
                  <td className="tabular-nums">{d.changes?.updated ?? 0}</td>
                  <td className="tabular-nums">{d.changes?.closed ?? 0}</td>
                  <td className="tabular-nums">{d.changes?.removed ?? 0}</td>
                  <td className="tabular-nums">{d.recs || "—"}</td>
                  <td>{d.verified ? "✓ passed" : <span className="text-low">failed</span>}</td>
                </tr>
              ))}
              {days.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-muted">
                    No daily reports for this week any more.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <div className="card prose-report" dangerouslySetInnerHTML={{ __html: renderMarkdown(r.summary_md ?? "") }} />
          <div className="card">
            <h2 className="h2 mb-2">Recommendations</h2>
            {r.recommendations?.length ? (
              <ol className="ml-4 list-decimal space-y-2 text-sm">
                {r.recommendations.map((x, i) => (
                  <li key={i}>
                    <span className="font-medium">{x.title}</span>{" "}
                    {x.priority && <span className={`badge ${PRIORITY_STYLE[x.priority] ?? PRIORITY_STYLE.low}`}>{x.priority}</span>}
                    <div className="text-muted">{x.detail}</div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted">No recommendations{r.model ? "." : " (they come from the AI summary, which was not used for this report)."}</p>
            )}
          </div>
        </div>
        <div className="space-y-4">
          <div className="card">
            <h2 className="h2 mb-2">Anomalies</h2>
            {r.anomalies?.length ? (
              <ul className="space-y-2 text-sm">
                {r.anomalies.map((a, i) => (
                  <li key={i}>
                    <div className="font-medium">{a.title}</div>
                    <div className="text-muted">{a.detail}</div>
                    {a.facility_codes?.length ? (
                      <div className="mt-1 flex flex-wrap gap-1 text-xs">
                        {a.facility_codes.map((c) => (
                          <Link key={c} className="text-brand underline" href={`/facility/${c}`}>
                            {c}
                          </Link>
                        ))}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">None flagged.</p>
            )}
          </div>
          <div className="card">
            <h2 className="h2 mb-2">Needs human review</h2>
            {r.review_list?.length ? (
              <ol className="ml-4 list-decimal space-y-1 text-sm">
                {r.review_list.map((x, i) => (
                  <li key={i}>
                    <Link className="text-brand underline" href={`/facility/${x.facility_code}`}>
                      {x.facility_code}
                    </Link>{" "}
                    <span className="text-muted">{x.reason}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted">Nothing listed.</p>
            )}
          </div>
        </div>
      </div>

      {!weekly && (
        <div className="card p-0">
          <h2 className="h2 px-4 pt-4">All changes in this run ({changes.length}{changes.length === 500 ? "+" : ""})</h2>
          <table className="table mt-2">
            <thead>
              <tr>
                <th>Change</th>
                <th>Facility</th>
                <th>Region</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c, i) => (
                <tr key={i}>
                  <td>{c.change_type}</td>
                  <td>
                    <Link className="text-brand hover:underline" href={`/facility/${c.facility_code}`}>
                      {c.name}
                    </Link>{" "}
                    <span className="text-xs text-muted">{c.facility_code}</span>
                  </td>
                  <td>{c.region_name ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
