/**
 * Write the daily reports that are missing for runs that did real work (at least 50 finished tasks).
 * Nothing is emailed and the weekly roll-up and the schedule are left alone.
 *
 *   npx tsx scripts/backfill-reports.ts [--since=2026-10-14]
 */
import "./_env";
import { sql } from "drizzle-orm";
import { closeDb, q } from "../src/lib/db/client";
import { generateDailyReport } from "../src/lib/ai/report";

async function main() {
  const since = process.argv.find((a) => a.startsWith("--since="))?.split("=")[1] ?? "2026-10-14";
  const runs = await q<{ id: number; kind: string; status: string; day: string }>(sql`
    SELECT r.id, r.kind, r.status, to_char(r.started_at AT TIME ZONE 'Africa/Dar_es_Salaam', 'YYYY-MM-DD') AS day
    FROM job_runs r
    WHERE r.started_at >= ${since}::date AND r.kind <> 'report'
      AND NOT EXISTS (SELECT 1 FROM reports rp WHERE rp.run_id = r.id)
      AND (SELECT count(*) FROM job_tasks t WHERE t.run_id = r.id AND t.status = 'done') >= 50
    ORDER BY r.id`);
  console.log(`${runs.length} run(s) need a report`);
  for (const r of runs) {
    const out = await generateDailyReport(r.id, { notify: false });
    console.log(`run ${r.id} (${r.kind}, ${r.status}, ${r.day}) -> report ${out.id}, numbers verified: ${out.verification.ok}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
