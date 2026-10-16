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
