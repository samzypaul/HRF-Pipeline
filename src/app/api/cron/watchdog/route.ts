import { NextResponse } from "next/server";
import { isCronRequest } from "@/lib/auth";
import { activeRuns, leaseInfo } from "@/lib/jobs/queue";
import { kickTick } from "@/lib/jobs/kick";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Daily safety net: restart the tick chain if a run is open but nothing is working on it. */
export async function GET(req: Request) {
  if (!isCronRequest(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const runs = await activeRuns();
  if (runs.length === 0) return NextResponse.json({ ok: true, active: 0 });
  const lease = await leaseInfo();
  const leaseLive = lease?.expires_at && new Date(lease.expires_at).getTime() > Date.now();
  if (leaseLive) return NextResponse.json({ ok: true, active: runs.length, ticking: true });
  const kicked = await kickTick("watchdog");
  return NextResponse.json({ ok: true, active: runs.length, restarted: kicked });
}
