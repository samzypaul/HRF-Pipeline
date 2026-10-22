import { env } from "../env";
import { reserveCall } from "./usage";
import type { BBox, Place } from "./osm";

/**
 * Google is the fallback only. Every call is reserved against a monthly cap
 * first, so the pipeline cannot exceed the free tier by accident.
 * Per Google's terms we keep only the place ID and our own match result,
 * not Google's names or details.
 */

export class GoogleUnavailable extends Error {}

/** Places API (New) Text Search, restricted to a rectangle. */
export async function googleTextSearch(
  query: string,
  restrict: BBox,
  fetchImpl: typeof fetch = fetch,
): Promise<Place[]> {
  const key = env.googleKey;
  if (!key) throw new GoogleUnavailable("GOOGLE_MAPS_API_KEY not set");
  if (!(await reserveCall("google_places", env.googlePlacesMonthlyCap))) {
    throw new GoogleUnavailable("Monthly Google Places cap reached");
  }
  const res = await fetchImpl("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.id,places.displayName,places.location",
    },
    body: JSON.stringify({
      textQuery: query,
      regionCode: "TZ",
      pageSize: 5,
      locationRestriction: {
        rectangle: {
          low: { latitude: restrict.south, longitude: restrict.west },
          high: { latitude: restrict.north, longitude: restrict.east },
        },
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Google Places returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as {
    places?: Array<{ id: string; displayName?: { text: string }; location?: { latitude: number; longitude: number } }>;
  };
  return (json.places ?? [])
    .filter((p) => p.location)
    .map((p) => ({
      source: "google" as const,
      id: p.id,
      name: p.displayName?.text ?? "",
      lat: p.location!.latitude,
      lng: p.location!.longitude,
    }));
}

/** Reverse geocoding: names of the administrative areas a point falls in. Counts against the Geocoding cap. */
export async function googleReverseNames(lat: number, lng: number, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const key = env.googleKey;
  if (!key) throw new GoogleUnavailable("GOOGLE_MAPS_API_KEY not set");
  if (!(await reserveCall("google_geocode", env.googleGeocodeMonthlyCap))) {
    throw new GoogleUnavailable("Monthly Google Geocoding cap reached");
  }
  const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  u.searchParams.set("latlng", `${lat},${lng}`);
  u.searchParams.set("result_type", "administrative_area_level_3|administrative_area_level_4|sublocality|locality|neighborhood");
  u.searchParams.set("key", key);
  const res = await fetchImpl(u, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Google reverse geocoding returned ${res.status}`);
  const json = (await res.json()) as { status: string; results?: GoogleReverseResult[] };
  if (json.status === "REQUEST_DENIED") throw new GoogleUnavailable("Google rejected the request (is the Geocoding API enabled for this key?)");
  if (json.status !== "OK" && json.status !== "ZERO_RESULTS") throw new Error(`Google reverse geocoding status ${json.status}`);
  return googleNames(json.results ?? []);
}

export interface GoogleReverseResult {
  address_components?: Array<{ long_name: string; types: string[] }>;
}

const AREA_TYPES = /^(administrative_area_level_[1-4]|locality|sublocality(_level_\d)?|neighborhood)$/;

/** Long names of the area-type address components, de-duplicated. */
export function googleNames(results: GoogleReverseResult[]): string[] {
  const out = new Set<string>();
  for (const r of results) {
    for (const c of r.address_components ?? []) if (c.types.some((t) => AREA_TYPES.test(t))) out.add(c.long_name);
  }
  return [...out];
}

/** Geocoding API, limited to Tanzania; `bbox` makes Google prefer results inside that rectangle (a bias, not a filter). */
export async function googleGeocode(address: string, bbox?: BBox, fetchImpl: typeof fetch = fetch): Promise<Place[]> {
  const key = env.googleKey;
  if (!key) throw new GoogleUnavailable("GOOGLE_MAPS_API_KEY not set");
  if (!(await reserveCall("google_geocode", env.googleGeocodeMonthlyCap))) {
    throw new GoogleUnavailable("Monthly Google Geocoding cap reached");
  }
  const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  u.searchParams.set("address", address);
  u.searchParams.set("components", "country:TZ");
  if (bbox) u.searchParams.set("bounds", `${bbox.south},${bbox.west}|${bbox.north},${bbox.east}`);
  u.searchParams.set("key", key);
  const res = await fetchImpl(u, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Google Geocoding returned ${res.status}`);
  const json = (await res.json()) as {
    status: string;
    results?: Array<{ place_id: string; formatted_address: string; geometry: { location: { lat: number; lng: number }; location_type: string } }>;
  };
  if (json.status !== "OK" && json.status !== "ZERO_RESULTS") throw new Error(`Google Geocoding status ${json.status}`);
  return (json.results ?? []).map((r) => ({
    source: "google_geocode" as const,
    id: r.place_id,
    name: r.formatted_address.split(",")[0],
    lat: r.geometry.location.lat,
    lng: r.geometry.location.lng,
    kind: r.geometry.location_type,
  }));
}
