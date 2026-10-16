import { NextResponse } from "next/server";
import { isCronRequest } from "@/lib/auth";
import { activeRuns, createRun } from "@/lib/jobs/queue";
import { kickTick } from "@/lib/jobs/kick";
import { eatDay, getSchedulerState, getSettings, runDueToday, setSchedulerState } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Vercel Cron, once a day at 02:00 EAT (23:00 UTC). Starts the automatic run when the Admin settings say
 * today is a run day (weekly on the chosen weekday, or every day).
 */
export async function GET(req: Request) {
  if (!isCronRequest(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const settings = await getSettings();
  if (!runDueToday(settings.schedule)) {
    return NextResponse.json({ skipped: `not a run day (schedule: ${settings.schedule.cadence})` });
  }
  const today = eatDay().date;
  if ((await getSchedulerState()).lastRunDate === today) {
    return NextResponse.json({ skipped: "already started today" });
  }
  const running = await activeRuns();
  if (running.some((r) => r.kind === "weekly")) {
    await kickTick("scheduled-already-running");
    return NextResponse.json({ skipped: "a scheduled run is already in progress" });
  }
  await setSchedulerState({ lastRunDate: today });
  const id = await createRun("weekly", { cadence: settings.schedule.cadence });
  await kickTick("scheduled-start");
  return NextResponse.json({ started: id });
}
