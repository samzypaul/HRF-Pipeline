/**
 * Run the pipeline from your own computer (no Vercel time limits).
 * Use this if the HFR portal blocks Vercel, or for the first big load.
 *
 *   npx tsx scripts/worker.ts                      # work through whatever is queued
 *   npx tsx scripts/worker.ts --start=pilot --region=TZ.CL.DO
 *   npx tsx scripts/worker.ts --start=full
 *   npx tsx scripts/worker.ts --start=weekly
 *   npx tsx scripts/worker.ts --start=validate
 */
import "./_env";
import { closeDb } from "../src/lib/db/client";
import { createRun, type RunKind } from "../src/lib/jobs/queue";
import { runTick } from "../src/lib/jobs/runner";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

async function main() {
  const start = arg("start") as RunKind | undefined;
  if (start) {
    const params: Record<string, unknown> = {};
    if (arg("region")) params.region = arg("region");
    const id = await createRun(start, params);
    console.log(`Started ${start} run #${id}`, params);
  }
  let total = 0;
  let crashes = 0;
  for (;;) {
    let r: Awaited<ReturnType<typeof runTick>>;
    try {
      r = await runTick(10 * 60_000);
      crashes = 0;
    } catch (e) {
      // A dropped database connection (Neon closes idle ones) must not end a long run: tasks left running are requeued on the next tick.
      if (++crashes > 5) throw e;
      console.warn(`[worker] tick failed (${e instanceof Error ? e.message : e}); retrying in 15 s (${crashes}/5)`);
      await new Promise((res) => setTimeout(res, 15_000));
      continue;
    }
    total += r.processed;
    console.log(`[worker] ${new Date().toISOString()} ${r.status} processed=${r.processed} failed=${r.failed} total=${total}`);
    if (r.status === "idle") break;
    if (r.status === "blocked") {
      console.error(`Blocked by the HFR portal: ${r.message}. Resume later from the Admin page or rerun this script.`);
      break;
    }
    if (r.status === "busy") await new Promise((res) => setTimeout(res, 30_000));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
