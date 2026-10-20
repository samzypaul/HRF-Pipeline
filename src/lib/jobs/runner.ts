import { randomUUID } from "node:crypto";
import { env } from "../env";
import { HfrBlockedError, HfrClient } from "../hfr/client";
import { errorMessage, sleep } from "../util";
import {
  acquireLease,
  activeRuns,
  anyOpenTasks,
  claimTask,
  completeTask,
  failTask,
  getRun,
  openTaskCount,
  releaseLease,
  requeueOrphans,
  setRun,
  type Lane,
  type TaskRow,
} from "./queue";
import { advanceRun } from "./phases";
import { HANDLERS } from "./tasks";

export interface TickResult {
  status: "busy" | "idle" | "more" | "blocked";
  processed: number;
  failed: number;
  ms: number;
  message?: string;
}

/** Leave room at the end of a tick for the slowest task (detail + coords + services ≈ 3 requests). */
const SAFETY_MS = 25_000;

/** How long a lane waits before looking again when the other lanes may still produce work for it. */
const IDLE_POLL_MS = 1_500;

/**
 * Work through queued tasks until the time budget is used up.
 * Only one tick runs at a time (database lease). Inside a tick, scrape lanes fetch from the HFR portal
 * (which stays at its shared request rate) while compute lanes validate facilities in parallel.
 */
export async function runTick(budgetMs: number): Promise<TickResult> {
  const start = Date.now();
  const holder = randomUUID();
  const leaseSeconds = Math.ceil(budgetMs / 1000) + 60;
  if (!(await acquireLease(holder, leaseSeconds))) {
    return { status: "busy", processed: 0, failed: 0, ms: 0, message: "Another tick is running" };
  }
  const hfr = new HfrClient();
  const deadline = start + budgetMs - SAFETY_MS;
  let processed = 0;
  let failed = 0;
  let blocked: string | null = null;
  let lanesIdle = 0;
  let fatal: { error: unknown } | null = null;

  // Advancing a finished phase seeds tasks, so only one lane may do it at a time.
  let gate: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = gate.then(fn, fn);
    gate = result.catch(() => undefined);
    return result;
  };
  const advance = () =>
    exclusive(async () => {
      let queued = false;
      for (const run of await activeRuns()) {
        if ((await openTaskCount(run.id)) === 0) queued = (await advanceRun(run)) || queued;
      }
      return queued;
    });

  async function execute(task: TaskRow) {
    const run = await getRun(task.run_id);
    const handler = HANDLERS[task.type];
    if (!run || !handler) {
      await failTask(task.id, `No handler for task type ${task.type}`, { noRetry: true });
      failed++;
      return;
    }
    try {
      await handler(task, { hfr, run });
      await completeTask(task.id);
      processed++;
      console.log(`[run ${run.id}] ${task.type} ${JSON.stringify(task.payload).slice(0, 80)} ok (${processed} this tick)`);
    } catch (e) {
      failed++;
      console.error(`[run ${run.id}] ${task.type} failed: ${errorMessage(e)}`);
      if (e instanceof HfrBlockedError) {
        // Don't burn attempts while the portal is refusing us; pause the run.
        await failTask(task.id, errorMessage(e), { refundAttempt: true });
        await setRun(run.id, { status: "paused", error: `Paused: ${errorMessage(e)} — resume from the Admin page` });
        blocked = errorMessage(e);
        return;
      }
      await failTask(task.id, errorMessage(e));
    }
  }

  async function lane(kind: Lane) {
    try {
      while (!blocked && !fatal && Date.now() < deadline) {
        const task = await claimTask(kind);
        if (task) {
          await execute(task);
          continue;
        }
        // Nothing for this lane: move any finished phase on (this may queue new tasks).
        if (await advance()) continue;
        // Done only when no task is open anywhere; another lane may still be about to queue work for this one.
        if (await anyOpenTasks()) {
          await sleep(IDLE_POLL_MS);
          continue;
        }
        lanesIdle++;
        return;
      }
    } catch (error) {
      // An unexpected failure (e.g. the database is down) stops every lane before the lease is released.
      fatal ??= { error };
    }
  }

  const lanes: Lane[] = [
    ...Array.from({ length: env.scrapeLanes }, () => "scrape" as const),
    ...Array.from({ length: env.computeLanes }, () => "compute" as const),
  ];
  try {
    const orphans = await requeueOrphans();
    if (orphans) console.log(`[tick] requeued ${orphans} task(s) left running by a stopped runner`);
    await Promise.all(lanes.map(lane));
    if (fatal) throw (fatal as { error: unknown }).error;
    const ms = Date.now() - start;
    if (blocked) return { status: "blocked", processed, failed, ms, message: blocked };
    return { status: lanesIdle === lanes.length ? "idle" : "more", processed, failed, ms };
  } finally {
    await releaseLease(holder);
  }
}
