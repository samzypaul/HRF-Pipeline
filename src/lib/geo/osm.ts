import { env } from "../env";
import { sleep } from "../util";
import { countCall } from "./usage";

export interface Place {
  source: "osm" | "google" | "nominatim" | "google_geocode" | "maptiler" | "arcgis";
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** extra names (alt_name, name:sw, official_name) used for matching */
  altNames?: string[];
  kind?: string;
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

const UA = () => `HFR-Pipeline/1.0 (health facility data quality; contact: ${env.nominatimEmail})`;

let lastOverpass = 0;
let lastNominatim = 0;

async function spaced(last: number, gapMs: number): Promise<number> {
  const wait = last + gapMs - Date.now();
  if (wait > 0) await sleep(wait);
  return Date.now();
}

/** All health-related OSM features inside a bounding box. */
export async function overpassHealthPlaces(bbox: BBox, fetchImpl: typeof fetch = fetch): Promise<Place[]> {
  lastOverpass = await spaced(lastOverpass, 2000);
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const query = `[out:json][timeout:40];
(
  nwr["amenity"~"^(hospital|clinic|doctors|dentist|pharmacy|health_post|nursing_home)$"](${b});
  nwr["healthcare"](${b});
);
out center tags;`;
  let res: Response | null = null;
  const errors: string[] = [];
  const deadline = Date.now() + 80_000; // never spend more than 80 s on one area
  for (const url of env.overpassUrls) {
    const left = deadline - Date.now();
    if (left < 5_000) break;
    try {
      const r = await fetchImpl(url, {
        method: "POST",
        body: new URLSearchParams({ data: query }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA() },
        signal: AbortSignal.timeout(Math.min(45_000, left)),
      });
      await countCall("overpass");
      if (r.ok) {
        res = r;
        break;
      }
      errors.push(`${new URL(url).host} ${r.status}`);
    } catch (e) {
      errors.push(`${new URL(url).host} ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!res) throw new Error(`All Overpass endpoints failed: ${errors.join("; ")}`);
  const json = (await res.json()) as {
    elements: Array<{
      type: string;
      id: number;
      lat?: number;
      lon?: number;
      center?: { lat: number; lon: number };
      tags?: Record<string, string>;
    }>;
  };
  const out: Place[] = [];
  for (const el of json.elements ?? []) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    const tags = el.tags ?? {};
    const name = tags.name ?? tags["name:en"] ?? tags["name:sw"];
    if (lat == null || lng == null || !name) continue;
    out.push({
      source: "osm",
      id: `${el.type}/${el.id}`,
      name,
      lat,
      lng,
      altNames: [tags.alt_name, tags.official_name, tags["name:sw"], tags["name:en"], tags.old_name].filter(
        (x): x is string => !!x && x !== name,
      ),
      kind: tags.healthcare ?? tags.amenity,
    });
  }
  return out;
}

/** Free-text geocoding with OSM Nominatim (max 1 request per second). */
export async function nominatimSearch(
  query: string,
  opts: { viewbox?: BBox; fetchImpl?: typeof fetch } = {},
): Promise<Place[]> {
  lastNominatim = await spaced(lastNominatim, 1100);
  const u = new URL("/search", env.nominatimUrl);
  u.searchParams.set("q", query);
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("countrycodes", "tz");
  u.searchParams.set("limit", "5");
  u.searchParams.set("email", env.nominatimEmail);
  if (opts.viewbox) {
    const v = opts.viewbox;
    u.searchParams.set("viewbox", `${v.west},${v.north},${v.east},${v.south}`);
    u.searchParams.set("bounded", "1");
  }
  const res = await (opts.fetchImpl ?? fetch)(u, {
    headers: { "User-Agent": UA() },
    signal: AbortSignal.timeout(20_000),
  });
  await countCall("nominatim");
  if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);
  const json = (await res.json()) as Array<{ osm_type: string; osm_id: number; lat: string; lon: string; name?: string; display_name: string; type?: string }>;
  return json.map((r) => ({
    source: "nominatim" as const,
    id: `${r.osm_type}/${r.osm_id}`,
    name: r.name || r.display_name.split(",")[0],
    lat: Number(r.lat),
    lng: Number(r.lon),
    kind: r.type,
  }));
}
