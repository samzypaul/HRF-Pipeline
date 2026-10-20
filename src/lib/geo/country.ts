import { sql } from "drizzle-orm";
import { q } from "../db/client";

/** The council file is simplified and stops at the shore, so points this near Tanzania's edge still count as inside. */
export const COUNTRY_EDGE_TOLERANCE_M = 3000;

let loaded: Promise<boolean> | null = null;

/** Is a council file loaded? Without one the bounding-box test in sanity.ts is the only country check. */
export function hasCountryBoundary(): Promise<boolean> {
  loaded ??= q<{ n: number }>(sql`SELECT count(*)::int n FROM council_boundaries`)
    .then(([r]) => Number(r?.n ?? 0) > 0)
    .catch((e) => {
      loaded = null;
      throw e;
    });
  return loaded;
}

/**
 * Is the point inside Tanzania (the union of the council polygons, plus the edge tolerance)?
 * True when no council file is loaded, so a missing file never rejects every facility.
 */
export async function pointInTanzania(lat: number, lng: number): Promise<boolean> {
  if (!(await hasCountryBoundary())) return true;
  const [r] = await q<{ inside: boolean }>(sql`
    WITH p AS (SELECT ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326) AS pt)
    SELECT EXISTS (
      SELECT 1 FROM council_boundaries c, p
      WHERE ST_DWithin(c.geom, p.pt, 0.1)
        AND ST_DWithin(c.geom::geography, p.pt::geography, ${COUNTRY_EDGE_TOLERANCE_M})
    ) AS inside`);
  return !!r?.inside;
}
