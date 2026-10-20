import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { buildStatusEmail } from "../notify/status";
import { sendStatusEmail } from "../notify/email";
import { eatDay, eatHour, getSchedulerState, getSettings, runDueToday, setSchedulerState } from "../settings";
import { kickTick } from "./kick";
import { countMissingPoints } from "./phases";
import { activeRuns, createRun } from "./queue";

/** The status email goes out from this hour (East Africa Time) on, once a day. */
export const DAILY_EMAIL_HOUR = 7;

/**
 * The scheduled tasks of the pipeline in one place, so Vercel Cron and the GitHub Actions worker both run the same logic.
 * Every task is safe to call as often as you like: the "already done today" markers live in the database.
 */

/** Start the automatic run when the Admin schedule says it is due (day, and hour in East Africa Time). */
export async function startScheduledRun(opts: { kick: boolean }): Promise<{ started?: number; skipped?: string }> {
  const settings = await getSettings();
  if (!runDueToday(settings.schedule)) {
    return { skipped: `not due (schedule: ${settings.schedule.cadence}, from ${String(settings.schedule.hour).padStart(2, "0")}:00 EAT)` };
  }
  const today = eatDay().date;
  if ((await getSchedulerState()).lastRunDate === today) return { skipped: "already started today" };
  const running = await activeRuns();
  if (running.some((r) => r.kind === "weekly")) {
    if (opts.kick) await kickTick("scheduled-already-running");
    return { skipped: "a scheduled run is already in progress" };
  }
  await setSchedulerState({ lastRunDate: today });
  const id = await createRun("weekly", { cadence: settings.schedule.cadence });
  if (opts.kick) await kickTick("scheduled-start");
  return { started: id };
}

/** Morning status email, once per day, when switched on in Admin. A mail failure never blocks anything else. */
export async function sendDailyStatus(): Promise<boolean> {
  try {
    const settings = await getSettings();
    const today = eatDay().date;
    if (!settings.dailyEmail.enabled || eatHour() < DAILY_EMAIL_HOUR || (await getSchedulerState()).lastEmailDate === today) return false;
    const { subject, html } = await buildStatusEmail(settings);
    const sent = await sendStatusEmail(subject, html);
    if (sent) await setSchedulerState({ lastEmailDate: today });
    return sent;
  } catch (e) {
    console.error("[schedule] status email failed", e);
    return false;
  }
}

/** When nothing is running, keep geocoding facilities that still have no real location (at most once a day). */
export async function startIdleImprove(opts: { kick: boolean }): Promise<{ started?: number; missing?: number }> {
  if ((await activeRuns()).length > 0) return {};
  const [recent] = await q<{ n: number }>(sql`
    SELECT count(*)::int n FROM job_runs WHERE kind = 'improve' AND started_at > now() - interval '20 hours'`);
  const missing = Number(recent?.n) === 0 ? await countMissingPoints() : 0;
  if (missing === 0) return {};
  const id = await createRun("improve");
  if (opts.kick) await kickTick("auto-improve");
  return { started: id, missing };
}

/** Everything that is due now. The GitHub Actions worker calls this before it starts working. */
export async function runScheduledTasks(opts: { kick: boolean }) {
  const run = await startScheduledRun(opts);
  const emailed = await sendDailyStatus();
  const improve = await startIdleImprove(opts);
  return { run, emailed, improve };
}
