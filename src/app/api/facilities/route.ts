import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { q } from "@/lib/db/client";
import { readFilters, whereFor } from "@/lib/data";

export const dynamic = "force-dynamic";

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; body: string }>();

/** Repeated place names are sent once in `lookups`; each point carries small indexes into them. */
function dictionary() {
  const values: string[] = [];
  const index = new Map<string, number>();
  return {
    values,
    id(v: string | null): number {
      if (!v) return -1;
      let i = index.get(v);
      if (i === undefined) {
        i = values.length;
        values.push(v);
        index.set(v, i);
      }
      return i;
    },
  };
}

async function build(filters: ReturnType<typeof readFilters>): Promise<string> {
  const rows = await q<{ c: string; n: string; t: string | null; conf: string | null; lat: number; lng: number; src: string; ward: string | null; village: string | null; council: string | null; region: string | null }>(sql`
    SELECT f.facility_code c, f.name n, f.facility_type t, g.confidence conf,
           coalesce(g.final_lat, f.hfr_lat) lat, coalesce(g.final_lng, f.hfr_lng) lng,
           coalesce(g.geocode_source, 'hfr') src,
           f.ward_name ward, f.village_name village, f.council_name council, f.region_name region
    FROM facilities f LEFT JOIN geo_validation g ON g.facility_code = f.facility_code
    WHERE ${whereFor(filters)} AND coalesce(g.final_lat, f.hfr_lat) IS NOT NULL`);
  const wards = dictionary();
  const villages = dictionary();
  const councils = dictionary();
  const regions = dictionary();
  const types = dictionary();
  const sources = dictionary();
  const round = (x: number) => Math.round(Number(x) * 1e5) / 1e5; // ~1 m, plenty for a map
  return JSON.stringify({
    type: "FeatureCollection",
    lookups: { wards: wards.values, villages: villages.values, councils: councils.values, regions: regions.values, types: types.values, sources: sources.values },
    features: rows.map((r) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [round(r.lng), round(r.lat)] },
      properties: { code: r.c, name: r.n, confidence: r.conf ?? "unchecked", t: types.id(r.t), s: sources.id(r.src), w: wards.id(r.ward), v: villages.id(r.village), cn: councils.id(r.council), r: regions.id(r.region) },
    })),
  });
}

/** GeoJSON of facility points for the map (final corrected point when available). */
export async function GET(req: Request) {
  const filters = readFilters(new URL(req.url).searchParams);
  const key = JSON.stringify(filters);
  let hit = cache.get(key);
  if (!hit || Date.now() - hit.at > TTL_MS) {
    hit = { at: Date.now(), body: await build(filters) };
    cache.set(key, hit);
    if (cache.size > 50) cache.delete(cache.keys().next().value!);
  }
  return new NextResponse(hit.body, {
    headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=60, stale-while-revalidate=300" },
  });
}
