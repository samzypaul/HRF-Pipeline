import Link from "next/link";
import { sql } from "drizzle-orm";
import { q } from "@/lib/db/client";
import { PageHeader, fmtDate } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const reports = await q<{ run_id: number; created_at: string; verified: boolean; emailed_at: string | null; model: string | null; changes: Record<string, number> | null }>(sql`
    SELECT run_id, created_at, verified, emailed_at, model, digest->'changes' AS changes
    FROM weekly_reports ORDER BY created_at DESC LIMIT 100`);
  return (
    <div>
      <PageHeader title="Weekly reports" />
      {reports.length === 0 ? (
        <div className="card text-sm text-muted">No reports yet. The first one is written at the end of the first weekly run.</div>
      ) : (
        <div className="card p-0">
          <table className="table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Written</th>
                <th>New</th>
                <th>Changed</th>
                <th>Closed</th>
                <th>Removed</th>
                <th>Numbers checked</th>
                <th>Emailed</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.run_id}>
                  <td>
                    <Link className="font-medium text-brand hover:underline" href={`/reports/${r.run_id}`}>
                      #{r.run_id}
                    </Link>
                  </td>
                  <td>{fmtDate(r.created_at)}</td>
                  <td className="tabular-nums">{r.changes?.new ?? 0}</td>
                  <td className="tabular-nums">{r.changes?.updated ?? 0}</td>
                  <td className="tabular-nums">{r.changes?.closed ?? 0}</td>
                  <td className="tabular-nums">{r.changes?.removed ?? 0}</td>
                  <td>{r.verified ? "✓ passed" : <span className="text-low">failed</span>}</td>
                  <td>{r.emailed_at ? fmtDate(r.emailed_at) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
