/** Checks on a raw HFR coordinate before it is trusted. */

// Tanzania mainland + Zanzibar, with a small margin.
export const TZ_BBOX = { minLat: -11.8, maxLat: -0.9, minLng: 29.2, maxLng: 40.6 };

// The portal's default map centre; points sitting exactly here were never set.
export const PORTAL_DEFAULT = { lat: -6.17964, lng: 35.7436 };

export type SanityFlag =
  | "missing"
  | "zero"
  | "portal_default"
  | "swapped_lat_lng"
  | "outside_tanzania"
  | "low_precision"
  | "shared_point"
  | "geocoder_ward_differs"
  | "village_ward_differs"
  | "outside_council"
  | "weak_name_match";

export interface SanityResult {
  flags: SanityFlag[];
  /** true when the point can be used as a location at all */
  usable: boolean;
  /** corrected point when lat/lng were swapped */
  fixed?: { lat: number; lng: number };
}

const inTz = (lat: number, lng: number) =>
  lat >= TZ_BBOX.minLat && lat <= TZ_BBOX.maxLat && lng >= TZ_BBOX.minLng && lng <= TZ_BBOX.maxLng;

export function checkPoint(lat: number | null | undefined, lng: number | null | undefined): SanityResult {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { flags: ["missing"], usable: false };
  }
  if (Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6) return { flags: ["zero"], usable: false };
  if (Math.abs(lat - PORTAL_DEFAULT.lat) < 1e-5 && Math.abs(lng - PORTAL_DEFAULT.lng) < 1e-5) {
    return { flags: ["portal_default"], usable: false };
  }
  const flags: SanityFlag[] = [];
  const decimals = (x: number) => (String(x).split(".")[1] ?? "").length;
  if (decimals(lat) < 2 || decimals(lng) < 2) flags.push("low_precision");
  if (inTz(lat, lng)) return { flags, usable: true };
  if (inTz(lng, lat)) return { flags: [...flags, "swapped_lat_lng"], usable: true, fixed: { lat: lng, lng: lat } };
  return { flags: [...flags, "outside_tanzania"], usable: false };
}
