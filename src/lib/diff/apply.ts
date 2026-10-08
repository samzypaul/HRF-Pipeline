import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { classifyChange, diffFields, type FieldDiff } from "./fields";

interface Joined {
  facility_code: string;
  hfr_id: number | null;
  data: Record<string, unknown>;
  hash: string;
  exists: boolean;
  old_hash: string | null;
  old: Record<string, unknown> | null;
  removed: boolean;
}

export interface DiffCounts {
  seen: number;
  new: number;
  updated: number;
  closed: number;
  reopened: number;
  reappeared: number;
  removed: number;
  wardAssigned: number;
  wardChanged: number;
  withoutWard: number;
}

const LIST_COLUMNS = [
  "name",
  "facility_type",
  "region_name",
  "council_name",
  "ownership_category",
  "ownership_authority",
  "moh_authority",
  "operating_status",
] as const;

async function recordChange(runId: number, code: string, type: string, diffs: FieldDiff[] | null) {
  await q(sql`
    INSERT INTO facility_changes (run_id, facility_code, change_type, field_diffs)
    VALUES (${runId}, ${code}, ${type}, ${diffs ? JSON.stringify(diffs) : null}::jsonb)`);
}

/**
 * Compare this run's list sweep with the facilities table:
 * insert new facilities, update changed ones, assign wards, and (only when the
 * sweep was complete) mark facilities that disappeared as removed.
 */
export async function applyListDiff(
  runId: number,
  opts: { allowRemovals: boolean; regionPrefix?: string },
): Promise<DiffCounts> {
  const counts: DiffCounts = {
    seen: 0,
    new: 0,
    updated: 0,
    closed: 0,
    reopened: 0,
    reappeared: 0,
    removed: 0,
    wardAssigned: 0,
    wardChanged: 0,
    withoutWard: 0,
  };

  const rows = await q<Joined>(sql`
    SELECT lr.facility_code, lr.hfr_id, lr.data, lr.hash,
           f.facility_code IS NOT NULL AS exists, f.list_hash AS old_hash,
           CASE WHEN f.facility_code IS NULL THEN NULL ELSE jsonb_build_object(
             'name', f.name, 'facility_type', f.facility_type, 'region_name', f.region_name, 'council_name', f.council_name,
             'ownership_category', f.ownership_category, 'ownership_authority', f.ownership_authority,
             'moh_authority', f.moh_authority, 'operating_status', f.operating_status) END AS old,
           f.removed_at IS NOT NULL AS removed
    FROM list_rows lr LEFT JOIN facilities f ON f.facility_code = lr.facility_code
    WHERE lr.run_id = ${runId}`);
  counts.seen = rows.length;

  // New facilities: one bulk insert + one bulk change record.
  const inserted = await q<{ facility_code: string }>(sql`
    INSERT INTO facilities (facility_code, hfr_id, name, facility_type, region_name, council_name, ownership_category,
      ownership_authority, moh_authority, operating_status, list_hash, first_seen, last_seen)
    SELECT lr.facility_code, lr.hfr_id, coalesce(lr.data->>'name', ''), lr.data->>'facility_type', lr.data->>'region_name',
      lr.data->>'council_name', lr.data->>'ownership_category', lr.data->>'ownership_authority',
      lr.data->>'moh_authority', lr.data->>'operating_status', lr.hash, now(), now()
    FROM list_rows lr WHERE lr.run_id = ${runId}
    ON CONFLICT (facility_code) DO NOTHING
    RETURNING facility_code`);
  counts.new = inserted.length;
  if (inserted.length) {
    await q(sql`
      INSERT INTO facility_changes (run_id, facility_code, change_type)
      SELECT ${runId}, x, 'new' FROM unnest(${sql.param(inserted.map((i) => i.facility_code))}::text[]) AS x`);
  }

  for (const r of rows) {
    const d = r.data;
    if (!r.exists) continue;
    if (r.removed) {
      await recordChange(runId, r.facility_code, "reappeared", null);
      counts.reappeared++;
    }
    if (r.old_hash !== r.hash) {
      const diffs = diffFields(r.old ?? {}, d, [...LIST_COLUMNS]);
      if (diffs.length) {
        const type = r.old_hash == null ? null : classifyChange(diffs);
        if (type) {
          await recordChange(runId, r.facility_code, type, diffs);
          counts[type]++;
        }
      }
      await q(sql`
        UPDATE facilities SET name = ${String(d.name ?? "")}, facility_type = ${d.facility_type as string},
          region_name = ${d.region_name as string}, council_name = ${d.council_name as string},
          ownership_category = ${d.ownership_category as string}, ownership_authority = ${d.ownership_authority as string},
          moh_authority = ${d.moh_authority as string}, operating_status = ${d.operating_status as string},
          list_hash = ${r.hash}, hfr_id = coalesce(${r.hfr_id}, hfr_id)
        WHERE facility_code = ${r.facility_code}`);
    }
  }

  // Everything seen in the list is alive.
  await q(sql`
    UPDATE facilities f SET last_seen = now(), removed_at = NULL
    FROM list_rows lr WHERE lr.run_id = ${runId} AND lr.facility_code = f.facility_code`);

  // Ward assignment from the ward sweep (ward code → council → region).
  const wardChanges = await q<{ facility_code: string; old_ward: string | null; new_ward: string }>(sql`
    SELECT f.facility_code, f.ward_code AS old_ward, wr.ward_code AS new_ward
    FROM ward_rows wr JOIN facilities f ON f.facility_code = wr.facility_code
    WHERE wr.run_id = ${runId} AND f.ward_code IS DISTINCT FROM wr.ward_code`);
  for (const w of wardChanges) {
    if (w.old_ward) {
      await recordChange(runId, w.facility_code, "updated", [{ field: "ward_code", from: w.old_ward, to: w.new_ward }]);
      counts.wardChanged++;
    }
  }
  const assigned = await q(sql`
    UPDATE facilities f SET
      ward_code = wr.ward_code,
      ward_name = coalesce(ward.name, f.ward_name),
      council_code = council.code,
      region_code = split_part(wr.ward_code, '.', 1) || '.' || split_part(wr.ward_code, '.', 2) || '.' || split_part(wr.ward_code, '.', 3)
    FROM ward_rows wr
    LEFT JOIN admin_units ward ON ward.code = wr.ward_code
    LEFT JOIN admin_units council ON council.code = ward.parent_code
    WHERE wr.run_id = ${runId} AND wr.facility_code = f.facility_code
    RETURNING 1`);
  counts.wardAssigned = assigned.length;

  // Removals only when the whole country was swept without failures.
  if (opts.allowRemovals && counts.seen > 0) {
    const gone = await q<{ facility_code: string }>(sql`
      UPDATE facilities f SET removed_at = now()
      WHERE f.removed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM list_rows lr WHERE lr.run_id = ${runId} AND lr.facility_code = f.facility_code)
      RETURNING facility_code`);
    for (const g of gone) await recordChange(runId, g.facility_code, "removed", null);
    counts.removed = gone.length;
  }

  const [nw] = await q<{ n: number }>(sql`
    SELECT count(*)::int n FROM facilities f
    WHERE f.removed_at IS NULL AND f.ward_code IS NULL
    ${opts.regionPrefix ? sql`AND EXISTS (SELECT 1 FROM list_rows lr WHERE lr.run_id = ${runId} AND lr.facility_code = f.facility_code)` : sql``}`);
  counts.withoutWard = Number(nw?.n ?? 0);
  return counts;
}
