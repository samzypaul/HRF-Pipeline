import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { ratio } from "./name-match";
import { normAdmin } from "./wards";

export type VillageCheck = "agrees" | "differs" | "unknown";

export interface VillageResult {
  check: VillageCheck;
  /** village polygon under the point (null when none) */
  village: string | null;
  /** the ward that polygon belongs to */
  ward: string | null;
  /** the polygon's ward is not the facility's ward: the point is probably in the wrong place (or the boundary file is out of date) */
  wardDiffers: boolean;
}

const SAME_NAME = 80;

/** Does a boundary name match the HFR name? Compared after dropping words like "ward"/"kata". */
function same(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normAdmin(a);
  const y = normAdmin(b);
  return !!x && !!y && ratio(x, y) >= SAME_NAME;
}

/** Compare the village polygon found under a point with the facility's HFR village and ward. Pure, so it can be unit-tested. */
export function compareVillage(
  found: { name: string; ward_name: string | null } | null,
  hfrVillage: string | null,
  hfrWard: string | null,
): VillageResult {
  if (!found) return { check: "unknown", village: null, ward: null, wardDiffers: false };
  const wardDiffers = !!normAdmin(found.ward_name) && !!normAdmin(hfrWard) && !same(found.ward_name, hfrWard);
  const check: VillageCheck = !normAdmin(hfrVillage) ? "unknown" : same(found.name, hfrVillage) ? "agrees" : "differs";
  return { check, village: found.name, ward: found.ward_name, wardDiffers };
}

export interface VillageCandidate {
  id: number;
  name: string;
  ward_name: string | null;
  district_name: string | null;
  region_name: string | null;
  lat: number;
  lng: number;
  /** bounding box of the polygon, used to confine geocoder searches to the village */
  south?: number;
  west?: number;
  north?: number;
  east?: number;
}

/**
 * Pick the village polygon an HFR record names: same ward and region, village name ≥ SAME_NAME alike, the council
 * (district) breaking ties. Null when nothing matches or two different villages tie. Pure, so it can be unit-tested.
 */
export function pickVillage(
  rows: VillageCandidate[],
  hfrVillage: string | null,
  hfrWard: string | null,
  hfrCouncil: string | null,
  hfrRegion: string | null,
): VillageCandidate | null {
  const vn = normAdmin(hfrVillage);
  const wn = normAdmin(hfrWard);
  if (!vn || !wn) return null;
  const rn = normAdmin(hfrRegion);
  const cn = normAdmin(hfrCouncil);
  const scored = rows
    .filter((r) => normAdmin(r.ward_name) === wn && (!rn || normAdmin(r.region_name) === rn))
    .map((r) => ({ r, name: ratio(vn, normAdmin(r.name)), district: cn && normAdmin(r.district_name) ? ratio(cn, normAdmin(r.district_name)) : 0 }))
    .filter((s) => s.name >= SAME_NAME)
    .sort((a, b) => b.name + (b.district >= 80 ? 10 : 0) - (a.name + (a.district >= 80 ? 10 : 0)));
  if (scored.length === 0) return null;
  const [best, second] = scored;
  // The same village name twice in one ward, in different councils or far apart, cannot be told apart.
  const tied = second && second.name === best.name && (second.district >= 80) === (best.district >= 80) && second.r.id !== best.r.id;
  return tied ? null : best.r;
}

/**
 * Pick the village polygon an HFR record names when the ward cannot be used (the portal's ward was renamed or split since the village
 * file was made): the village name must be identical, the council (district) alike, and exactly one polygon may fit. Pure.
 */
export function pickVillageInCouncil(rows: VillageCandidate[], hfrVillage: string | null, hfrCouncil: string | null, hfrRegion: string | null): VillageCandidate | null {
  const vn = normAdmin(hfrVillage);
  const cn = normAdmin(hfrCouncil);
  const rn = normAdmin(hfrRegion);
  if (!vn || !cn) return null;
  const fits = rows.filter(
    (r) => normAdmin(r.name) === vn && (!rn || normAdmin(r.region_name) === rn) && !!normAdmin(r.district_name) && ratio(cn, normAdmin(r.district_name)) >= SAME_NAME,
  );
  return fits.length === 1 ? fits[0] : null;
}

/** Every village polygon of a region (with its centre), for the council-level match. Load once per region and reuse. */
export async function villagesOfRegion(hfrRegion: string | null): Promise<VillageCandidate[]> {
  const key = (hfrRegion ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/region$/, "");
  if (!key) return [];
  return q<VillageCandidate>(sql`
    SELECT id, name, ward_name, district_name, region_name,
           ST_Y(ST_PointOnSurface(geom)) AS lat, ST_X(ST_PointOnSurface(geom)) AS lng,
           ST_YMin(geom) AS south, ST_XMin(geom) AS west, ST_YMax(geom) AS north, ST_XMax(geom) AS east
    FROM village_boundaries WHERE regexp_replace(regexp_replace(lower(region_name), '[^a-z0-9]+', '', 'g'), 'region$', '') = ${key}`);
}

/** Points this close to their village's edge count as inside (village files are simplified and their polygons leave small gaps). */
export const VILLAGE_EDGE_TOLERANCE_M = 100;

/** Every village polygon of a ward (with its centre), for picking the one an HFR record names. Load once per ward and reuse. */
export async function villagesOfWard(hfrWard: string | null): Promise<VillageCandidate[]> {
  const key = (hfrWard ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!key) return [];
  return q<VillageCandidate>(sql`
    SELECT id, name, ward_name, district_name, region_name,
           ST_Y(ST_PointOnSurface(geom)) AS lat, ST_X(ST_PointOnSurface(geom)) AS lng,
           ST_YMin(geom) AS south, ST_XMin(geom) AS west, ST_YMax(geom) AS north, ST_XMax(geom) AS east
    FROM village_boundaries WHERE regexp_replace(lower(ward_name), '[^a-z0-9]+', '', 'g') = ${key}`);
}

/** Is the point inside (or within the edge tolerance of) the village polygon? */
export async function pointInVillage(id: number, lat: number, lng: number): Promise<boolean> {
  const [r] = await q<{ inside: boolean }>(sql`
    WITH p AS (SELECT ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326) AS pt)
    SELECT (ST_Contains(v.geom, p.pt) OR ST_DWithin(v.geom::geography, p.pt::geography, ${VILLAGE_EDGE_TOLERANCE_M})) AS inside
    FROM village_boundaries v, p WHERE v.id = ${id}`);
  return !!r?.inside;
}

/** Centre of the village polygon the HFR record names, for facilities with no usable point. Null when none can be identified. */
export async function villageCentroid(
  hfrVillage: string | null,
  hfrWard: string | null,
  hfrCouncil: string | null,
  hfrRegion: string | null,
): Promise<{ lat: number; lng: number; village: string } | null> {
  if (!normAdmin(hfrVillage) || !normAdmin(hfrWard)) return null;
  const v = pickVillage(await villagesOfWard(hfrWard), hfrVillage, hfrWard, hfrCouncil, hfrRegion);
  return v ? { lat: v.lat, lng: v.lng, village: v.name } : null;
}

/** True once a village file has been loaded (checks are skipped, not marked "unknown", before that). */
export async function hasVillageBoundaries(): Promise<boolean> {
  const [r] = await q<{ n: number }>(sql`SELECT count(*)::int n FROM (SELECT 1 FROM village_boundaries LIMIT 1) x`);
  return (r?.n ?? 0) > 0;
}

/** Which village polygon contains this point, and does it match the facility's village and ward? */
export async function checkVillage(lat: number, lng: number, hfrVillage: string | null, hfrWard: string | null): Promise<VillageResult> {
  const [found] = await q<{ name: string; ward_name: string | null }>(sql`
    SELECT name, ward_name FROM village_boundaries
    WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)) LIMIT 1`);
  return compareVillage(found ?? null, hfrVillage, hfrWard);
}
