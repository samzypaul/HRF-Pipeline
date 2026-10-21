import { sql, type SQL } from "drizzle-orm";
import { q } from "../db/client";
import { SERVICES, SERVICE_BY_CODE, TIERS, type Tier } from "./catalogue";

export type Lang = "en" | "sw";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const DEFAULT_RADIUS_KM = 25;
export const MAX_RADIUS_KM = 200;

export interface FacilityQuery {
  lang: Lang;
  services: string[];
  tiers: Tier[];
  region?: string;
  council?: string;
  q?: string;
  near?: { lat: number; lng: number; radiusKm: number };
  minConfidence?: "medium" | "high";
  limit: number;
  offset: number;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const ADMIN_CODE = /^TZ(\.[A-Z0-9]{1,4}){0,5}$/;
const list = (v: string | null) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function parseLang(sp: URLSearchParams): Parsed<Lang> {
  const v = sp.get("lang");
  if (v == null || v === "") return { ok: true, value: "en" };
  return v === "en" || v === "sw" ? { ok: true, value: v } : { ok: false, message: "lang must be 'en' or 'sw'." };
}

/** Read and check the facility search parameters. Everything is validated here, so nothing unchecked reaches the database. */
export function parseFacilityQuery(sp: URLSearchParams): Parsed<FacilityQuery> {
  const lang = parseLang(sp);
  if (!lang.ok) return lang;

  const services = list(sp.get("service")).map((c) => c.toUpperCase());
  const unknown = services.filter((c) => !SERVICE_BY_CODE.has(c));
  if (unknown.length) return { ok: false, message: `Unknown service code(s): ${unknown.join(", ")}. See /api/v1/climate/services.` };

  const tiers: Tier[] = [];
  for (const t of list(sp.get("tier"))) {
    const n = Number(t);
    if (!Number.isInteger(n) || n < 1 || n > 5) return { ok: false, message: "tier must be one or more of 1, 2, 3, 4, 5." };
    tiers.push(n as Tier);
  }

  const region = sp.get("region")?.trim().toUpperCase() || undefined;
  if (region && !ADMIN_CODE.test(region)) return { ok: false, message: "region must be a portal region code such as TZ.CL.DO." };
  const council = sp.get("council")?.trim().toUpperCase() || undefined;
  if (council && !ADMIN_CODE.test(council)) return { ok: false, message: "council must be a portal council code such as TZ.CL.DO.BA." };

  const text = sp.get("q")?.trim() || undefined;
  if (text && text.length > 80) return { ok: false, message: "q must be at most 80 characters." };

  const latRaw = sp.get("lat");
  const lngRaw = sp.get("lng");
  let near: FacilityQuery["near"];
  if (latRaw != null || lngRaw != null) {
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (latRaw == null || lngRaw == null || latRaw === "" || lngRaw === "" || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return { ok: false, message: "lat and lng must both be given, as decimal degrees." };
    }
    const radiusRaw = sp.get("radius_km");
    const radiusKm = radiusRaw == null || radiusRaw === "" ? DEFAULT_RADIUS_KM : Number(radiusRaw);
    if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > MAX_RADIUS_KM) return { ok: false, message: `radius_km must be between 0 and ${MAX_RADIUS_KM}.` };
    near = { lat, lng, radiusKm };
  }

  const conf = sp.get("min_confidence");
  if (conf && conf !== "medium" && conf !== "high") return { ok: false, message: "min_confidence must be 'medium' or 'high'." };

  const limitRaw = sp.get("limit");
  const limit = limitRaw == null || limitRaw === "" ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { ok: false, message: `limit must be a whole number from 1 to ${MAX_LIMIT}.` };
  const offsetRaw = sp.get("offset");
  const offset = offsetRaw == null || offsetRaw === "" ? 0 : Number(offsetRaw);
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) return { ok: false, message: "offset must be a whole number of 0 or more." };

  return { ok: true, value: { lang: lang.value, services, tiers, region, council, q: text, near, minConfidence: conf ?? undefined, limit, offset } as FacilityQuery };
}

/** Only facilities worth showing to the public: operating, located, and offering at least one climate-sensitive service. */
const ELIGIBLE = sql`f.removed_at IS NULL AND f.operating_status ILIKE 'operating' AND coalesce(g.final_lat, f.hfr_lat) IS NOT NULL
  AND EXISTS (SELECT 1 FROM facility_climate_services cs0 WHERE cs0.facility_code = f.facility_code)`;

interface FacilityRow {
  facility_code: string;
  name: string;
  facility_type: string | null;
  ownership_category: string | null;
  region_code: string | null;
  region_name: string | null;
  district_name: string | null;
  council_code: string | null;
  council_name: string | null;
  ward_name: string | null;
  village_name: string | null;
  lat: number;
  lng: number;
  confidence: string | null;
  source: string;
  phone: string | null;
  distance_km: number | null;
  total: number;
}

const localised = (lang: Lang, en: string, sw: string) => (lang === "sw" ? sw : en);

export function serviceView(code: string, lang: Lang) {
  const s = SERVICE_BY_CODE.get(code);
  if (!s) return null;
  return {
    code: s.code,
    name: localised(lang, s.name, s.nameSw),
    category: localised(lang, s.category, s.categorySw),
    tier: s.tier,
    tier_name: localised(lang, TIERS[s.tier].en, TIERS[s.tier].sw),
  };
}

const STAND_INS = new Set(["village_centroid", "ward_centroid", "council_centroid"]);

/** The public shape of one facility. Internal fields (review notes, flags, the portal's raw coordinates) are never included. */
export function facilityView(r: FacilityRow, codes: string[], lang: Lang) {
  return {
    code: r.facility_code,
    name: r.name,
    type: r.facility_type,
    ownership: r.ownership_category,
    phone: r.phone,
    region: r.region_name,
    district: r.district_name,
    council: r.council_name,
    ward: r.ward_name,
    village: r.village_name,
    location: {
      lat: Number(r.lat),
      lng: Number(r.lng),
      // A village, ward or council centre, or an unconfirmed point: show it as an area, not a pin on the door.
      approximate: STAND_INS.has(r.source) || r.confidence === "low" || r.confidence == null,
      confidence: r.confidence ?? "unchecked",
    },
    ...(r.distance_km != null ? { distance_km: Math.round(Number(r.distance_km) * 10) / 10 } : {}),
    services: codes
      .map((c) => serviceView(c, lang))
      .filter((s): s is NonNullable<typeof s> => s != null)
      .sort((a, b) => a.tier - b.tier || a.code.localeCompare(b.code)),
  };
}

const SELECT = sql`
  f.facility_code, f.name, f.facility_type, f.ownership_category, f.region_code, f.region_name, f.district_name, f.council_code, f.council_name,
  f.ward_name, f.village_name, coalesce(g.final_lat, f.hfr_lat) AS lat, coalesce(g.final_lng, f.hfr_lng) AS lng, g.confidence,
  coalesce(g.geocode_source, 'hfr') AS source, coalesce(f.phone_e164, f.phone) AS phone`;

async function servicesFor(codes: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (codes.length === 0) return out;
  const rows = await q<{ facility_code: string; service_code: string }>(sql`
    SELECT facility_code, service_code FROM facility_climate_services WHERE facility_code = ANY(${sql.param(codes)}::text[])`);
  for (const r of rows) out.set(r.facility_code, [...(out.get(r.facility_code) ?? []), r.service_code]);
  return out;
}

export async function searchFacilities(query: FacilityQuery) {
  const where: SQL[] = [ELIGIBLE];
  if (query.services.length || query.tiers.length) {
    const parts: SQL[] = [];
    if (query.services.length) parts.push(sql`cs.service_code = ANY(${sql.param(query.services)}::text[])`);
    if (query.tiers.length) parts.push(sql`cs.tier = ANY(${sql.param(query.tiers)}::smallint[])`);
    where.push(sql`EXISTS (SELECT 1 FROM facility_climate_services cs WHERE cs.facility_code = f.facility_code AND ${sql.join(parts, sql` AND `)})`);
  }
  if (query.region) where.push(sql`f.region_code = ${query.region}`);
  if (query.council) where.push(sql`f.council_code = ${query.council}`);
  if (query.q) where.push(sql`(f.name ILIKE ${"%" + query.q.replace(/[%_\\]/g, "\\$&") + "%"} OR f.common_name ILIKE ${"%" + query.q.replace(/[%_\\]/g, "\\$&") + "%"})`);
  if (query.minConfidence) {
    where.push(query.minConfidence === "high" ? sql`g.confidence = 'high'` : sql`g.confidence IN ('high', 'medium')`);
  }
  const distance = query.near
    ? sql`6371 * acos(least(1, cos(radians(${query.near.lat})) * cos(radians(coalesce(g.final_lat, f.hfr_lat))) * cos(radians(coalesce(g.final_lng, f.hfr_lng)) - radians(${query.near.lng}))
        + sin(radians(${query.near.lat})) * sin(radians(coalesce(g.final_lat, f.hfr_lat)))))`
    : sql`NULL::double precision`;
  const rows = await q<FacilityRow>(sql`
    WITH base AS (
      SELECT ${SELECT}, ${distance} AS distance_km
      FROM facilities f LEFT JOIN geo_validation g ON g.facility_code = f.facility_code
      WHERE ${sql.join(where, sql` AND `)})
    SELECT *, count(*) OVER ()::int AS total FROM base
    ${query.near ? sql`WHERE distance_km <= ${query.near.radiusKm}` : sql``}
    ORDER BY ${query.near ? sql`distance_km, name` : sql`name, facility_code`}
    LIMIT ${query.limit} OFFSET ${query.offset}`);
  const services = await servicesFor(rows.map((r) => r.facility_code));
  return { total: rows[0]?.total ?? 0, data: rows.map((r) => facilityView(r, services.get(r.facility_code) ?? [], query.lang)) };
}

export async function getFacility(code: string, lang: Lang) {
  const [row] = await q<FacilityRow>(sql`
    SELECT ${SELECT}, NULL::double precision AS distance_km, 1 AS total
    FROM facilities f LEFT JOIN geo_validation g ON g.facility_code = f.facility_code
    WHERE ${ELIGIBLE} AND f.facility_code = ${code}`);
  if (!row) return null;
  const services = await servicesFor([row.facility_code]);
  return facilityView(row, services.get(row.facility_code) ?? [], lang);
}

export async function listServices(lang: Lang) {
  const counts = await q<{ service_code: string; n: number }>(sql`
    SELECT cs.service_code, count(DISTINCT f.facility_code)::int AS n
    FROM facilities f LEFT JOIN geo_validation g ON g.facility_code = f.facility_code
    JOIN facility_climate_services cs ON cs.facility_code = f.facility_code
    WHERE ${ELIGIBLE} GROUP BY 1`);
  const n = new Map(counts.map((c) => [c.service_code, c.n]));
  return SERVICES.map((s) => ({
    code: s.code,
    name: localised(lang, s.name, s.nameSw),
    description: localised(lang, s.descEn, s.descSw),
    category: localised(lang, s.category, s.categorySw),
    tier: s.tier,
    tier_name: localised(lang, TIERS[s.tier].en, TIERS[s.tier].sw),
    facilities: n.get(s.code) ?? 0,
  })).sort((a, b) => a.tier - b.tier || a.code.localeCompare(b.code));
}

export async function listRegions(regionCode: string | undefined) {
  if (regionCode) {
    return q<{ code: string; name: string; facilities: number }>(sql`
      SELECT f.council_code AS code, f.council_name AS name, count(*)::int AS facilities
      FROM facilities f LEFT JOIN geo_validation g ON g.facility_code = f.facility_code
      WHERE ${ELIGIBLE} AND f.region_code = ${regionCode} AND f.council_code IS NOT NULL GROUP BY 1, 2 ORDER BY 2`);
  }
  return q<{ code: string; name: string; facilities: number }>(sql`
    SELECT f.region_code AS code, f.region_name AS name, count(*)::int AS facilities
    FROM facilities f LEFT JOIN geo_validation g ON g.facility_code = f.facility_code
    WHERE ${ELIGIBLE} AND f.region_code IS NOT NULL GROUP BY 1, 2 ORDER BY 2`);
}
