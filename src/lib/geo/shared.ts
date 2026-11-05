import { sql } from "drizzle-orm";
import { q } from "../db/client";

/**
 * Facilities that sit on exactly the same point. The point compared is the one the pipeline serves (the corrected point, which is the
 * HFR point when it was kept), rounded to 6 decimals (about 0.1 m). Two facilities on one point are either a data-entry slip in the
 * portal, a geocoder that returned the same place for two names, or a stand-in centre that several facilities share by design.
 *
 * Stored on `geo_validation`:
 *   shared_count        how many OTHER facilities are on this point (0 = not shared)
 *   shared_with         their names and codes, "NAME (CODE); NAME (CODE)", at most MAX_LISTED of them
 *   shared_emailed_with what the team was last told about this facility (see notify/shared.ts)
 */

export const MAX_LISTED = 10;

export interface LocatedFacility {
  code: string;
  name: string;
  lat: number | null;
  lng: number | null;
}

export interface Sharing {
  count: number;
  /** names and codes of the others, or null when the point is not shared */
  with: string | null;
}

export const pointKey = (lat: number, lng: number) => `${lat.toFixed(6)},${lng.toFixed(6)}`;

/** For every facility, who else is on its point. Facilities without a point are never shared. Pure, so it can be tested without a database. */
export function groupShared(facilities: LocatedFacility[]): Map<string, Sharing> {
  const byPoint = new Map<string, LocatedFacility[]>();
  for (const f of facilities) {
    if (f.lat == null || f.lng == null || !Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue;
    const key = pointKey(f.lat, f.lng);
    byPoint.set(key, [...(byPoint.get(key) ?? []), f]);
  }
  const out = new Map<string, Sharing>();
  for (const f of facilities) out.set(f.code, { count: 0, with: null });
  for (const members of byPoint.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
    for (const f of members) {
      const others = sorted.filter((o) => o.code !== f.code);
      const listed = others.slice(0, MAX_LISTED).map((o) => `${o.name} (${o.code})`);
      const more = others.length - listed.length;
      out.set(f.code, { count: others.length, with: listed.join("; ") + (more > 0 ? `; and ${more} more` : "") });
    }
  }
  return out;
}

/** "shared", "not shared", or "no location" for a data table. */
export function sharingStatus(hasPoint: boolean, sharedCount: number | null | undefined): "shared" | "not shared" | "no location" {
  if (!hasPoint) return "no location";
  return Number(sharedCount ?? 0) > 0 ? "shared" : "not shared";
}

/** The same status as SQL, for a query that has `g` (geo_validation) in scope. */
export const SHARING_STATUS_SQL = sql`CASE WHEN g.final_lat IS NULL THEN 'no location' WHEN coalesce(g.shared_count, 0) > 0 THEN 'shared' ELSE 'not shared' END`;

export interface SharedRefresh {
  facilities: number;
  groups: number;
  largest: number;
  changed: number;
}

/**
 * Work out which facilities share a point and store it. Safe to run any time. A facility that stops sharing is cleared, and its
 * "already emailed" marker with it, so a later change is reported again.
 */
export async function refreshSharedLocations(): Promise<SharedRefresh> {
  const rows = await q<{ code: string; name: string; lat: number | null; lng: number | null; removed: boolean; count: number; with: string | null }>(sql`
    SELECT f.facility_code AS code, f.name, g.final_lat AS lat, g.final_lng AS lng, f.removed_at IS NOT NULL AS removed,
           g.shared_count AS count, g.shared_with AS "with"
    FROM geo_validation g JOIN facilities f ON f.facility_code = g.facility_code`);
  const sharing = groupShared(rows.filter((r) => !r.removed).map((r) => ({ code: r.code, name: r.name, lat: r.lat, lng: r.lng })));

  const changed: { code: string; count: number; with: string }[] = [];
  let groups = 0;
  let largest = 0;
  let sharedFacilities = 0;
  for (const r of rows) {
    const s = sharing.get(r.code) ?? { count: 0, with: null };
    if (s.count > 0) {
      sharedFacilities++;
      largest = Math.max(largest, s.count + 1);
    }
    if (Number(r.count ?? 0) !== s.count || (r.with ?? null) !== s.with) changed.push({ code: r.code, count: s.count, with: s.with ?? "" });
  }
  // Each group of n facilities is counted n times above.
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.removed || r.lat == null || r.lng == null) continue;
    const s = sharing.get(r.code);
    if (s && s.count > 0) seen.add(pointKey(r.lat, r.lng));
  }
  groups = seen.size;

  for (let i = 0; i < changed.length; i += 1000) {
    const chunk = changed.slice(i, i + 1000);
    await q(sql`
      UPDATE geo_validation g SET shared_count = v.cnt, shared_with = nullif(v.txt, ''),
        shared_emailed_with = CASE WHEN v.cnt = 0 THEN NULL ELSE g.shared_emailed_with END
      FROM unnest(${sql.param(chunk.map((c) => c.code))}::text[], ${sql.param(chunk.map((c) => c.count))}::int[], ${sql.param(chunk.map((c) => c.with))}::text[]) AS v(code, cnt, txt)
      WHERE g.facility_code = v.code`);
  }
  return { facilities: sharedFacilities, groups, largest, changed: changed.length };
}
