import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { q } from "@/lib/db/client";
import { renderMarkdown } from "@/lib/notify/email";
import { PageHeader, fmtDate } from "@/components/ui";
import type { Verification } from "@/lib/ai/verify";
import { regenerateReportAction } from "../../actions";

export const dynamic = "force-dynamic";

interface Anomaly {
  title: string;
  detail: string;
  facility_codes?: string[];
}

export default async function ReportPage({ params }: { params: Promise<{ runId: string }> }) {
  const runId = Number((await params).runId);
  const [r] = await q<{
    summary_md: string;
    anomalies: Anomaly[];
    review_list: { facility_code: string; reason: string }[];
    verified: boolean;
    verification: Verification;
    model: string | null;
    created_at: string;
    emailed_at: string | null;
  }>(sql`SELECT * FROM weekly_reports WHERE run_id = ${runId}`);
  if (!r) notFound();
  const changes = await q<{ change_type: string; facility_code: string; name: string; region_name: string | null }>(sql`
    SELECT c.change_type, c.facility_code, f.name, f.region_name FROM facility_changes c JOIN facilities f USING (facility_code)
    WHERE c.run_id = ${runId} ORDER BY c.change_type, f.region_name, f.name LIMIT 500`);

  return (
    <div className="space-y-4">
      <PageHeader title={`Weekly report — run #${runId}`}>
        <form action={regenerateReportAction}>
          <input type="hidden" name="runId" value={runId} />
          <button className="btn">Regenerate</button>
        </form>
      </PageHeader>
      <p className="text-xs text-muted">
        Written {fmtDate(r.created_at)} {r.model ? `by ${r.model}` : "(no Gemini key: plain summary)"} · {r.emailed_at ? `emailed ${fmtDate(r.emailed_at)}` : "not emailed"}
      </p>
      {!r.verified && (
        <div className="card border-low/40 bg-low/5 text-sm">
          <strong className="text-low">Number check failed.</strong> These figures in the text were not found in the data:{" "}
          {r.verification?.unknown?.join(", ") || "—"}. The report was not emailed; regenerate it or read it with care.
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card prose-report lg:col-span-2" dangerouslySetInnerHTML={{ __html: renderMarkdown(r.summary_md ?? "") }} />
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
    </div>
  );
}
