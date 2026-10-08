import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { q } from "@/lib/db/client";
import { readFilters, whereFor } from "@/lib/data";

export const dynamic = "force-dynamic";

/** GeoJSON of facility points for the map (final corrected point when available). */
export async function GET(req: Request) {
  const f = readFilters(new URL(req.url).searchParams);
  const rows = await q<{ c: string; n: string; t: string | null; conf: string | null; lat: number; lng: number; src: string; iw: boolean | null }>(sql`
    SELECT f.facility_code c, f.name n, f.facility_type t, g.confidence conf,
           coalesce(g.final_lat, f.hfr_lat) lat, coalesce(g.final_lng, f.hfr_lng) lng,
           coalesce(g.geocode_source, 'hfr') src, g.in_ward iw
    FROM facilities f LEFT JOIN geo_validation g ON g.facility_code = f.facility_code
    WHERE ${whereFor(f)} AND coalesce(g.final_lat, f.hfr_lat) IS NOT NULL`);
  return NextResponse.json({
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [Number(r.lng), Number(r.lat)] },
      properties: { code: r.c, name: r.n, type: r.t, confidence: r.conf ?? "unchecked", source: r.src, inWard: r.iw },
    })),
  });
}
