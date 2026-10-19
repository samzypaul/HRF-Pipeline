import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { applyListDiff } from "../diff/apply";
import { flagSharedPoints } from "../geo/validate";
import { matchWards } from "../geo/wards";
import { notifyPendingCorrections } from "../notify/approvals";
import { enqueue, failedTaskCount, getRun, mergeCounts, setRun, type RunKind, type RunRow } from "./queue";

export const PIPELINES: Record<RunKind, string[]> = {
  full: ["admin", "list", "wards", "diff", "details", "validate", "improve", "finalize"],
  pilot: ["admin", "list", "wards", "diff", "details", "validate", "finalize"],
  weekly: ["admin", "list", "wards", "diff", "details", "validate", "improve", "finalize", "report"],
  validate: ["validate", "finalize"],
  improve: ["improve", "finalize"],
  report: ["report"],
};

/** Improve rounds stop after this many passes, or sooner when a pass finds nothing new. */
const MAX_IMPROVE_ROUNDS = 8;

/** Active facilities with no real location yet: no point at all, or only a village/ward-centre stand-in. */
const NO_POINT = sql`(g.facility_code IS NULL OR g.final_lat IS NULL OR g.geocode_source IN ('ward_centroid', 'village_centroid', 'council_centroid'))`;

export async function countMissingPoints(): Promise<number> {
  const [r] = await q<{ n: number }>(sql`
    SELECT count(*)::int n FROM facilities f
    LEFT JOIN geo_validation g ON g.facility_code = f.facility_code
    WHERE f.removed_at IS NULL AND ${NO_POINT}`);
  return Number(r?.n ?? 0);
}

function batchByWard(rows: { facility_code: string; ward_code: string | null }[]) {
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
  return batches;
}

/**
 * Data-quality pass. Round 1 re-checks every facility that is not high confidence (and has no reviewer decision);
 * later rounds repeat only for facilities still without a real location, until all are found
 * or a round makes no progress.
 */
async function seedImprove(run: RunRow): Promise<number> {
  const fresh = (await getRun(run.id)) ?? run;
  const round = Number(fresh.counts.improveRound ?? 0);
  const previous = fresh.counts.improveRemaining as number | undefined;
  const remaining = round === 0 ? undefined : await countMissingPoints();
  if (round > 0 && (remaining === 0 || round >= MAX_IMPROVE_ROUNDS || (previous != null && remaining! >= previous))) {
    await mergeCounts(run.id, { improveRemaining: remaining, improveStopped: remaining === 0 ? "all located" : "no further progress" });
    return 0;
  }
  const rows = await q<{ facility_code: string; ward_code: string | null }>(sql`
    SELECT f.facility_code, f.ward_code FROM facilities f
    LEFT JOIN geo_validation g ON g.facility_code = f.facility_code
    LEFT JOIN review_decisions rd ON rd.facility_code = f.facility_code
    WHERE f.removed_at IS NULL AND rd.facility_code IS NULL
      AND ${round === 0 ? sql`(g.facility_code IS NULL OR g.confidence IS DISTINCT FROM 'high')` : NO_POINT}
    ORDER BY f.ward_code NULLS LAST, f.facility_code`);
  await mergeCounts(run.id, { improveRound: round + 1, improveRemaining: remaining ?? (await countMissingPoints()), improveQueued: rows.length });
  return enqueue(run.id, "validate_batch", batchByWard(rows), 50);
}

/** Not yet validated since this run started (needs the geo_validation join aliased as g). */
const notValidatedThisRun = (run: RunRow) => sql`(g.checked_at IS NULL OR g.checked_at < ${run.started_at}::timestamptz)`;

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
        // Daily runs refresh a seventh as many details, so the portal sees the same load as with a weekly run.
        const fraction = Number(process.env.DETAIL_REFRESH_FRACTION ?? 0.25) / (run.params.cadence === "daily" ? 7 : 1);
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
            AND f.removed_at IS NULL
          ORDER BY f.ward_code NULLS LAST, f.facility_code`);
      } else {
        // Ward order lets the validate batches that start while details are still being fetched share their ward lookups.
        rows = await q(sql`
          SELECT f.facility_code, f.hfr_id FROM facilities f
          WHERE f.removed_at IS NULL ${scopeFilter(run)}
          ORDER BY f.ward_code NULLS LAST, f.facility_code`);
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
            AND ${notValidatedThisRun(run)}
          ORDER BY f.ward_code NULLS LAST, f.facility_code`);
      } else {
        // The details phase already queued validation for every facility it finished, so only the rest are left here.
        // A "validate" run exists to re-check everything, so it skips nothing.
        rows = await q(sql`
          SELECT f.facility_code, f.ward_code FROM facilities f
          LEFT JOIN geo_validation g ON g.facility_code = f.facility_code
          WHERE f.removed_at IS NULL ${run.kind === "validate" ? sql`` : sql`AND ${notValidatedThisRun(run)} ${scopeFilter(run)}`}
          ORDER BY f.ward_code NULLS LAST, f.facility_code`);
      }
      // One task per ward (max 20 facilities), so OSM/ward lookups are shared.
      const batches = batchByWard(rows);
      await mergeCounts(run.id, { validateQueued: rows.length });
      return enqueue(run.id, "validate_batch", batches, 50);
    }

    case "improve":
      return seedImprove(run);

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
      // Ask the approvers to look at newly corrected points. A mail problem must never fail the run.
      try {
        const n = await notifyPendingCorrections();
        await mergeCounts(run.id, { approvalEmail: n.sent ? `sent (${n.pending} new)` : (n.reason ?? "not sent") });
      } catch (e) {
        console.error(`[run ${run.id}] approval email failed`, e);
        await mergeCounts(run.id, { approvalEmail: `failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) });
      }
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
  // Improve repeats itself while geocoding keeps finding locations.
  if (run.phase === "improve" && (await seedPhase(run, "improve")) > 0) return true;
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
