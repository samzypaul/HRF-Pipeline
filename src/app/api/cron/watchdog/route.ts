import { NextResponse } from "next/server";
import { isCronRequest } from "@/lib/auth";
import { activeRuns, leaseInfo } from "@/lib/jobs/queue";
import { kickTick } from "@/lib/jobs/kick";
import { sendDailyStatus, startIdleImprove } from "@/lib/jobs/schedule";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Daily safety net: restart the tick chain if a run is open but nothing is working on it. */
export async function GET(req: Request) {
  if (!isCronRequest(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const emailed = await sendDailyStatus();
  const runs = await activeRuns();
  if (runs.length === 0) {
    const improve = await startIdleImprove({ kick: true });
    return NextResponse.json({ ok: true, emailed, active: 0, ...(improve.started ? { improveStarted: improve.started, missing: improve.missing } : {}) });
  }
  const lease = await leaseInfo();
  const leaseLive = lease?.expires_at && new Date(lease.expires_at).getTime() > Date.now();
  if (leaseLive) return NextResponse.json({ ok: true, emailed, active: runs.length, ticking: true });
  const kicked = await kickTick("watchdog");
  return NextResponse.json({ ok: true, emailed, active: runs.length, restarted: kicked });
}
