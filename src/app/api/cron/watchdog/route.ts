import { NextResponse } from "next/server";
import { isCronRequest } from "@/lib/auth";
import { sql } from "drizzle-orm";
import { q } from "@/lib/db/client";
import { activeRuns, createRun, leaseInfo } from "@/lib/jobs/queue";
import { countMissingPoints } from "@/lib/jobs/phases";
import { kickTick } from "@/lib/jobs/kick";
import { eatDay, getSchedulerState, getSettings, setSchedulerState } from "@/lib/settings";
import { buildStatusEmail } from "@/lib/notify/status";
import { sendStatusEmail } from "@/lib/notify/email";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Morning status email (07:00 EAT), once per day, when switched on in Admin. A mail failure never blocks the watchdog. */
async function sendDailyStatus(): Promise<boolean> {
  try {
    const settings = await getSettings();
    const today = eatDay().date;
    if (!settings.dailyEmail.enabled || (await getSchedulerState()).lastEmailDate === today) return false;
    const { subject, html } = await buildStatusEmail(settings);
    const sent = await sendStatusEmail(subject, html);
    if (sent) await setSchedulerState({ lastEmailDate: today });
    return sent;
  } catch (e) {
    console.error("[watchdog] status email failed", e);
    return false;
  }
}

/** Daily safety net: restart the tick chain if a run is open but nothing is working on it. */
export async function GET(req: Request) {
  if (!isCronRequest(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const emailed = await sendDailyStatus();
  const runs = await activeRuns();
  if (runs.length === 0) {
    // Idle: keep geocoding facilities that still have no real location (at most once a day).
    const [recent] = await q<{ n: number }>(sql`
      SELECT count(*)::int n FROM job_runs WHERE kind = 'improve' AND started_at > now() - interval '20 hours'`);
    const missing = Number(recent?.n) === 0 ? await countMissingPoints() : 0;
    if (missing > 0) {
      const id = await createRun("improve");
      await kickTick("auto-improve");
      return NextResponse.json({ ok: true, emailed, active: 0, improveStarted: id, missing });
    }
    return NextResponse.json({ ok: true, emailed, active: 0 });
  }
  const lease = await leaseInfo();
  const leaseLive = lease?.expires_at && new Date(lease.expires_at).getTime() > Date.now();
  if (leaseLive) return NextResponse.json({ ok: true, emailed, active: runs.length, ticking: true });
  const kicked = await kickTick("watchdog");
  return NextResponse.json({ ok: true, emailed, active: runs.length, restarted: kicked });
}
