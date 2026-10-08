import { NextResponse } from "next/server";
import { isCronRequest } from "@/lib/auth";
import { activeRuns, createRun } from "@/lib/jobs/queue";
import { kickTick } from "@/lib/jobs/kick";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Vercel Cron: every Monday 02:00 EAT (Sunday 23:00 UTC). */
export async function GET(req: Request) {
  if (!isCronRequest(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const running = await activeRuns();
  if (running.some((r) => r.kind === "weekly")) {
    await kickTick("weekly-already-running");
    return NextResponse.json({ skipped: "a weekly run is already in progress" });
  }
  const id = await createRun("weekly");
  await kickTick("weekly-start");
  return NextResponse.json({ started: id });
}
