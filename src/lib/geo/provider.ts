import { env } from "../env";
import type { BBox, Place } from "./osm";
import { MaptilerUnavailable, maptilerReverseNames, maptilerSearch } from "./maptiler";
import { GoogleUnavailable, googleGeocode, googleReverseNames } from "./google";
import { ArcgisUnavailable, arcgisReverseNames, arcgisSearch } from "./arcgis";

export type GeoProvider = "auto" | "maptiler" | "google" | "arcgis";
export type ActiveProvider = "maptiler" | "google" | "arcgis";

/** Which geocoder the extra layer uses. "auto" prefers MapTiler, then Google, then ArcGIS; null when the needed key is missing. */
export function resolveProvider(pref: GeoProvider): ActiveProvider | null {
  if (pref === "maptiler") return env.maptilerKey ? "maptiler" : null;
  if (pref === "google") return env.googleKey ? "google" : null;
  if (pref === "arcgis") return env.arcgisKey ? "arcgis" : null;
  return env.maptilerKey ? "maptiler" : env.googleKey ? "google" : env.arcgisKey ? "arcgis" : null;
}

/** True for "this provider can't be used right now" (no key, cap reached, key rejected): stop calling it. */
export function isUnavailable(e: unknown): boolean {
  return e instanceof MaptilerUnavailable || e instanceof GoogleUnavailable || e instanceof ArcgisUnavailable;
}

/** Place names (the point's own and its parents) used to check the ward. */
export function reverseNames(provider: ActiveProvider, lat: number, lng: number): Promise<string[]> {
  if (provider === "maptiler") return maptilerReverseNames(lat, lng);
  return provider === "arcgis" ? arcgisReverseNames(lat, lng) : googleReverseNames(lat, lng);
}

/** Forward search, limited to Tanzania. */
export function forwardSearch(provider: ActiveProvider, query: string, bbox?: BBox): Promise<Place[]> {
  if (provider === "maptiler") return maptilerSearch(query, { bbox });
  return provider === "arcgis" ? arcgisSearch(query, { bbox }) : googleGeocode(query);
}
