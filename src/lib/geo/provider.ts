import { env } from "../env";
import type { BBox, Place } from "./osm";
import { MaptilerUnavailable, maptilerReverseNames, maptilerSearch } from "./maptiler";
import { GoogleUnavailable, googleGeocode, googleReverseNames } from "./google";
import { ArcgisUnavailable, arcgisReverseNames, arcgisSearch } from "./arcgis";

export type GeoProvider = "auto" | "all" | "maptiler" | "google" | "arcgis";
export type ActiveProvider = "maptiler" | "google" | "arcgis";

/** Priority order: results from an earlier provider win when several answer. */
const ORDER: ActiveProvider[] = ["maptiler", "arcgis", "google"];

const hasKey = (p: ActiveProvider) => (p === "maptiler" ? !!env.maptilerKey : p === "google" ? !!env.googleKey : !!env.arcgisKey);

/**
 * Which geocoder the extra layer uses when only one is wanted. "auto" and "all" prefer MapTiler, then Google, then ArcGIS;
 * null when the needed key is missing.
 */
export function resolveProvider(pref: GeoProvider): ActiveProvider | null {
  if (pref === "maptiler" || pref === "google" || pref === "arcgis") return hasKey(pref) ? pref : null;
  return env.maptilerKey ? "maptiler" : env.googleKey ? "google" : env.arcgisKey ? "arcgis" : null;
}

/** Every geocoder the extra layer should use: all of those with a key for "all", else the single resolved one. */
export function resolveProviders(pref: GeoProvider): ActiveProvider[] {
  if (pref === "all") return ORDER.filter(hasKey);
  const one = resolveProvider(pref);
  return one ? [one] : [];
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

export interface AcrossResult<T> {
  /** answers, in provider priority order */
  answers: { provider: ActiveProvider; value: T }[];
  /** providers that said they cannot be used right now (cap, key): stop calling them */
  unavailable: ActiveProvider[];
  /** other failures (timeouts, 5xx): worth a warning, not a stop */
  errors: { provider: ActiveProvider; error: unknown }[];
}

/** Ask every provider at once. One provider failing never hides another's answer. */
export async function acrossProviders<T>(providers: ActiveProvider[], call: (p: ActiveProvider) => Promise<T>): Promise<AcrossResult<T>> {
  const ordered = ORDER.filter((p) => providers.includes(p));
  const settled = await Promise.allSettled(ordered.map((p) => call(p)));
  const out: AcrossResult<T> = { answers: [], unavailable: [], errors: [] };
  settled.forEach((s, i) => {
    const provider = ordered[i];
    if (s.status === "fulfilled") out.answers.push({ provider, value: s.value });
    else if (isUnavailable(s.reason)) out.unavailable.push(provider);
    else out.errors.push({ provider, error: s.reason });
  });
  return out;
}
