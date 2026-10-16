import { sql } from "drizzle-orm";
import { q } from "../db/client";
import type { BBox } from "./osm";
import { ratio } from "./name-match";
import { normAdmin } from "./wards";

/** The council file is coarse (about 40k vertices for the whole country), so points this near an edge count as inside. */
export const COUNCIL_EDGE_TOLERANCE_M = 1500;

export interface CouncilRow {
  id: number;
  name: string;
  district_name: string | null;
  region_name: string | null;
}

export interface CouncilPolygon {
  id: number;
  bbox: BBox;
}

const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Link an HFR council (name + region) to its polygon. Null when nothing matches well enough. */
export function pickCouncil(rows: CouncilRow[], council: string | null, region: string | null): number | null {
  const cn = normAdmin(council);
  if (!cn) return null;
  const rn = normAdmin(region);
  const inRegion = rn ? rows.filter((r) => normAdmin(r.region_name) === rn) : [];
  const raw = plain(council ?? "");
  let best: { id: number; score: number } | null = null;
  for (const r of inRegion.length ? inRegion : rows) {
    // An exact raw match wins ("Arusha CC" vs "Arusha DC"), then the normalised name, then the district name.
    const score = Math.max(ratio(cn, normAdmin(r.name)), ratio(cn, normAdmin(r.district_name)) - 5) + (plain(r.name) === raw ? 20 : 0);
    if (!best || score > best.score) best = { id: r.id, score };
  }
  return best && best.score >= 85 ? best.id : null;
}

let cache: CouncilRow[] | null = null;
const resolved = new Map<string, CouncilPolygon | null>();

/** Polygon (id + bounding box) for an HFR council, cached for the life of the process. Null when no council file is loaded. */
export async function councilPolygon(council: string | null, region: string | null): Promise<CouncilPolygon | null> {
  const key = `${normAdmin(region)}|${(council ?? "").toLowerCase()}`;
  if (resolved.has(key)) return resolved.get(key)!;
  cache ??= await q<CouncilRow>(sql`SELECT id, name, district_name, region_name FROM council_boundaries`);
  const id = pickCouncil(cache, council, region);
  let out: CouncilPolygon | null = null;
  if (id != null) {
    const [r] = await q<{ s: number; w: number; n: number; e: number }>(sql`
      SELECT ST_YMin(geom) s, ST_XMin(geom) w, ST_YMax(geom) n, ST_XMax(geom) e FROM council_boundaries WHERE id = ${id}`);
    if (r) out = { id, bbox: { south: r.s, west: r.w, north: r.n, east: r.e } };
  }
  resolved.set(key, out);
  return out;
}

/** Is the point inside (or within the edge tolerance of) the council polygon? */
export async function pointInCouncilPolygon(id: number, lat: number, lng: number): Promise<boolean> {
  const [r] = await q<{ inside: boolean }>(sql`
    SELECT ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${COUNCIL_EDGE_TOLERANCE_M}) AS inside
    FROM council_boundaries WHERE id = ${id}`);
  return !!r?.inside;
}
