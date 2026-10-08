import { after, NextResponse } from "next/server";
import { isCronRequest } from "@/lib/auth";
import { env } from "@/lib/env";
import { runTick } from "@/lib/jobs/runner";
import { kickTick } from "@/lib/jobs/kick";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: Request) {
  if (!isCronRequest(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  after(async () => {
    const result = await runTick(env.tickBudgetMs);
    console.log(`[tick] ${result.status} processed=${result.processed} failed=${result.failed} ms=${result.ms}`);
    if (result.status === "more") await kickTick("chain");
  });
  return NextResponse.json({ accepted: true }, { status: 202 });
}

export const GET = handle;
export const POST = handle;
