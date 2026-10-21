import { env } from "../env";
import { reserveCall } from "./usage";
import type { BBox, Place } from "./osm";
import { normAdmin } from "./wards";
import { ratio } from "./name-match";

/**
 * MapTiler Geocoding API: forward search (find a missing point) and reverse search
 * (which ward/district does a point fall in). Calls are reserved against a monthly cap first.
 */

export class MaptilerUnavailable extends Error {}

/** MapTiler keys are usually restricted to a website's address, so a server call sends this site's as its origin. */
export function maptilerHeaders(): Record<string, string> {
  const origin = env.maptilerOrigin;
  return { Origin: origin, Referer: `${origin}/` };
}

interface Feature {
  id?: string;
  text?: string;
  place_name?: string;
  place_type?: string[];
  center?: [number, number];
  context?: Array<{ id?: string; text?: string }>;
}

async function geocodingRequest(path: string, params: Record<string, string>, fetchImpl: typeof fetch): Promise<Feature[]> {
  const key = env.maptilerKey;
  if (!key) throw new MaptilerUnavailable("MAPTILER_API_KEY not set");
  if (!(await reserveCall("maptiler", env.maptilerMonthlyCap))) throw new MaptilerUnavailable("Monthly MapTiler cap reached");
  const u = new URL(`https://api.maptiler.com/geocoding/${path}.json`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("key", key);
  const res = await fetchImpl(u, { headers: maptilerHeaders(), signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403) throw new MaptilerUnavailable(`MapTiler rejected the key (${res.status})`);
  if (res.status === 429) throw new MaptilerUnavailable("MapTiler rate limit reached");
  if (!res.ok) throw new Error(`MapTiler returned ${res.status}`);
  return ((await res.json()) as { features?: Feature[] }).features ?? [];
}

/** Forward geocoding limited to Tanzania, optionally to a rectangle. */
export async function maptilerSearch(query: string, opts: { bbox?: BBox; fetchImpl?: typeof fetch } = {}): Promise<Place[]> {
  const params: Record<string, string> = { country: "tz", limit: "5" };
  if (opts.bbox) params.bbox = `${opts.bbox.west},${opts.bbox.south},${opts.bbox.east},${opts.bbox.north}`;
  const features = await geocodingRequest(encodeURIComponent(query), params, opts.fetchImpl ?? fetch);
  return features
    .filter((f) => Array.isArray(f.center) && f.center.length === 2)
    .map((f) => ({
      source: "maptiler" as const,
      id: f.id ?? "",
      name: f.text ?? (f.place_name ?? "").split(",")[0],
      lat: f.center![1],
      lng: f.center![0],
      kind: f.place_type?.[0],
    }));
}

/** Names of the places a point falls in (the feature itself and its parents), most specific first. */
export async function maptilerReverseNames(lat: number, lng: number, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  // No `limit`: MapTiler rejects it for a reverse lookup unless a single type is given, and the whole place hierarchy is what is wanted.
  const features = await geocodingRequest(`${lng},${lat}`, {}, fetchImpl);
  return namesFrom(features);
}

export function namesFrom(features: Feature[]): string[] {
  const out: string[] = [];
  for (const f of features) {
    if (f.text) out.push(f.text);
    for (const c of f.context ?? []) if (c.text) out.push(c.text);
  }
  return [...new Set(out)];
}

export type WardNameCheck = "agrees" | "differs" | "unknown";

/** Combine the verdicts of several geocoders: one that agrees settles it, "differs" needs a dissent with no agreement. */
export function combineWardChecks(checks: WardNameCheck[]): WardNameCheck {
  if (checks.includes("agrees")) return "agrees";
  return checks.includes("differs") ? "differs" : "unknown";
}

/**
 * Compare reverse-geocoded names with the HFR ward and council. "differs" only when MapTiler returned
 * names but none of them is the ward or the council; no names at all is "unknown" (thin map coverage).
 */
export function wardNameCheck(names: string[], ward: string | null, council: string | null): WardNameCheck {
  if (names.length === 0) return "unknown";
  const targets = [ward, council].map(normAdmin).filter(Boolean);
  if (targets.length === 0) return "unknown";
  const hit = names.some((n) => targets.some((t) => ratio(t, normAdmin(n)) >= 85));
  return hit ? "agrees" : "differs";
}
