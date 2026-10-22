import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { env } from "../env";
import { createLimiter, errorMessage, haversineM, mapLimit } from "../util";
import { checkPoint } from "./sanity";
import { nameScore, nameIsWeak, MATCH_DISTANCE_M, MATCH_SCORE, SEARCH_RADIUS_M } from "./name-match";
import { overpassHealthPlaces, nominatimSearch, type BBox, type Place } from "./osm";
import { googleTextSearch, googleGeocode, GoogleUnavailable } from "./google";
import { adjustGrade, grade, type CandidatePoint } from "./grade";
import { combineWardChecks, wardNameCheck, type WardNameCheck } from "./maptiler";
import { acrossProviders, forwardSearch, resolveProviders, reverseNames, type ActiveProvider } from "./provider";
import { getSettings } from "../settings";
import type { SatelliteStatus } from "./satellite";
import { councilPolygon, pointInCouncilPolygon } from "./council";
import { pointInTanzania } from "./country";
import {
  checkVillage,
  hasVillageBoundaries,
  pickVillage,
  pickVillageInCouncil,
  pointInVillage,
  villagesOfRegion,
  villagesOfWard,
  type VillageCandidate,
  type VillageResult,
} from "./village";
import { normAdmin } from "./wards";

interface FacilityRow {
  facility_code: string;
  name: string;
  village_name: string | null;
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

/** Google / ArcGIS / MapTiler calls in flight at once across all lanes, so parallel validation does not trip their rate limits. */
const apiCall = createLimiter(env.geoApiConcurrency);

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
  // A point inside the polygon is 0 m away, so the (much slower) geography distance is only needed outside it.
  const [r] = await q<{ inside: boolean; dist: number }>(sql`
    WITH p AS (SELECT ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326) AS pt)
    SELECT c.inside, CASE WHEN c.inside THEN 0 ELSE ST_Distance(wb.geom::geography, p.pt::geography) END AS dist
    FROM ward_boundaries wb, p, LATERAL (SELECT ST_Contains(wb.geom, p.pt) AS inside) c
    WHERE wb.id = ${boundaryId}`);
  const distanceM = Number(r?.dist ?? NaN);
  return { inside: !!r?.inside || distanceM <= WARD_EDGE_TOLERANCE_M, strictlyInside: !!r?.inside, distanceM };
}

/** Boundary ids of the wards linked to a council, looked up once per validation batch. */
type CouncilWards = Map<string, Promise<number[]>>;

function councilWardBoundaries(councilCode: string, cache: CouncilWards): Promise<number[]> {
  let ids = cache.get(councilCode);
  if (!ids) {
    ids = q<{ id: number }>(sql`
      SELECT DISTINCT wb.id FROM admin_units au
      JOIN ward_crosswalk cw ON cw.ward_code = au.code
      JOIN ward_boundaries wb ON wb.id = cw.boundary_id
      WHERE au.parent_code = ${councilCode} AND au.level = 4`).then((rows) => rows.map((r) => r.id));
    cache.set(councilCode, ids);
    ids.catch(() => cache.delete(councilCode));
  }
  return ids;
}

/** Is the point inside one of the council's linked ward polygons? Null when none are linked. */
async function pointInCouncil(councilCode: string, lat: number, lng: number, cache: CouncilWards): Promise<boolean | null> {
  const ids = await councilWardBoundaries(councilCode, cache);
  if (ids.length === 0) return null;
  const [r] = await q<{ inside: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM ward_boundaries
      WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        AND ST_Contains(geom, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
    ) AS inside`);
  return !!r?.inside;
}

/** Bounding box used to search OSM for a council: its ward polygons, else its facility points. */
async function councilBBox(councilCode: string | null, regionCode: string | null, polygonBox: BBox | null = null): Promise<BBox | null> {
  if (councilCode) {
    const [b] = await q<{ s: number | null; w: number; n: number; e: number }>(sql`
      SELECT ST_YMin(ext) s, ST_XMin(ext) w, ST_YMax(ext) n, ST_XMax(ext) e FROM (
        SELECT ST_Extent(wb.geom) ext FROM admin_units au
        JOIN ward_crosswalk cw ON cw.ward_code = au.code
        JOIN ward_boundaries wb ON wb.id = cw.boundary_id
        WHERE au.parent_code = ${councilCode} AND au.level = 4) x`);
    if (b && b.s != null) return pad({ south: b.s, west: b.w, north: b.n, east: b.e }, 0.02);
  }
  if (polygonBox) return pad(polygonBox, 0.02);
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

/** After Nominatim answers 429 (rate limited), leave it alone for 15 minutes: the public server blocks clients that keep calling. */
let nominatimPausedUntil = 0;

/** Lookups in progress, so lanes validating the same council at the same moment share one Overpass call. */
const osmInflight = new Map<string, Promise<Place[]>>();

/** OSM health places for a council, cached for 30 days. */
function osmPlacesFor(councilCode: string | null, regionCode: string | null, polygonBox: BBox | null = null): Promise<Place[]> {
  const key = councilCode ? `council:${councilCode}` : `region:${regionCode}`;
  let pending = osmInflight.get(key);
  if (!pending) {
    pending = loadOsmPlaces(key, councilCode, regionCode, polygonBox).finally(() => osmInflight.delete(key));
    osmInflight.set(key, pending);
  }
  return pending;
}

async function loadOsmPlaces(key: string, councilCode: string | null, regionCode: string | null, polygonBox: BBox | null): Promise<Place[]> {
  const [cached] = await q<{ data: Place[]; fresh: boolean }>(sql`
    SELECT data, fetched_at > now() - make_interval(days => ${OSM_CACHE_DAYS}) AS fresh FROM osm_cache WHERE key = ${key}`);
  if (cached?.fresh) return cached.data;
  const failedAt = overpassFailures.get(key);
  if (failedAt && Date.now() - failedAt < 15 * 60_000) return cached?.data ?? [];
  const bbox = await councilBBox(councilCode, regionCode, polygonBox);
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

/** A satellite check still counts while the final point is within this distance of the point that was checked. */
export const SATELLITE_SAME_POINT_M = 30;

/** Validate a batch of facilities (normally all from one ward). */
export async function validateFacilities(codes: string[]): Promise<ValidateStats> {
  const stats: ValidateStats = { validated: 0, googlePlaces: 0, geocoded: 0, errors: 0 };
  if (codes.length === 0) return stats;
  const rows = await q<FacilityRow>(sql`
    SELECT f.facility_code, f.name, f.village_name, f.common_name, f.ward_code, f.ward_name, f.council_code, f.council_name,
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

  // What the satellite check saw for each facility's checked point; used only while the final point is still that point.
  const satellites = new Map(
    (
      await q<{ facility_code: string; lat: number; lng: number; status: SatelliteStatus }>(sql`
        SELECT facility_code, lat, lng, status FROM satellite_checks
        WHERE facility_code IN (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})`)
    ).map((r) => [r.facility_code, r]),
  );

  const previous = new Map(
    (
      await q<{
        facility_code: string;
        google_place_id: string | null;
        name_score: number | null;
        match_distance_m: number | null;
        google_recent: boolean;
        ward_check: WardNameCheck | null;
        ward_check_lat: number | null;
        ward_check_lng: number | null;
        ward_check_recent: boolean;
      }>(sql`
        SELECT facility_code, google_place_id, name_score, match_distance_m,
               coalesce(google_checked_at > now() - interval '180 days', false) AS google_recent,
               ward_name_check AS ward_check, ward_check_lat, ward_check_lng,
               coalesce(ward_checked_at > now() - interval '180 days', false) AS ward_check_recent
        FROM geo_validation WHERE facility_code IN (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})`)
    ).map((r) => [r.facility_code, r]),
  );

  const { geoLayers: layers, geoProvider } = await getSettings();
  // Promises, not values: facilities validated at the same time share one lookup instead of each making their own.
  const wardCache = new Map<number, Promise<WardGeo>>();
  const placesCache = new Map<string, Promise<Place[]>>();
  const councilWards: CouncilWards = new Map();
  let googleAvailable = !!env.googleKey;
  // Every geocoder the setting asks for ("all" = each one with a key), asked at once. A provider that says it is unavailable
  // (cap reached, key rejected) is dropped for the rest of the batch, separately for forward search and for the ward check.
  const providers = layers.extraGeocoder ? resolveProviders(geoProvider) : [];
  const forwardDown = new Set<ActiveProvider>();
  const reverseDown = new Set<ActiveProvider>();
  const villagesLoaded = await hasVillageBoundaries();
  // Village polygons of a ward, loaded once per batch (a batch is normally one ward).
  const villageRows = new Map<string, Promise<VillageCandidate[]>>();
  const regionVillages = new Map<string, Promise<VillageCandidate[]>>();
  // Facilities whose exact HFR coordinates are shared with another active facility.
  const sharedCodes = new Set(
    (
      await q<{ facility_code: string }>(sql`
        SELECT f.facility_code FROM facilities f
        WHERE f.facility_code IN (${sql.join(codes.map((c) => sql`${c}`), sql`, `)}) AND f.hfr_lat IS NOT NULL
          AND (SELECT count(*) FROM facilities o WHERE o.removed_at IS NULL AND o.hfr_lat = f.hfr_lat AND o.hfr_lng = f.hfr_lng) > 1`)
    ).map((r) => r.facility_code),
  );

  const validateOne = async (f: FacilityRow) => {
    try {
      let sanity = checkPoint(f.hfr_lat, f.hfr_lng);
      // The bounding box also covers parts of the neighbouring countries and the ocean, so the polygons settle it.
      if (sanity.usable) {
        const p = sanity.fixed ?? { lat: f.hfr_lat!, lng: f.hfr_lng! };
        if (!(await pointInTanzania(p.lat, p.lng))) sanity = { flags: [...sanity.flags, "outside_tanzania"], usable: false };
      }
      const hfrPoint = sanity.usable ? (sanity.fixed ?? { lat: f.hfr_lat!, lng: f.hfr_lng! }) : null;
      const hasBoundary = f.boundary_id != null;
      let ward: WardGeo | null = null;
      if (hasBoundary) {
        const id = f.boundary_id!;
        let pending = wardCache.get(id);
        if (!pending) {
          pending = wardGeo(id);
          wardCache.set(id, pending);
          pending.catch(() => wardCache.delete(id));
        }
        ward = await pending;
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
      if (hfrPoint && f.council_code) inCouncil = await pointInCouncil(f.council_code, hfrPoint.lat, hfrPoint.lng, councilWards);
      // The council polygon covers councils whose wards are not linked yet.
      const council = await councilPolygon(f.council_name, f.region_name);
      if (hfrPoint && inCouncil === null && council) inCouncil = await pointInCouncilPolygon(council.id, hfrPoint.lat, hfrPoint.lng);
      /** True only when a council polygon exists and the candidate point is clearly outside it. */
      const outsideCouncil = async (lat: number, lng: number) =>
        council ? !(await pointInCouncilPolygon(council.id, lat, lng)) : !(await pointInTanzania(lat, lng));
      // The polygon (with its edge tolerance) decides; the strict ward-union test is only used when no council file is loaded.
      const hfrOutsideCouncil = !!hfrPoint && (council ? await outsideCouncil(hfrPoint.lat, hfrPoint.lng) : inCouncil === false);

      // The village polygon the HFR record names: every point should end up inside it.
      let designated: VillageCandidate | null = null;
      if (villagesLoaded && normAdmin(f.village_name) && normAdmin(f.ward_name)) {
        const key = f.ward_name!.toLowerCase();
        let pending = villageRows.get(key);
        if (!pending) {
          pending = villagesOfWard(f.ward_name);
          villageRows.set(key, pending);
          pending.catch(() => villageRows.delete(key));
        }
        designated = pickVillage(await pending, f.village_name, f.ward_name, f.council_name, f.region_name);
      }
      // The ward may have been renamed or split since the village file was made: then find the village by its name inside the council.
      let designatedByCouncil = false;
      if (!designated && villagesLoaded && normAdmin(f.village_name) && normAdmin(f.council_name)) {
        const key = (f.region_name ?? "").toLowerCase();
        let pending = regionVillages.get(key);
        if (!pending) {
          pending = villagesOfRegion(f.region_name);
          regionVillages.set(key, pending);
          pending.catch(() => regionVillages.delete(key));
        }
        designated = pickVillageInCouncil(await pending, f.village_name, f.council_name, f.region_name);
        designatedByCouncil = !!designated;
      }
      /** Inside the designated village; null when the village could not be identified. */
      const inVillageOf = async (lat: number, lng: number): Promise<boolean | null> => (designated ? pointInVillage(designated.id, lat, lng) : null);
      /** A geocoded candidate is only accepted inside the designated village (anywhere when there is none). */
      const inVillageOk = async (lat: number, lng: number) => (await inVillageOf(lat, lng)) !== false;
      /** Where to search a geocoder: the village polygon's box (a few hundred metres of margin) when known, else the ward, else the council. */
      const villageBox: BBox | null =
        designated?.south != null ? pad({ south: designated.south, west: designated.west!, north: designated.north!, east: designated.east! }, 0.004) : null;
      const hfrOutsideVillage = !!hfrPoint && (await inVillageOf(hfrPoint.lat, hfrPoint.lng)) === false;

      // 2. OSM name match (free)
      const placesKey = f.council_code ?? `r:${f.region_code}`;
      let pendingPlaces = placesCache.get(placesKey);
      if (!pendingPlaces) {
        pendingPlaces = layers.osm ? osmPlacesFor(f.council_code, f.region_code, council?.bbox ?? null) : Promise.resolve([]);
        placesCache.set(placesKey, pendingPlaces);
        pendingPlaces.catch(() => placesCache.delete(placesKey));
      }
      const places = await pendingPlaces;
      let nearMatch: { source: "osm" | "google"; score: number; distanceM: number; weak?: boolean } | null = null;
      let matchSource = "none";
      let matchedName: string | null = null;
      let osmId: string | null = null;
      let googlePlaceId: string | null = null;
      let nameScoreVal: number | null = null;
      let matchDistanceM: number | null = null;
      let relocation: CandidatePoint | null = null;

      const weakName = nameIsWeak(f.name);
      const osmNear = hfrPoint ? bestMatch(f.name, f.common_name, places, hfrPoint) : null;
      if (osmNear) {
        nearMatch = { source: "osm", score: osmNear.score, distanceM: osmNear.distanceM, weak: weakName };
        matchSource = "osm";
        matchedName = osmNear.place.name;
        osmId = osmNear.place.id;
        nameScoreVal = osmNear.score;
        matchDistanceM = Math.round(osmNear.distanceM);
      }
      // A same-named OSM place anywhere in the council can relocate a bad or missing point.
      const needsRelocation = !hfrPoint || inWard === false || hfrOutsideCouncil || hfrOutsideVillage;
      if (needsRelocation && ward) {
        const inWardPlaces = [];
        for (const p of places) {
          if (p.lat >= ward.bbox.south && p.lat <= ward.bbox.north && p.lng >= ward.bbox.west && p.lng <= ward.bbox.east) inWardPlaces.push(p);
        }
        const m = bestMatch(f.name, f.common_name, inWardPlaces);
        if (m && (await inWardOf(m.place.lat, m.place.lng))) {
          relocation = { source: "osm_match", lat: m.place.lat, lng: m.place.lng, inWard: true, score: m.score, inVillage: await inVillageOf(m.place.lat, m.place.lng), confirmed: !weakName };
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
      if (matchSource === "none" && layers.google && prev?.google_recent) {
        if (prev.google_place_id && prev.name_score != null) {
          matchSource = "google";
          googlePlaceId = prev.google_place_id;
          nameScoreVal = prev.name_score;
          matchDistanceM = prev.match_distance_m;
          if (hfrPoint && prev.match_distance_m != null) {
            nearMatch = { source: "google", score: prev.name_score, distanceM: prev.match_distance_m, weak: weakName };
          }
        }
      } else if (matchSource === "none" && layers.google && googleAvailable) {
        const area = villageBox ?? ward?.bbox ?? (hfrPoint ? boxAround(hfrPoint.lat, hfrPoint.lng, SEARCH_RADIUS_M) : null);
        if (area) {
          try {
            const query = [f.name, f.ward_name, f.council_name, "Tanzania"].filter(Boolean).join(", ");
            const results = await apiCall(() => googleTextSearch(query, area));
            stats.googlePlaces++;
            googleCheckedNow = true;
            const g = bestMatch(f.name, f.common_name, results, hfrPoint ?? undefined, hfrPoint ? SEARCH_RADIUS_M : Infinity);
            if (g) {
              matchSource = "google";
              googlePlaceId = g.place.id;
              nameScoreVal = g.score;
              if (hfrPoint) {
                nearMatch = { source: "google", score: g.score, distanceM: g.distanceM, weak: weakName };
                matchDistanceM = Math.round(g.distanceM);
              }
              if (needsRelocation) {
                const iw = await inWardOf(g.place.lat, g.place.lng);
                relocation = { source: "google_match", lat: g.place.lat, lng: g.place.lng, inWard: iw, score: g.score, inVillage: await inVillageOf(g.place.lat, g.place.lng), confirmed: !weakName };
              }
            }
          } catch (e) {
            if (e instanceof GoogleUnavailable) googleAvailable = false;
            else throw e;
          }
        }
      }

      // 4. Geocode when the HFR point is missing/unusable (or outside its council) and nothing relocated it
      let geocode: CandidatePoint | null = null;
      // A point outside its village is only replaced when a close name match does not confirm it.
      const confirmed = !!nearMatch && !nearMatch.weak && nearMatch.distanceM <= MATCH_DISTANCE_M;
      const relocated = !!relocation?.inWard && relocation.inVillage !== false;
      if ((!hfrPoint || hfrOutsideCouncil || (hfrOutsideVillage && !confirmed)) && !relocated) {
        const query = [f.name, f.ward_name, f.council_name, "Tanzania"].filter(Boolean).join(", ");
        if (layers.nominatim && Date.now() >= nominatimPausedUntil) {
          try {
            const nom = await nominatimSearch(query, { viewbox: villageBox ?? ward?.bbox ?? council?.bbox });
            for (const p of nom) {
              const iw = await inWardOf(p.lat, p.lng);
              if (iw !== false && !(await outsideCouncil(p.lat, p.lng)) && (await inVillageOk(p.lat, p.lng))) {
                geocode = { source: "nominatim", lat: p.lat, lng: p.lng, inWard: iw, inVillage: designated ? true : null };
                break;
              }
            }
          } catch (e) {
            if (/\b429\b/.test(errorMessage(e)) && Date.now() >= nominatimPausedUntil) {
              nominatimPausedUntil = Date.now() + 15 * 60_000;
              console.warn("[validate] Nominatim rate-limited (429): pausing it for 15 minutes");
            } else if (Date.now() >= nominatimPausedUntil) {
              console.warn(`[validate] Nominatim failed for ${f.facility_code}: ${errorMessage(e)}`);
            }
          }
        }
        // Google forward geocoding already has its own layer below, so only MapTiler / ArcGIS are searched here.
        const forwardProviders = providers.filter((p) => (p === "maptiler" || p === "arcgis") && !forwardDown.has(p));
        if (!geocode && forwardProviders.length > 0) {
          const bbox = villageBox ?? ward?.bbox ?? council?.bbox;
          const found = await acrossProviders(forwardProviders, (p) => apiCall(() => forwardSearch(p, query, bbox)));
          for (const p of found.unavailable) forwardDown.add(p);
          for (const { provider, error } of found.errors) console.warn(`[validate] ${provider} failed for ${f.facility_code}: ${errorMessage(error)}`);
          // The first provider (in priority order) with a point inside the ward and council wins.
          search: for (const { provider, value } of found.answers) {
            for (const p of value) {
              const iw = await inWardOf(p.lat, p.lng);
              if (iw !== false && !(await outsideCouncil(p.lat, p.lng)) && (await inVillageOk(p.lat, p.lng))) {
                geocode = { source: provider === "arcgis" ? "arcgis_geocode" : "maptiler_geocode", lat: p.lat, lng: p.lng, inWard: iw, inVillage: designated ? true : null };
                break search;
              }
            }
          }
        }
        if (!geocode && layers.googleGeocode && googleAvailable) {
          try {
            const res = await apiCall(() => googleGeocode(query, villageBox ?? ward?.bbox ?? council?.bbox));
            for (const p of res) {
              if (p.kind === "APPROXIMATE" && !ward) continue;
              const iw = await inWardOf(p.lat, p.lng);
              if (iw !== false && !(await outsideCouncil(p.lat, p.lng)) && (await inVillageOk(p.lat, p.lng))) {
                geocode = { source: "google_geocode", lat: p.lat, lng: p.lng, inWard: iw, inVillage: designated ? true : null };
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

      // Last resorts for a facility with no usable point: the centre of its HFR village, then of its ward.
      let villageStandIn: CandidatePoint | null = null;
      if (!hfrPoint && !relocated && !geocode && designated && layers.wardCentroid) {
        const v = designated;
        if (!(await outsideCouncil(v.lat, v.lng))) villageStandIn = { source: "village_centroid", lat: v.lat, lng: v.lng, inWard: ward ? await inWardOf(v.lat, v.lng) : null, inVillage: true };
        // A village found through its council has a ward the boundary file does not know, so the ward cannot veto it.
        if (villageStandIn?.inWard === false && !designatedByCouncil) villageStandIn = null;
      }

      const review = reviews.get(f.facility_code) ?? null;
      const graded = grade({
        sanity,
        hfrPoint,
        hasBoundary,
        inWard,
        hfrOutsideCouncil,
        hfrOutsideVillage,
        nearMatch,
        relocation,
        geocode,
        villageCentroid: villageStandIn,
        councilCentroid: !hfrPoint && council && layers.wardCentroid ? { source: "council_centroid", lat: council.centre.lat, lng: council.centre.lng, inWard: null } : null,
        centroid: ward && layers.wardCentroid ? { source: "ward_centroid", lat: ward.centroid.lat, lng: ward.centroid.lng, inWard: true } : null,
        review: review ? { decision: review.decision, lat: review.lat, lng: review.lng } : null,
      });

      // 5. Reverse-geocode the chosen point: does MapTiler place it in the HFR ward? (reused while the point is unchanged)
      let wardCheck: WardNameCheck | null = null;
      let wardCheckFresh = false;
      const standIn = graded.geocodeSource === "ward_centroid" || graded.geocodeSource === "village_centroid" || graded.geocodeSource === "council_centroid";
      if (graded.final && !standIn && (f.ward_name || f.council_name)) {
        const same = prev?.ward_check_lat != null && prev.ward_check_lng != null &&
          Math.abs(prev.ward_check_lat - graded.final.lat) < 1e-6 && Math.abs(prev.ward_check_lng! - graded.final.lng) < 1e-6;
        if (same && prev?.ward_check_recent && prev.ward_check) {
          wardCheck = prev.ward_check;
        } else {
          const reverseProviders = providers.filter((p) => !reverseDown.has(p));
          if (reverseProviders.length > 0) {
            const { lat, lng } = graded.final;
            const res = await acrossProviders(reverseProviders, (p) => apiCall(() => reverseNames(p, lat, lng)));
            for (const p of res.unavailable) {
              reverseDown.add(p);
              if (p === "google") googleAvailable = false;
            }
            for (const { provider, error } of res.errors) console.warn(`[validate] ${provider} reverse failed for ${f.facility_code}: ${errorMessage(error)}`);
            // With several geocoders, one that places the point in the HFR ward settles it.
            if (res.answers.length > 0) {
              wardCheck = combineWardChecks(res.answers.map((a) => wardNameCheck(a.value, f.ward_name, f.council_name)));
              wardCheckFresh = true;
            }
          }
        }
      }
      // 6. Village polygon under the chosen point (local query, no API cost; skipped until a village file is loaded)
      let village: VillageResult | null = null;
      if (villagesLoaded && graded.final && !standIn) {
        village = await checkVillage(graded.final.lat, graded.final.lng, f.village_name, f.ward_name);
      }
      const flags: string[] = [...sanity.flags];
      if (wardCheck === "differs") {
        flags.push("geocoder_ward_differs");
        graded.notes.push("The geocoder places this point in a different ward/council than the HFR record");
      }
      if (village?.wardDiffers) {
        flags.push("village_ward_differs");
        graded.notes.push(`The point is in village "${village.village}", which belongs to ward "${village.ward}", not the HFR ward`);
      }
      if (hfrOutsideCouncil) flags.push("outside_council");
      if (nearMatch?.weak) flags.push("weak_name_match");
      const sharedPoint = sharedCodes.has(f.facility_code);
      if (sharedPoint) flags.push("shared_point");
      // Village, geocoder and shared-point evidence move the grade one step (see adjustGrade).
      const finalInVillage = graded.final ? await inVillageOf(graded.final.lat, graded.final.lng) : null;
      const result = adjustGrade(graded, {
        village: village ? { check: village.check, wardDiffers: village.wardDiffers } : null,
        geocoderWardDiffers: wardCheck === "differs",
        geocoderWardAgrees: wardCheck === "agrees",
        inVillage: finalInVillage,
        sharedPoint,
        inWard: ward && graded.final ? await inWardOf(graded.final.lat, graded.final.lng) : null,
        satellite: (() => {
          const s = satellites.get(f.facility_code);
          return s && graded.final && haversineM(s.lat, s.lng, graded.final.lat, graded.final.lng) <= SATELLITE_SAME_POINT_M ? s.status : null;
        })(),
      });
      // Village containment of the chosen point: "outside_village" = still not in the HFR village, "village_fix" = the village rule
      // produced the point (a geocode inside the village, or the village centre) and management is told about it.
      if (finalInVillage === false) {
        flags.push("outside_village");
        result.notes.push(`The point is not inside its HFR village (${designated?.name})`);
      } else if (finalInVillage === true && result.geocodeSource !== "hfr" && result.geocodeSource !== "review") {
        flags.push("village_fix");
      }

      await q(sql`
        INSERT INTO geo_validation (facility_code, has_boundary, in_ward, in_council, distance_to_ward_m, sanity_flags,
          match_source, matched_name, name_score, match_distance_m, osm_id, google_place_id, google_checked_at, geocode_source,
          final_lat, final_lng, confidence, notes, ward_name_check, ward_checked_at, ward_check_lat, ward_check_lng, village_check, boundary_village, boundary_village_ward, checked_at)
        VALUES (${f.facility_code}, ${hasBoundary}, ${inWard}, ${inCouncil}, ${distanceToWardM},
          ${flags.length ? sql`ARRAY[${sql.join(flags.map((x) => sql`${x}`), sql`, `)}]::text[]` : sql`ARRAY[]::text[]`},
          ${matchSource}, ${matchedName}, ${nameScoreVal}, ${matchDistanceM}, ${osmId}, ${googlePlaceId}, ${googleCheckedNow ? sql`now()` : sql`NULL`}, ${result.geocodeSource},
          ${result.final?.lat ?? null}, ${result.final?.lng ?? null}, ${result.confidence}, ${result.notes.join("; ")},
          ${wardCheck}, ${wardCheckFresh ? sql`now()` : sql`NULL`}, ${wardCheckFresh ? result.final!.lat : null}, ${wardCheckFresh ? result.final!.lng : null},
          ${village?.check ?? null}, ${village?.village ?? null}, ${village?.ward ?? null}, now())
        ON CONFLICT (facility_code) DO UPDATE SET
          has_boundary = EXCLUDED.has_boundary, in_ward = EXCLUDED.in_ward, in_council = EXCLUDED.in_council,
          distance_to_ward_m = EXCLUDED.distance_to_ward_m, sanity_flags = EXCLUDED.sanity_flags,
          match_source = EXCLUDED.match_source, matched_name = EXCLUDED.matched_name, name_score = EXCLUDED.name_score,
          match_distance_m = EXCLUDED.match_distance_m, osm_id = EXCLUDED.osm_id, google_place_id = EXCLUDED.google_place_id,
          google_checked_at = coalesce(EXCLUDED.google_checked_at, geo_validation.google_checked_at),
          geocode_source = EXCLUDED.geocode_source, final_lat = EXCLUDED.final_lat, final_lng = EXCLUDED.final_lng,
          confidence = EXCLUDED.confidence, notes = EXCLUDED.notes,
          ward_name_check = EXCLUDED.ward_name_check,
          ward_checked_at = coalesce(EXCLUDED.ward_checked_at, geo_validation.ward_checked_at),
          ward_check_lat = coalesce(EXCLUDED.ward_check_lat, geo_validation.ward_check_lat),
          ward_check_lng = coalesce(EXCLUDED.ward_check_lng, geo_validation.ward_check_lng),
          village_check = EXCLUDED.village_check, boundary_village = EXCLUDED.boundary_village,
          boundary_village_ward = EXCLUDED.boundary_village_ward,
          checked_at = now()`);
      stats.validated++;
    } catch (e) {
      stats.errors++;
      console.error(`[validate] ${f.facility_code}: ${errorMessage(e)}`);
      if (stats.errors > 5) throw e;
    }
  };
  await mapLimit(rows, env.geoConcurrency, validateOne);
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
