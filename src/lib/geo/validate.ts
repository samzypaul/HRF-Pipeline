import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { env } from "../env";
import { errorMessage, haversineM } from "../util";
import { checkPoint } from "./sanity";
import { nameScore, MATCH_SCORE, SEARCH_RADIUS_M } from "./name-match";
import { overpassHealthPlaces, nominatimSearch, type BBox, type Place } from "./osm";
import { googleTextSearch, googleGeocode, GoogleUnavailable } from "./google";
import { grade, type CandidatePoint } from "./grade";

interface FacilityRow {
  facility_code: string;
  name: string;
  common_name: string | null;
  ward_code: string | null;
  ward_name: string | null;
  council_code: string | null;
  council_name: string | null;
  region_code: string | null;
  region_name: string | null;
  hfr_lat: number | null;
  hfr_lng: number | null;
  boundary_id: number | null;
}

interface WardGeo {
  boundaryId: number;
  bbox: BBox;
  centroid: { lat: number; lng: number };
}

const OSM_CACHE_DAYS = 30;
/** Points this close to their ward's edge count as inside (boundary files are simplified and dated). */
export const WARD_EDGE_TOLERANCE_M = 150;

async function wardGeo(boundaryId: number): Promise<WardGeo> {
  const [r] = await q<{ s: number; w: number; n: number; e: number; clat: number; clng: number }>(sql`
    SELECT ST_YMin(geom) s, ST_XMin(geom) w, ST_YMax(geom) n, ST_XMax(geom) e,
           ST_Y(ST_PointOnSurface(geom)) clat, ST_X(ST_PointOnSurface(geom)) clng
    FROM ward_boundaries WHERE id = ${boundaryId}`);
  return {
    boundaryId,
    bbox: { south: r.s, west: r.w, north: r.n, east: r.e },
    centroid: { lat: r.clat, lng: r.clng },
  };
}

async function pointInBoundary(boundaryId: number, lat: number, lng: number) {
  const [r] = await q<{ inside: boolean; dist: number }>(sql`
    SELECT ST_Contains(geom, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)) AS inside,
           ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) AS dist
    FROM ward_boundaries WHERE id = ${boundaryId}`);
  const distanceM = Number(r?.dist ?? NaN);
  return { inside: !!r?.inside || distanceM <= WARD_EDGE_TOLERANCE_M, strictlyInside: !!r?.inside, distanceM };
}

async function pointInCouncil(councilCode: string, lat: number, lng: number): Promise<boolean | null> {
  const [r] = await q<{ n: number; inside: boolean }>(sql`
    SELECT count(*)::int n, bool_or(ST_Contains(wb.geom, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))) inside
    FROM admin_units au
    JOIN ward_crosswalk cw ON cw.ward_code = au.code
    JOIN ward_boundaries wb ON wb.id = cw.boundary_id
    WHERE au.parent_code = ${councilCode} AND au.level = 4`);
  return r && r.n > 0 ? !!r.inside : null;
}

/** Bounding box used to search OSM for a council: its ward polygons, else its facility points. */
async function councilBBox(councilCode: string | null, regionCode: string | null): Promise<BBox | null> {
  if (councilCode) {
    const [b] = await q<{ s: number | null; w: number; n: number; e: number }>(sql`
      SELECT ST_YMin(ext) s, ST_XMin(ext) w, ST_YMax(ext) n, ST_XMax(ext) e FROM (
        SELECT ST_Extent(wb.geom) ext FROM admin_units au
        JOIN ward_crosswalk cw ON cw.ward_code = au.code
        JOIN ward_boundaries wb ON wb.id = cw.boundary_id
        WHERE au.parent_code = ${councilCode} AND au.level = 4) x`);
    if (b && b.s != null) return pad({ south: b.s, west: b.w, north: b.n, east: b.e }, 0.02);
  }
  // Fall back to the 5th–95th percentile of the council's (or region's) facility points.
  const [p] = await q<{ s: number | null; w: number; n: number; e: number }>(sql`
    SELECT percentile_cont(0.05) WITHIN GROUP (ORDER BY hfr_lat) s,
           percentile_cont(0.05) WITHIN GROUP (ORDER BY hfr_lng) w,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY hfr_lat) n,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY hfr_lng) e
    FROM facilities
    WHERE hfr_lat BETWEEN -11.8 AND -0.9 AND hfr_lng BETWEEN 29.2 AND 40.6
      AND ${councilCode ? sql`council_code = ${councilCode}` : sql`region_code = ${regionCode}`}`);
  if (!p || p.s == null) return null;
  return pad({ south: p.s, west: p.w, north: p.n, east: p.e }, 0.05);
}

function pad(b: BBox, d: number): BBox {
  return { south: b.south - d, west: b.west - d, north: b.north + d, east: b.east + d };
}

function boxAround(lat: number, lng: number, metres: number): BBox {
  const dLat = metres / 111_320;
  const dLng = metres / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { south: lat - dLat, west: lng - dLng, north: lat + dLat, east: lng + dLng };
}

// After an Overpass failure, don't retry the same area for 15 minutes (avoids hammering a busy server).
const overpassFailures = new Map<string, number>();

/** OSM health places for a council, cached for 30 days. */
async function osmPlacesFor(councilCode: string | null, regionCode: string | null): Promise<Place[]> {
  const key = councilCode ? `council:${councilCode}` : `region:${regionCode}`;
  const [cached] = await q<{ data: Place[]; fresh: boolean }>(sql`
    SELECT data, fetched_at > now() - make_interval(days => ${OSM_CACHE_DAYS}) AS fresh FROM osm_cache WHERE key = ${key}`);
  if (cached?.fresh) return cached.data;
  const failedAt = overpassFailures.get(key);
  if (failedAt && Date.now() - failedAt < 15 * 60_000) return cached?.data ?? [];
  const bbox = await councilBBox(councilCode, regionCode);
  if (!bbox) return [];
  try {
    const places = await overpassHealthPlaces(bbox);
    await q(sql`
      INSERT INTO osm_cache (key, data, fetched_at) VALUES (${key}, ${JSON.stringify(places)}::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`);
    return places;
  } catch (e) {
    overpassFailures.set(key, Date.now());
    console.warn(`[validate] Overpass failed for ${key}: ${errorMessage(e)}`);
    return cached?.data ?? [];
  }
}

function bestMatch(name: string, alt: string | null, places: Place[], near?: { lat: number; lng: number }, radiusM = SEARCH_RADIUS_M) {
  let best: { place: Place; score: number; distanceM: number } | null = null;
  for (const p of places) {
    const distanceM = near ? haversineM(near.lat, near.lng, p.lat, p.lng) : 0;
    if (near && distanceM > radiusM) continue;
    const names = [p.name, ...(p.altNames ?? [])];
    let score = 0;
    for (const n of names) {
      score = Math.max(score, nameScore(name, n));
      if (alt) score = Math.max(score, nameScore(alt, n));
    }
    if (!best || score > best.score || (score === best.score && distanceM < best.distanceM)) {
      best = { place: p, score, distanceM };
    }
  }
  return best && best.score >= MATCH_SCORE ? best : null;
}

export interface ValidateStats {
  validated: number;
  googlePlaces: number;
  geocoded: number;
  errors: number;
}

/** Validate a batch of facilities (normally all from one ward). */
export async function validateFacilities(codes: string[]): Promise<ValidateStats> {
  const stats: ValidateStats = { validated: 0, googlePlaces: 0, geocoded: 0, errors: 0 };
  if (codes.length === 0) return stats;
  const rows = await q<FacilityRow>(sql`
    SELECT f.facility_code, f.name, f.common_name, f.ward_code, f.ward_name, f.council_code, f.council_name,
           f.region_code, f.region_name, f.hfr_lat, f.hfr_lng, cw.boundary_id
    FROM facilities f LEFT JOIN ward_crosswalk cw ON cw.ward_code = f.ward_code
    WHERE f.facility_code IN (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})`);

  const reviews = new Map(
    (
      await q<{ facility_code: string; decision: string; lat: number | null; lng: number | null }>(sql`
        SELECT facility_code, decision, lat, lng FROM review_decisions
        WHERE facility_code IN (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})`)
    ).map((r) => [r.facility_code, r]),
  );

  const previous = new Map(
    (
      await q<{ facility_code: string; google_place_id: string | null; name_score: number | null; match_distance_m: number | null; google_recent: boolean }>(sql`
        SELECT facility_code, google_place_id, name_score, match_distance_m,
               coalesce(google_checked_at > now() - interval '180 days', false) AS google_recent
        FROM geo_validation WHERE facility_code IN (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})`)
    ).map((r) => [r.facility_code, r]),
  );

  const wardCache = new Map<number, WardGeo>();
  const placesCache = new Map<string, Place[]>();
  let googleAvailable = !!env.googleKey;

  for (const f of rows) {
    try {
      const sanity = checkPoint(f.hfr_lat, f.hfr_lng);
      const hfrPoint = sanity.usable ? (sanity.fixed ?? { lat: f.hfr_lat!, lng: f.hfr_lng! }) : null;
      const hasBoundary = f.boundary_id != null;
      let ward: WardGeo | null = null;
      if (hasBoundary) {
        ward = wardCache.get(f.boundary_id!) ?? (await wardGeo(f.boundary_id!));
        wardCache.set(f.boundary_id!, ward);
      }
      const inWardOf = async (lat: number, lng: number) => (ward ? (await pointInBoundary(ward.boundaryId, lat, lng)).inside : null);

      // 1. Ward + council check of the HFR point
      let inWard: boolean | null = null;
      let distanceToWardM: number | null = null;
      let inCouncil: boolean | null = null;
      if (hfrPoint && ward) {
        const r = await pointInBoundary(ward.boundaryId, hfrPoint.lat, hfrPoint.lng);
        inWard = r.inside;
        distanceToWardM = r.strictlyInside ? 0 : Math.round(r.distanceM);
      }
      if (hfrPoint && f.council_code) inCouncil = await pointInCouncil(f.council_code, hfrPoint.lat, hfrPoint.lng);

      // 2. OSM name match (free)
      const placesKey = f.council_code ?? `r:${f.region_code}`;
      let places = placesCache.get(placesKey);
      if (!places) {
        places = await osmPlacesFor(f.council_code, f.region_code);
        placesCache.set(placesKey, places);
      }
      let nearMatch: { source: "osm" | "google"; score: number; distanceM: number } | null = null;
      let matchSource = "none";
      let matchedName: string | null = null;
      let osmId: string | null = null;
      let googlePlaceId: string | null = null;
      let nameScoreVal: number | null = null;
      let matchDistanceM: number | null = null;
      let relocation: CandidatePoint | null = null;

      const osmNear = hfrPoint ? bestMatch(f.name, f.common_name, places, hfrPoint) : null;
      if (osmNear) {
        nearMatch = { source: "osm", score: osmNear.score, distanceM: osmNear.distanceM };
        matchSource = "osm";
        matchedName = osmNear.place.name;
        osmId = osmNear.place.id;
        nameScoreVal = osmNear.score;
        matchDistanceM = Math.round(osmNear.distanceM);
      }
      // A same-named OSM place anywhere in the council can relocate a bad or missing point.
      const needsRelocation = !hfrPoint || inWard === false;
      if (needsRelocation && ward) {
        const inWardPlaces = [];
        for (const p of places) {
          if (p.lat >= ward.bbox.south && p.lat <= ward.bbox.north && p.lng >= ward.bbox.west && p.lng <= ward.bbox.east) inWardPlaces.push(p);
        }
        const m = bestMatch(f.name, f.common_name, inWardPlaces);
        if (m && (await inWardOf(m.place.lat, m.place.lng))) {
          relocation = { source: "osm_match", lat: m.place.lat, lng: m.place.lng, inWard: true, score: m.score };
          if (matchSource === "none") {
            matchSource = "osm";
            matchedName = m.place.name;
            osmId = m.place.id;
            nameScoreVal = m.score;
          }
        }
      }

      // 3. Google fallback (only when OSM found nothing; reuse a check from the last 180 days)
      const prev = previous.get(f.facility_code);
      let googleCheckedNow = false;
      if (matchSource === "none" && prev?.google_recent) {
        if (prev.google_place_id && prev.name_score != null) {
          matchSource = "google";
          googlePlaceId = prev.google_place_id;
          nameScoreVal = prev.name_score;
          matchDistanceM = prev.match_distance_m;
          if (hfrPoint && prev.match_distance_m != null) {
            nearMatch = { source: "google", score: prev.name_score, distanceM: prev.match_distance_m };
          }
        }
      } else if (matchSource === "none" && googleAvailable) {
        const area = ward?.bbox ?? (hfrPoint ? boxAround(hfrPoint.lat, hfrPoint.lng, SEARCH_RADIUS_M) : null);
        if (area) {
          try {
            const query = [f.name, f.ward_name, f.council_name, "Tanzania"].filter(Boolean).join(", ");
            const results = await googleTextSearch(query, area);
            stats.googlePlaces++;
            googleCheckedNow = true;
            const g = bestMatch(f.name, f.common_name, results, hfrPoint ?? undefined, hfrPoint ? SEARCH_RADIUS_M : Infinity);
            if (g) {
              matchSource = "google";
              googlePlaceId = g.place.id;
              nameScoreVal = g.score;
              if (hfrPoint) {
                nearMatch = { source: "google", score: g.score, distanceM: g.distanceM };
                matchDistanceM = Math.round(g.distanceM);
              }
              if (needsRelocation) {
                const iw = await inWardOf(g.place.lat, g.place.lng);
                relocation = { source: "google_match", lat: g.place.lat, lng: g.place.lng, inWard: iw, score: g.score };
              }
            }
          } catch (e) {
            if (e instanceof GoogleUnavailable) googleAvailable = false;
            else throw e;
          }
        }
      }

      // 4. Geocode when the HFR point is missing/unusable and nothing relocated it
      let geocode: CandidatePoint | null = null;
      if (!hfrPoint && !relocation?.inWard) {
        const query = [f.name, f.ward_name, f.council_name, "Tanzania"].filter(Boolean).join(", ");
        try {
          const nom = await nominatimSearch(query, { viewbox: ward?.bbox });
          for (const p of nom) {
            const iw = await inWardOf(p.lat, p.lng);
            if (iw !== false) {
              geocode = { source: "nominatim", lat: p.lat, lng: p.lng, inWard: iw };
              break;
            }
          }
        } catch (e) {
          console.warn(`[validate] Nominatim failed for ${f.facility_code}: ${errorMessage(e)}`);
        }
        if (!geocode && googleAvailable) {
          try {
            const res = await googleGeocode(query);
            for (const p of res) {
              if (p.kind === "APPROXIMATE" && !ward) continue;
              const iw = await inWardOf(p.lat, p.lng);
              if (iw !== false) {
                geocode = { source: "google_geocode", lat: p.lat, lng: p.lng, inWard: iw };
                break;
              }
            }
          } catch (e) {
            if (e instanceof GoogleUnavailable) googleAvailable = false;
            else console.warn(`[validate] Google geocode failed for ${f.facility_code}: ${errorMessage(e)}`);
          }
        }
        if (geocode) stats.geocoded++;
      }

      const review = reviews.get(f.facility_code) ?? null;
      const result = grade({
        sanity,
        hfrPoint,
        hasBoundary,
        inWard,
        nearMatch,
        relocation,
        geocode,
        centroid: ward ? { source: "ward_centroid", lat: ward.centroid.lat, lng: ward.centroid.lng, inWard: true } : null,
        review: review ? { decision: review.decision, lat: review.lat, lng: review.lng } : null,
      });

      await q(sql`
        INSERT INTO geo_validation (facility_code, has_boundary, in_ward, in_council, distance_to_ward_m, sanity_flags,
          match_source, matched_name, name_score, match_distance_m, osm_id, google_place_id, google_checked_at, geocode_source,
          final_lat, final_lng, confidence, notes, checked_at)
        VALUES (${f.facility_code}, ${hasBoundary}, ${inWard}, ${inCouncil}, ${distanceToWardM},
          ${sanity.flags.length ? sql`ARRAY[${sql.join(sanity.flags.map((x) => sql`${x}`), sql`, `)}]::text[]` : sql`ARRAY[]::text[]`},
          ${matchSource}, ${matchedName}, ${nameScoreVal}, ${matchDistanceM}, ${osmId}, ${googlePlaceId}, ${googleCheckedNow ? sql`now()` : sql`NULL`}, ${result.geocodeSource},
          ${result.final?.lat ?? null}, ${result.final?.lng ?? null}, ${result.confidence}, ${result.notes.join("; ")}, now())
        ON CONFLICT (facility_code) DO UPDATE SET
          has_boundary = EXCLUDED.has_boundary, in_ward = EXCLUDED.in_ward, in_council = EXCLUDED.in_council,
          distance_to_ward_m = EXCLUDED.distance_to_ward_m, sanity_flags = EXCLUDED.sanity_flags,
          match_source = EXCLUDED.match_source, matched_name = EXCLUDED.matched_name, name_score = EXCLUDED.name_score,
          match_distance_m = EXCLUDED.match_distance_m, osm_id = EXCLUDED.osm_id, google_place_id = EXCLUDED.google_place_id,
          google_checked_at = coalesce(EXCLUDED.google_checked_at, geo_validation.google_checked_at),
          geocode_source = EXCLUDED.geocode_source, final_lat = EXCLUDED.final_lat, final_lng = EXCLUDED.final_lng,
          confidence = EXCLUDED.confidence, notes = EXCLUDED.notes, checked_at = now()`);
      stats.validated++;
    } catch (e) {
      stats.errors++;
      console.error(`[validate] ${f.facility_code}: ${errorMessage(e)}`);
      if (stats.errors > 5) throw e;
    }
  }
  return stats;
}

/** Flag facilities that share exactly the same coordinates as another facility. */
export async function flagSharedPoints(): Promise<number> {
  const rows = await q<{ n: number }>(sql`
    WITH dup AS (
      SELECT hfr_lat, hfr_lng FROM facilities
      WHERE hfr_lat IS NOT NULL AND removed_at IS NULL
      GROUP BY hfr_lat, hfr_lng HAVING count(*) > 1
    )
    UPDATE geo_validation g SET sanity_flags = array_append(g.sanity_flags, 'shared_point')
    FROM facilities f JOIN dup ON dup.hfr_lat = f.hfr_lat AND dup.hfr_lng = f.hfr_lng
    WHERE g.facility_code = f.facility_code AND NOT ('shared_point' = ANY(coalesce(g.sanity_flags, ARRAY[]::text[])))
    RETURNING 1 AS n`);
  return rows.length;
}
