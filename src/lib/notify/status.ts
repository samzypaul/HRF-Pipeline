import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { env } from "../env";
import { monthKey } from "../util";
import { countMissingPoints } from "../jobs/phases";
import { describeSchedule, type Settings } from "../settings";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const n = (v: unknown) => Number(v ?? 0).toLocaleString("en-US");

interface RunLine {
  id: number;
  kind: string;
  status: string;
  phase: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  done: number;
  open: number;
  failed: number;
}

/** HTML body of the daily status email: what is running, what last finished, and the state of the data. */
export async function buildStatusEmail(settings: Settings): Promise<{ subject: string; html: string }> {
  const runs = await q<RunLine>(sql`
    SELECT r.id, r.kind, r.status, r.phase, r.error, r.started_at, r.finished_at,
           count(t.*) FILTER (WHERE t.status = 'done')::int done,
           count(t.*) FILTER (WHERE t.status IN ('pending', 'running'))::int "open",
           count(t.*) FILTER (WHERE t.status = 'failed')::int failed
    FROM (SELECT * FROM job_runs ORDER BY id DESC LIMIT 5) r LEFT JOIN job_tasks t ON t.run_id = r.id
    GROUP BY r.id, r.kind, r.status, r.phase, r.error, r.started_at, r.finished_at
    ORDER BY r.id DESC`);
  const open = runs.filter((r) => r.status === "running" || r.status === "paused");
  const lastFinished = runs.find((r) => r.status === "done" || r.status === "failed");

  const [totals] = await q<{ active: number }>(sql`SELECT count(*)::int active FROM facilities WHERE removed_at IS NULL`);
  const conf = await q<{ confidence: string | null; c: number }>(sql`
    SELECT g.confidence, count(*)::int c FROM facilities f LEFT JOIN geo_validation g USING (facility_code)
    WHERE f.removed_at IS NULL GROUP BY 1`);
  const missing = await countMissingPoints();
  const [failed24] = await q<{ c: number }>(sql`
    SELECT count(*)::int c FROM job_tasks WHERE status = 'failed' AND updated_at > now() - interval '24 hours'`);
  const [changes24] = await q<{ c: number }>(sql`
    SELECT count(DISTINCT facility_code)::int c FROM facility_changes WHERE created_at > now() - interval '24 hours'`);
  const usage = await q<{ provider: string; calls: number }>(sql`SELECT provider, calls FROM api_usage WHERE month = ${monthKey()} ORDER BY provider`);

  const when = (d: string | null) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
  const runLine = (r: RunLine) =>
    `<li>#${r.id} ${escapeHtml(r.kind)} — <b>${escapeHtml(r.status)}</b>${r.phase ? ` (phase: ${escapeHtml(r.phase)})` : ""} · tasks ${n(r.done)} done / ${n(r.open)} open / ${n(r.failed)} failed · started ${when(r.started_at)}${r.finished_at ? ` · finished ${when(r.finished_at)}` : ""}${r.error ? `<br><span style="color:#b42318">${escapeHtml(r.error)}</span>` : ""}</li>`;

  const needsAttention = open.some((r) => r.status === "paused") || runs[0]?.status === "failed" || Number(failed24?.c) > 0;
  const link = `<p><a href="${env.publicUrl}/admin">Open the admin page</a></p>`;
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:640px">
      <h2 style="margin:0 0 12px">HFR pipeline — daily status</h2>
      <h3>Runs</h3>
      ${open.length ? `<p>In progress:</p><ul>${open.map(runLine).join("")}</ul>` : "<p>Nothing is running right now.</p>"}
      ${lastFinished ? `<p>Last finished:</p><ul>${runLine(lastFinished)}</ul>` : ""}
      <p>Automatic runs: <b>${describeSchedule(settings.schedule)}</b>.</p>
      <h3>Data</h3>
      <ul>
        <li>Active facilities: <b>${n(totals?.active)}</b> (${n(changes24?.c)} changed in the last 24 h)</li>
        <li>Location confidence: ${conf.map((c) => `${escapeHtml(c.confidence ?? "unchecked")} ${n(c.c)}`).join(" · ") || "—"}</li>
        <li>Without a real location yet: <b>${n(missing)}</b></li>
        <li>Failed tasks in the last 24 h: <b>${n(failed24?.c)}</b></li>
      </ul>
      <h3>API usage this month</h3>
      <ul>${usage.map((u) => `<li>${escapeHtml(u.provider)}: ${n(u.calls)}</li>`).join("") || "<li>none</li>"}</ul>
      ${link}
    </div>`;
  return { subject: `HFR pipeline status${needsAttention ? " — needs attention" : ""}`, html };
}
