import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { applyListDiff } from "../diff/apply";
import { flagSharedPoints } from "../geo/validate";
import { matchWards } from "../geo/wards";
import { enqueue, failedTaskCount, mergeCounts, setRun, type RunKind, type RunRow } from "./queue";

export const PIPELINES: Record<RunKind, string[]> = {
  full: ["admin", "list", "wards", "diff", "details", "validate", "finalize"],
  pilot: ["admin", "list", "wards", "diff", "details", "validate", "finalize"],
  weekly: ["admin", "list", "wards", "diff", "details", "validate", "finalize", "report"],
  validate: ["validate", "finalize"],
  report: ["report"],
};

const regionOf = (run: RunRow) => (run.params.region as string | undefined) || undefined;

/** Facilities in scope for a run (whole country, or one region for a pilot). */
function scopeFilter(run: RunRow) {
  const region = regionOf(run);
  if (region) {
    return sql`AND (f.region_code = ${region} OR f.facility_code IN (SELECT facility_code FROM list_rows WHERE run_id = ${run.id}))`;
  }
  return sql``;
}

/**
 * Start a phase. Returns the number of tasks it queued (0 = nothing to wait for,
 * the runner moves straight on to the next phase).
 */
async function seedPhase(run: RunRow, phase: string): Promise<number> {
  const region = regionOf(run);
  switch (phase) {
    case "admin":
      return enqueue(run.id, "admin_regions", [{}], 5);

    case "list":
      return enqueue(run.id, "list_page", [{ page: 1, region }], 15);

    case "wards": {
      const wards = await q<{ code: string }>(sql`
        SELECT code FROM admin_units WHERE level = 4
        ${region ? sql`AND code LIKE ${region + ".%"}` : sql``}
        ORDER BY code`);
      return enqueue(run.id, "ward_list", wards.map((w) => ({ ward: w.code, page: 1 })), 25);
    }

    case "diff": {
      // The admin tree may have new wards: refresh the ward ↔ boundary links first.
      const [{ n: boundaries }] = await q<{ n: number }>(sql`SELECT count(*)::int n FROM ward_boundaries`);
      if (Number(boundaries) > 0) {
        const m = await matchWards();
        await mergeCounts(run.id, { wardMatch: { matched: m.matched, unmatched: m.unmatched.length, total: m.totalWards } });
      }
      const listFailures = await failedTaskCount(run.id, ["list_page", "ward_list"]);
      const counts = await applyListDiff(run.id, {
        allowRemovals: !region && listFailures === 0 && run.kind !== "pilot",
        regionPrefix: region,
      });
      await mergeCounts(run.id, { diff: counts, listFailures });
      return 0;
    }

    case "details": {
      let rows: { facility_code: string; hfr_id: number | null }[];
      if (run.kind === "weekly") {
        const fraction = Number(process.env.DETAIL_REFRESH_FRACTION ?? 0.25);
        rows = await q(sql`
          WITH changed AS (
            SELECT DISTINCT facility_code FROM facility_changes
            WHERE run_id = ${run.id} AND change_type IN ('new', 'updated', 'reopened', 'reappeared', 'closed')
          ), never AS (
            SELECT facility_code FROM facilities WHERE last_detail_at IS NULL AND removed_at IS NULL
          ), stale AS (
            SELECT facility_code FROM facilities WHERE removed_at IS NULL AND last_detail_at IS NOT NULL
            ORDER BY last_detail_at ASC
            LIMIT (SELECT ceil(count(*) * ${fraction}::numeric)::int FROM facilities WHERE removed_at IS NULL)
          )
          SELECT f.facility_code, f.hfr_id FROM facilities f
          WHERE f.facility_code IN (SELECT facility_code FROM changed UNION SELECT facility_code FROM never UNION SELECT facility_code FROM stale)
            AND f.removed_at IS NULL`);
      } else {
        rows = await q(sql`
          SELECT f.facility_code, f.hfr_id FROM facilities f
          WHERE f.removed_at IS NULL ${scopeFilter(run)}
          ORDER BY f.facility_code`);
      }
      await mergeCounts(run.id, { detailsQueued: rows.length });
      return enqueue(run.id, "facility_detail", rows.map((r) => ({ code: r.facility_code, hfrId: r.hfr_id })), 40);
    }

    case "validate": {
      let rows: { facility_code: string; ward_code: string | null }[];
      if (run.kind === "weekly") {
        rows = await q(sql`
          SELECT f.facility_code, f.ward_code FROM facilities f
          LEFT JOIN geo_validation g ON g.facility_code = f.facility_code
          WHERE f.removed_at IS NULL AND (f.last_detail_at >= ${run.started_at}::timestamptz OR g.facility_code IS NULL
            OR f.facility_code IN (SELECT facility_code FROM facility_changes WHERE run_id = ${run.id}))
          ORDER BY f.ward_code NULLS LAST, f.facility_code`);
      } else {
        rows = await q(sql`
          SELECT f.facility_code, f.ward_code FROM facilities f
          WHERE f.removed_at IS NULL ${run.kind === "validate" ? sql`` : scopeFilter(run)}
          ORDER BY f.ward_code NULLS LAST, f.facility_code`);
      }
      // One task per ward (max 20 facilities), so OSM/ward lookups are shared.
      const batches: { codes: string[] }[] = [];
      let current: string[] = [];
      let currentWard: string | null | undefined = undefined;
      for (const r of rows) {
        if (current.length >= 20 || (currentWard !== undefined && r.ward_code !== currentWard)) {
          batches.push({ codes: current });
          current = [];
        }
        current.push(r.facility_code);
        currentWard = r.ward_code;
      }
      if (current.length) batches.push({ codes: current });
      await mergeCounts(run.id, { validateQueued: rows.length });
      return enqueue(run.id, "validate_batch", batches, 50);
    }

    case "finalize": {
      const shared = await flagSharedPoints();
      const conf = await q<{ confidence: string | null; n: number }>(sql`
        SELECT g.confidence, count(*)::int n FROM facilities f
        LEFT JOIN geo_validation g ON g.facility_code = f.facility_code
        WHERE f.removed_at IS NULL GROUP BY g.confidence`);
      await mergeCounts(run.id, {
        sharedPointFlags: shared,
        confidence: Object.fromEntries(conf.map((c) => [c.confidence ?? "unchecked", Number(c.n)])),
      });
      // Staging rows are only needed for the diff.
      await q(sql`DELETE FROM list_rows WHERE run_id < ${run.id} - 5`);
      await q(sql`DELETE FROM ward_rows WHERE run_id < ${run.id} - 5`);
      return 0;
    }

    case "report": {
      const target = run.kind === "report" ? Number(run.params.runId) : run.id;
      return enqueue(run.id, "weekly_report", [{ runId: target }], 60);
    }

    default:
      throw new Error(`Unknown phase ${phase}`);
  }
}

/**
 * Move a run whose current phase has no open tasks on to its next phase.
 * Returns true when new work was queued.
 */
export async function advanceRun(run: RunRow): Promise<boolean> {
  const steps = PIPELINES[run.kind];
  let idx = run.phase ? steps.indexOf(run.phase) : -1;
  while (true) {
    idx++;
    if (idx >= steps.length) {
      const failed = await failedTaskCount(run.id);
      await setRun(run.id, { status: "done", phase: null, finished: true, error: failed ? `${failed} task(s) failed` : null });
      return false;
    }
    const phase = steps[idx];
    const previous = idx > 0 ? steps[idx - 1] : null;
    await setRun(run.id, { phase });
    let queued: number;
    try {
      queued = await seedPhase({ ...run, phase }, phase);
    } catch (e) {
      // Leave the run on the previous phase so "Resume" retries this one.
      await setRun(run.id, {
        status: "failed",
        phase: previous,
        error: `Phase "${phase}" failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      console.error(`[run ${run.id}] phase ${phase} failed`, e);
      return false;
    }
    if (queued > 0) return true;
  }
}
