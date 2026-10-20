import { sql } from "drizzle-orm";
import { q } from "../db/client";

export type RunKind = "full" | "pilot" | "weekly" | "validate" | "improve" | "report";

export interface RunRow {
  id: number;
  kind: RunKind;
  status: string;
  phase: string | null;
  params: Record<string, unknown>;
  counts: Record<string, unknown>;
  started_at: string;
  finished_at: string | null;
  heartbeat_at: string | null;
  error: string | null;
}

export interface TaskRow {
  id: number;
  run_id: number;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export const MAX_ATTEMPTS = 3;

export async function createRun(kind: RunKind, params: Record<string, unknown> = {}): Promise<number> {
  const [r] = await q<{ id: number }>(sql`
    INSERT INTO job_runs (kind, status, params, counts) VALUES (${kind}, 'running', ${JSON.stringify(params)}::jsonb, '{}'::jsonb)
    RETURNING id`);
  return r.id;
}

export async function getRun(id: number): Promise<RunRow | null> {
  const [r] = await q<RunRow>(sql`SELECT * FROM job_runs WHERE id = ${id}`);
  return r ?? null;
}

export async function activeRuns(): Promise<RunRow[]> {
  return q<RunRow>(sql`SELECT * FROM job_runs WHERE status = 'running' ORDER BY id`);
}

export async function setRun(id: number, fields: { status?: string; phase?: string | null; error?: string | null; finished?: boolean }) {
  await q(sql`
    UPDATE job_runs SET
      status = coalesce(${fields.status ?? null}, status),
      phase = ${fields.phase === undefined ? sql`phase` : sql`${fields.phase}`},
      error = ${fields.error === undefined ? sql`error` : sql`${fields.error}`},
      finished_at = ${fields.finished ? sql`now()` : sql`finished_at`},
      heartbeat_at = now()
    WHERE id = ${id}`);
}

/** Merge numbers/values into job_runs.counts. */
export async function mergeCounts(id: number, counts: Record<string, unknown>) {
  await q(sql`UPDATE job_runs SET counts = counts || ${JSON.stringify(counts)}::jsonb WHERE id = ${id}`);
}

/** Add to numeric counters in job_runs.counts. */
export async function incrementCounts(id: number, inc: Record<string, number>) {
  const entries = Object.entries(inc).filter(([, v]) => v);
  if (!entries.length) return;
  let expr = sql`counts`;
  for (const [k, v] of entries) {
    expr = sql`jsonb_set(${expr}, ${`{${k}}`}::text[], to_jsonb(coalesce((counts->>${k})::numeric, 0) + ${v}))`;
  }
  await q(sql`UPDATE job_runs SET counts = ${expr}, heartbeat_at = now() WHERE id = ${id}`);
}

export async function enqueue(runId: number, type: string, payloads: Record<string, unknown>[], priority = 100) {
  for (let i = 0; i < payloads.length; i += 500) {
    const chunk = payloads.slice(i, i + 500);
    await q(sql`
      INSERT INTO job_tasks (run_id, type, payload, priority)
      VALUES ${sql.join(
        chunk.map((p) => sql`(${runId}, ${type}, ${JSON.stringify(p)}::jsonb, ${priority})`),
        sql`, `,
      )}`);
  }
  return payloads.length;
}

/** Task types that call the HFR portal. They share one request budget, so they run in their own lane(s). */
export const SCRAPE_TASK_TYPES = ["admin_regions", "admin_children", "list_page", "ward_list", "facility_detail"];

export type Lane = "scrape" | "compute";

/**
 * Claim the next task for a lane. Tasks stuck in "running" for 10 minutes (a crashed tick)
 * are picked up again. SKIP LOCKED keeps two runners from taking the same task.
 */
export async function claimTask(lane: Lane): Promise<TaskRow | null> {
  const types = sql.join(SCRAPE_TASK_TYPES.map((t) => sql`${t}`), sql`, `);
  const laneFilter = lane === "scrape" ? sql`t.type IN (${types})` : sql`t.type NOT IN (${types})`;
  const [t] = await q<TaskRow>(sql`
    UPDATE job_tasks SET status = 'running', attempts = attempts + 1, updated_at = now()
    WHERE id = (
      SELECT t.id FROM job_tasks t JOIN job_runs r ON r.id = t.run_id AND r.status = 'running'
      WHERE (t.status = 'pending' OR (t.status = 'running' AND t.updated_at < now() - interval '10 minutes'))
        AND ${laneFilter}
      ORDER BY t.priority, t.id
      LIMIT 1
      FOR UPDATE OF t SKIP LOCKED
    )
    RETURNING id, run_id, type, payload, attempts`);
  return t ?? null;
}

export async function completeTask(id: number) {
  await q(sql`UPDATE job_tasks SET status = 'done', last_error = NULL, updated_at = now() WHERE id = ${id}`);
}

/** Put a task back for retry, or mark it failed after MAX_ATTEMPTS. */
export async function failTask(id: number, error: string, opts: { noRetry?: boolean; refundAttempt?: boolean } = {}) {
  await q(sql`
    UPDATE job_tasks SET
      attempts = attempts - ${opts.refundAttempt ? 1 : 0},
      status = CASE WHEN ${!!opts.noRetry} OR attempts - ${opts.refundAttempt ? 1 : 0} >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
      last_error = ${error.slice(0, 2000)},
      updated_at = now()
    WHERE id = ${id}`);
}

export async function taskCounts(runId: number): Promise<Record<string, number>> {
  const rows = await q<{ status: string; n: number }>(sql`
    SELECT status, count(*)::int n FROM job_tasks WHERE run_id = ${runId} GROUP BY status`);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

export async function openTaskCount(runId: number): Promise<number> {
  const [r] = await q<{ n: number }>(sql`
    SELECT count(*)::int n FROM job_tasks WHERE run_id = ${runId} AND status IN ('pending', 'running')`);
  return Number(r?.n ?? 0);
}

/** True while any running run still has a pending or running task, whichever lane owns it. */
export async function anyOpenTasks(): Promise<boolean> {
  const rows = await q(sql`
    SELECT 1 FROM job_tasks t JOIN job_runs r ON r.id = t.run_id AND r.status = 'running'
    WHERE t.status IN ('pending', 'running') LIMIT 1`);
  return rows.length > 0;
}

export async function failedTaskCount(runId: number, types?: string[]): Promise<number> {
  const [r] = await q<{ n: number }>(sql`
    SELECT count(*)::int n FROM job_tasks WHERE run_id = ${runId} AND status = 'failed'
    ${types?.length ? sql`AND type IN (${sql.join(types.map((t) => sql`${t}`), sql`, `)})` : sql``}`);
  return Number(r?.n ?? 0);
}

export async function retryFailed(runId: number) {
  await q(sql`UPDATE job_tasks SET status = 'pending', attempts = 0, updated_at = now() WHERE run_id = ${runId} AND status = 'failed'`);
  await q(sql`UPDATE job_runs SET status = 'running', error = NULL, finished_at = NULL WHERE id = ${runId}`);
}

// ---- Runner lease -----------------------------------------------------------

export async function acquireLease(holder: string, seconds: number): Promise<boolean> {
  const rows = await q(sql`
    INSERT INTO runner_lease (id, holder, expires_at) VALUES (1, ${holder}, now() + make_interval(secs => ${seconds}))
    ON CONFLICT (id) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
      WHERE runner_lease.expires_at IS NULL OR runner_lease.expires_at < now() OR runner_lease.holder = ${holder}
    RETURNING id`);
  return rows.length > 0;
}

/**
 * Call right after winning the lease. Only one tick runs at a time, so a task still "running" now belongs to a runner that died
 * (dev-server restart, closed terminal, function timeout). Put it back at once instead of waiting for the 10-minute reclaim,
 * which would otherwise stall the run and make the next runner exit as "idle".
 */
export async function requeueOrphans(): Promise<number> {
  const rows = await q(sql`UPDATE job_tasks SET status = 'pending', updated_at = now() WHERE status = 'running' RETURNING id`);
  return rows.length;
}

export async function releaseLease(holder: string) {
  await q(sql`UPDATE runner_lease SET expires_at = NULL, holder = NULL WHERE id = 1 AND holder = ${holder}`);
}

export async function leaseInfo(): Promise<{ holder: string | null; expires_at: string | null } | null> {
  const [r] = await q<{ holder: string | null; expires_at: string | null }>(sql`SELECT holder, expires_at FROM runner_lease WHERE id = 1`);
  return r ?? null;
}
