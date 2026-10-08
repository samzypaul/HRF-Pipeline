import { sql, type SQL } from "drizzle-orm";
import { q } from "./db/client";

export interface Filters {
  region?: string;
  council?: string;
  confidence?: string;
  type?: string;
  q?: string;
  issue?: string; // outside_ward | missing_coords | no_match | low | no_ward
}

export function readFilters(sp: Record<string, string | string[] | undefined> | URLSearchParams): Filters {
  const get = (k: string) => {
    const v = sp instanceof URLSearchParams ? sp.get(k) : sp[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() ? s.trim() : undefined;
  };
  return { region: get("region"), council: get("council"), confidence: get("confidence"), type: get("type"), q: get("q"), issue: get("issue") };
}

export function whereFor(f: Filters): SQL {
  const parts: SQL[] = [sql`f.removed_at IS NULL`];
  if (f.region) parts.push(sql`f.region_code = ${f.region}`);
  if (f.council) parts.push(sql`f.council_code = ${f.council}`);
  if (f.type) parts.push(sql`f.facility_type = ${f.type}`);
  if (f.confidence) parts.push(f.confidence === "unchecked" ? sql`g.confidence IS NULL` : sql`g.confidence = ${f.confidence}`);
  if (f.q) parts.push(sql`(f.name ILIKE ${"%" + f.q + "%"} OR f.facility_code ILIKE ${f.q + "%"} OR f.common_name ILIKE ${"%" + f.q + "%"})`);
  switch (f.issue) {
    case "outside_ward":
      parts.push(sql`g.in_ward = false`);
      break;
    case "missing_coords":
      parts.push(sql`(f.hfr_lat IS NULL OR coalesce(g.sanity_flags, ARRAY[]::text[]) && ARRAY['missing','zero','portal_default','outside_tanzania']::text[])`);
      break;
    case "no_match":
      parts.push(sql`g.match_source = 'none'`);
      break;
    case "low":
      parts.push(sql`g.confidence = 'low'`);
      break;
    case "no_ward":
      parts.push(sql`f.ward_code IS NULL`);
      break;
    case "shared_point":
      parts.push(sql`'shared_point' = ANY(g.sanity_flags)`);
      break;
  }
  return sql.join(parts, sql` AND `);
}

export interface FacilityListItem {
  facility_code: string;
  name: string;
  facility_type: string | null;
  region_name: string | null;
  council_name: string | null;
  ward_name: string | null;
  operating_status: string | null;
  hfr_lat: number | null;
  hfr_lng: number | null;
  confidence: string | null;
  in_ward: boolean | null;
  match_source: string | null;
  name_score: number | null;
  distance_to_ward_m: number | null;
  final_lat: number | null;
  final_lng: number | null;
  geocode_source: string | null;
  notes: string | null;
  decision: string | null;
}

export async function listFacilities(f: Filters, page = 1, pageSize = 50) {
  const where = whereFor(f);
  const rows = await q<FacilityListItem>(sql`
    SELECT f.facility_code, f.name, f.facility_type, f.region_name, f.council_name, f.ward_name, f.operating_status,
           f.hfr_lat, f.hfr_lng, g.confidence, g.in_ward, g.match_source, g.name_score, g.distance_to_ward_m,
           g.final_lat, g.final_lng, g.geocode_source, g.notes, r.decision
    FROM facilities f
    LEFT JOIN geo_validation g ON g.facility_code = f.facility_code
    LEFT JOIN review_decisions r ON r.facility_code = f.facility_code
    WHERE ${where}
    ORDER BY f.region_name NULLS LAST, f.council_name NULLS LAST, f.name
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
  const [c] = await q<{ n: number }>(sql`
    SELECT count(*)::int n FROM facilities f LEFT JOIN geo_validation g ON g.facility_code = f.facility_code WHERE ${where}`);
  return { rows, total: Number(c?.n ?? 0) };
}

export async function filterOptions() {
  const regions = await q<{ code: string; name: string }>(sql`SELECT code, name FROM admin_units WHERE level = 1 ORDER BY name`);
  const types = await q<{ t: string }>(sql`
    SELECT DISTINCT facility_type t FROM facilities WHERE facility_type IS NOT NULL ORDER BY 1`);
  return { regions, types: types.map((t) => t.t) };
}

export async function councilsOf(region: string) {
  return q<{ code: string; name: string }>(sql`
    SELECT c.code, c.name FROM admin_units c JOIN admin_units d ON d.code = c.parent_code
    WHERE c.level = 3 AND d.parent_code = ${region} ORDER BY c.name`);
}
