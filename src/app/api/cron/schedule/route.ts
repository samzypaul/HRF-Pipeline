import { NextResponse } from "next/server";
import { isCronRequest } from "@/lib/auth";
import { startScheduledRun } from "@/lib/jobs/schedule";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Vercel Cron, once a day at 02:00 EAT (23:00 UTC). Starts the automatic run when the Admin settings say it is due
 * (weekly on the chosen weekday, or every day, from the chosen hour). The GitHub Actions worker runs the same check every
 * hour, so a run is never missed; the "started today" marker in the database stops it being started twice.
 */
export async function GET(req: Request) {
  if (!isCronRequest(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await startScheduledRun({ kick: true }));
}
