import { randomUUID } from "node:crypto";
import { HfrBlockedError, HfrClient } from "../hfr/client";
import { errorMessage } from "../util";
import {
  acquireLease,
  activeRuns,
  claimTask,
  completeTask,
  failTask,
  getRun,
  openTaskCount,
  releaseLease,
  setRun,
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

/**
 * Work through queued tasks until the time budget is used up.
 * Only one tick runs at a time (database lease), which also keeps
 * the HFR portal at a steady 1 request per second.
 */
export async function runTick(budgetMs: number): Promise<TickResult> {
  const start = Date.now();
  const holder = randomUUID();
  const leaseSeconds = Math.ceil(budgetMs / 1000) + 60;
  if (!(await acquireLease(holder, leaseSeconds))) {
    return { status: "busy", processed: 0, failed: 0, ms: 0, message: "Another tick is running" };
  }
  const hfr = new HfrClient();
  let processed = 0;
  let failed = 0;
  try {
    while (Date.now() - start < budgetMs - SAFETY_MS) {
      const task = await claimTask();
      if (!task) {
        // No open tasks: move any finished phase on (this may queue new tasks).
        let queued = false;
        for (const run of await activeRuns()) {
          if ((await openTaskCount(run.id)) === 0) queued = (await advanceRun(run)) || queued;
        }
        if (!queued) return { status: "idle", processed, failed, ms: Date.now() - start };
        continue;
      }
      const run = await getRun(task.run_id);
      const handler = HANDLERS[task.type];
      if (!run || !handler) {
        await failTask(task.id, `No handler for task type ${task.type}`, { noRetry: true });
        failed++;
        continue;
      }
      try {
        await handler(task, { hfr, run });
        await completeTask(task.id);
        processed++;
      } catch (e) {
        failed++;
        if (e instanceof HfrBlockedError) {
          // Don't burn attempts while the portal is refusing us; pause the run.
          await failTask(task.id, errorMessage(e), { refundAttempt: true });
          await setRun(run.id, { status: "paused", error: `Paused: ${errorMessage(e)} — resume from the Admin page` });
          return { status: "blocked", processed, failed, ms: Date.now() - start, message: errorMessage(e) };
        }
        await failTask(task.id, errorMessage(e));
      }
    }
    return { status: "more", processed, failed, ms: Date.now() - start };
  } finally {
    await releaseLease(holder);
  }
}
