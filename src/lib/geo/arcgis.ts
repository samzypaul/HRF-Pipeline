import { env } from "../env";
import { reserveCall } from "./usage";
import type { BBox, Place } from "./osm";

/**
 * ArcGIS World Geocoding Service: forward search (find a missing point) and reverse search
 * (which ward/district does a point fall in). Calls are reserved against a monthly cap first.
 * Forward results are stored as facility coordinates, so they are requested with forStorage=true
 * (billed in credits); reverse results only feed a name comparison and are not stored.
 */

export class ArcgisUnavailable extends Error {}

const BASE = "https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer";

interface Candidate {
  address?: string;
  location?: { x: number; y: number };
  score?: number;
  attributes?: { Addr_type?: string; Type?: string; PlaceName?: string };
}

interface ReverseAddress {
  Neighborhood?: string;
  District?: string;
  City?: string;
  Subregion?: string;
  Region?: string;
}

async function request<T>(path: string, params: Record<string, string>, fetchImpl: typeof fetch): Promise<T> {
  const key = env.arcgisKey;
  if (!key) throw new ArcgisUnavailable("ARCGIS_API_KEY not set");
  if (!(await reserveCall("arcgis", env.arcgisMonthlyCap))) throw new ArcgisUnavailable("Monthly ArcGIS cap reached");
  const u = new URL(`${BASE}/${path}`);
  u.searchParams.set("f", "json");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetchImpl(u, { headers: { "X-Esri-Authorization": `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403) throw new ArcgisUnavailable(`ArcGIS rejected the key (${res.status})`);
  if (res.status === 429) throw new ArcgisUnavailable("ArcGIS rate limit reached");
  if (!res.ok) throw new Error(`ArcGIS returned ${res.status}`);
  // ArcGIS reports most failures as HTTP 200 with an error object.
  const body = (await res.json()) as T & { error?: { code?: number; message?: string } };
  const code = body.error?.code;
  if (code === 498 || code === 499 || code === 403) throw new ArcgisUnavailable(`ArcGIS rejected the key (${code}: ${body.error?.message ?? ""})`);
  if (code === 429) throw new ArcgisUnavailable("ArcGIS rate limit reached");
  if (body.error) throw new Error(`ArcGIS error ${code}: ${body.error.message ?? ""}`);
  return body;
}

/** Forward geocoding limited to Tanzania, optionally to a rectangle. */
export async function arcgisSearch(query: string, opts: { bbox?: BBox; fetchImpl?: typeof fetch } = {}): Promise<Place[]> {
  const params: Record<string, string> = {
    singleLine: query,
    countryCode: "TZA",
    maxLocations: "5",
    outFields: "Addr_type,Type,PlaceName",
    forStorage: "true",
  };
  if (opts.bbox) params.searchExtent = `${opts.bbox.west},${opts.bbox.south},${opts.bbox.east},${opts.bbox.north}`;
  const body = await request<{ candidates?: Candidate[] }>("findAddressCandidates", params, opts.fetchImpl ?? fetch);
  return (body.candidates ?? [])
    .filter((c) => c.location && Number.isFinite(c.location.x) && Number.isFinite(c.location.y) && (c.score ?? 0) >= 70)
    .map((c) => ({
      source: "arcgis" as const,
      id: "",
      name: c.attributes?.PlaceName || (c.address ?? "").split(",")[0],
      lat: c.location!.y,
      lng: c.location!.x,
      kind: c.attributes?.Addr_type,
    }));
}

/** Names of the areas a point falls in, most specific first. */
export async function arcgisReverseNames(lat: number, lng: number, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const body = await request<{ address?: ReverseAddress }>("reverseGeocode", { location: `${lng},${lat}` }, fetchImpl);
  return arcgisNames(body.address);
}

export function arcgisNames(a: ReverseAddress | undefined): string[] {
  if (!a) return [];
  const out = [a.Neighborhood, a.District, a.City, a.Subregion, a.Region].map((s) => (s ?? "").trim()).filter(Boolean);
  return [...new Set(out)];
}
