import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { q } from "@/lib/db/client";
import { leaseInfo } from "@/lib/jobs/queue";
import { countMissingPoints } from "@/lib/jobs/phases";
import { errorMessage } from "@/lib/util";

export const dynamic = "force-dynamic";

/** Live progress of the current (or most recent) run, polled by the Admin page. */
export async function GET() {
  try {
    const [run] = await q<{
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
    }>(sql`
      SELECT * FROM job_runs
      ORDER BY (status IN ('running', 'paused')) DESC, id DESC LIMIT 1`);
    const lease = await leaseInfo();
    const ticking = !!lease?.expires_at && new Date(lease.expires_at).getTime() > Date.now();
    if (!run) return NextResponse.json({ run: null, ticking, now: Date.now() });

    const byType = await q<{ type: string; status: string; n: number }>(sql`
      SELECT type, status, count(*)::int n FROM job_tasks WHERE run_id = ${run.id} GROUP BY 1, 2`);
    const [rate] = await q<{ last_done: string | null; last_minute: number; last_5min: number }>(sql`
      SELECT max(updated_at) FILTER (WHERE status = 'done') last_done,
             count(*) FILTER (WHERE status = 'done' AND updated_at > now() - interval '1 minute')::int last_minute,
             count(*) FILTER (WHERE status = 'done' AND updated_at > now() - interval '5 minutes')::int last_5min
      FROM job_tasks WHERE run_id = ${run.id}`);
    const current = await q<{ type: string; payload: Record<string, unknown>; updated_at: string }>(sql`
      SELECT type, payload, updated_at FROM job_tasks
      WHERE run_id = ${run.id} AND status = 'running' ORDER BY updated_at DESC LIMIT 1`);
    const recent = await q<{ type: string; status: string; payload: Record<string, unknown>; last_error: string | null; updated_at: string }>(sql`
      SELECT type, status, payload, last_error, updated_at FROM job_tasks
      WHERE run_id = ${run.id} AND (status IN ('done', 'failed') OR last_error IS NOT NULL)
      ORDER BY updated_at DESC LIMIT 12`);

    const conf = await q<{ confidence: string | null; n: number }>(sql`
      SELECT g.confidence, count(*)::int n FROM facilities f
      LEFT JOIN geo_validation g ON g.facility_code = f.facility_code
      WHERE f.removed_at IS NULL GROUP BY 1`);
    const quality = {
      missing: await countMissingPoints(),
      confidence: Object.fromEntries(conf.map((c) => [c.confidence ?? "unchecked", Number(c.n)])),
    };

    return NextResponse.json({
      quality,
      run,
      ticking,
      leaseExpires: lease?.expires_at ?? null,
      byType,
      lastDone: rate?.last_done ?? null,
      perMinute: Number(rate?.last_5min ?? 0) / 5,
      lastMinute: Number(rate?.last_minute ?? 0),
      current: current[0] ?? null,
      recent,
      now: Date.now(),
    });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
