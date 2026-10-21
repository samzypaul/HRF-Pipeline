import { env } from "../env";
import { GeminiError, GeminiUnavailable, geminiJson, type GeminiSchema } from "../ai/gemini";
import { maptilerHeaders } from "./maptiler";
import { reserveCall } from "./usage";
import type { Confidence } from "./grade";

/**
 * Satellite check: is there really a building at the point?
 *
 * A satellite picture is fetched around the point (MapTiler when its key is set, else the Google Static Maps API with the Google key)
 * and Gemini is asked whether a building or compound stands at the very centre. A building is evidence the point is a real place,
 * so it lifts the grade one step; "no building" or "unclear" never lowers it (thatch, trees and old imagery fool the eye) but sends
 * the facility to the review queue, where a person looks at the same picture.
 */

export type SatelliteStatus = "building" | "none" | "unclear";

/** The check cannot run right now (no key, monthly cap reached, key rejected, Gemini out of credit): stop and try again on a later run. */
export class SatelliteUnavailable extends Error {}

export interface SatelliteImage {
  data: Buffer;
  mimeType: string;
  source: "maptiler" | "google";
}

export interface SatelliteVerdict {
  status: SatelliteStatus;
  note: string;
  source: SatelliteImage["source"];
  model: string;
}

const SIZE = 512;

/** The Google Static Maps address of a picture centred on the point. Pure, so the shape can be tested without a key. */
export function googleImageUrl(lat: number, lng: number, zoom: number, key: string): string {
  const u = new URL("https://maps.googleapis.com/maps/api/staticmap");
  u.searchParams.set("center", `${lat},${lng}`);
  u.searchParams.set("zoom", String(zoom));
  u.searchParams.set("size", `${SIZE}x${SIZE}`);
  u.searchParams.set("maptype", "satellite");
  u.searchParams.set("key", key);
  return u.toString();
}

/** MapTiler satellite tile address. */
export function maptilerTileUrl(z: number, x: number, y: number, key: string): string {
  return `https://api.maptiler.com/tiles/satellite-v2/${z}/${x}/${y}.jpg?key=${encodeURIComponent(key)}`;
}

/**
 * Which MapTiler tiles cover a SIZE x SIZE picture centred on the point, and where to cut it. MapTiler's satellite tiles are 512 px, so
 * the tile zoom is one below the Google-style zoom for the same ground size. Pure.
 */
export function tilePlan(lat: number, lng: number, zoom: number): { z: number; tiles: { x: number; y: number }[]; cols: number; rows: number; left: number; top: number } {
  const z = Math.max(0, zoom - 1);
  const world = 512 * 2 ** z;
  const px = ((lng + 180) / 360) * world;
  const sin = Math.sin((lat * Math.PI) / 180);
  const py = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * world;
  const x0 = Math.floor((px - SIZE / 2) / 512);
  const x1 = Math.floor((px + SIZE / 2 - 1) / 512);
  const y0 = Math.floor((py - SIZE / 2) / 512);
  const y1 = Math.floor((py + SIZE / 2 - 1) / 512);
  const tiles: { x: number; y: number }[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ x, y });
  return { z, tiles, cols: x1 - x0 + 1, rows: y1 - y0 + 1, left: Math.round(px - SIZE / 2 - x0 * 512), top: Math.round(py - SIZE / 2 - y0 * 512) };
}

/** A picture centred on the point, cut from MapTiler's satellite tiles (the Static Maps API is not on every MapTiler plan). */
async function maptilerPicture(lat: number, lng: number, fetchImpl: typeof fetch): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const key = env.maptilerKey!;
  const plan = tilePlan(lat, lng, env.satelliteZoom);
  const buffers: Buffer[] = [];
  for (const t of plan.tiles) {
    if (!(await reserveCall("maptiler_tiles", env.maptilerTileMonthlyCap))) throw new SatelliteUnavailable("Monthly MapTiler satellite tile cap reached");
    const res = await fetchImpl(maptilerTileUrl(plan.z, t.x, t.y, key), { headers: maptilerHeaders(), signal: AbortSignal.timeout(20_000) });
    if (res.status === 401 || res.status === 403) throw new SatelliteUnavailable(`maptiler rejected the key for satellite tiles (${res.status})`);
    if (res.status === 429) throw new SatelliteUnavailable("maptiler rate limit reached");
    if (!res.ok) throw new Error(`maptiler satellite tile returned ${res.status}`);
    buffers.push(Buffer.from(await res.arrayBuffer()));
  }
  return sharp({ create: { width: plan.cols * 512, height: plan.rows * 512, channels: 3, background: "#000" } })
    .composite(buffers.map((input, i) => ({ input, left: (i % plan.cols) * 512, top: Math.floor(i / plan.cols) * 512 })))
    .extract({ left: plan.left, top: plan.top, width: SIZE, height: SIZE })
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** Fetch the satellite picture around a point. Throws SatelliteUnavailable when no provider can be used. */
export async function fetchSatelliteImage(lat: number, lng: number, fetchImpl: typeof fetch = fetch): Promise<SatelliteImage> {
  if (env.maptilerKey) return { data: await maptilerPicture(lat, lng, fetchImpl), mimeType: "image/jpeg", source: "maptiler" };
  if (!env.googleKey) throw new SatelliteUnavailable("No satellite imagery key: set MAPTILER_API_KEY or GOOGLE_MAPS_API_KEY");
  if (!(await reserveCall("google_static", env.googleStaticMonthlyCap))) throw new SatelliteUnavailable("Monthly google satellite image cap reached");
  const res = await fetchImpl(googleImageUrl(lat, lng, env.satelliteZoom, env.googleKey), { signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403) throw new SatelliteUnavailable(`google rejected the key for satellite images (${res.status})`);
  if (res.status === 429) throw new SatelliteUnavailable("google rate limit reached");
  if (!res.ok) throw new Error(`google satellite image returned ${res.status}`);
  const mimeType = (res.headers.get("content-type") ?? "image/png").split(";")[0];
  if (!mimeType.startsWith("image/")) throw new Error(`google satellite image was not an image (${mimeType})`);
  return { data: Buffer.from(await res.arrayBuffer()), mimeType, source: "google" };
}

const SYSTEM =
  "You look at satellite images of rural and urban Tanzania to check that a health facility really exists at a mapped point. " +
  "A health facility is a building, or a few buildings in a compound, usually with a tin, tile or concrete roof, sometimes with a fence, a yard or a path to it. " +
  "Roads, trees, farmland, bare ground, water, and open fields are not buildings. Be honest when the image is too unclear to say.";

const PROMPT =
  "The mapped point is the exact centre of this image (the middle pixel). The image is about 150 metres across. " +
  "Is there a building or compound within about 30 metres of the centre? " +
  "Answer \"yes\" only if you can clearly see a roofed building (or buildings) there, \"no\" if the centre area is clearly empty land, trees, road or water, " +
  "and \"unclear\" if cloud, shadow, resolution or tree cover stops you being sure. Give one short sentence as the reason.";

const SCHEMA: GeminiSchema = {
  type: "OBJECT",
  properties: {
    building_near_centre: { type: "STRING", enum: ["yes", "no", "unclear"] },
    reason: { type: "STRING", description: "One short sentence." },
  },
  required: ["building_near_centre", "reason"],
};

/** Turn the model's answer into a status. Anything unexpected is "unclear", never a guess. Pure. */
export function parseVerdict(raw: unknown): { status: SatelliteStatus; note: string } {
  const o = (raw && typeof raw === "object" ? raw : {}) as { building_near_centre?: unknown; reason?: unknown };
  const answer = typeof o.building_near_centre === "string" ? o.building_near_centre.trim().toLowerCase() : "";
  const status: SatelliteStatus = answer === "yes" ? "building" : answer === "no" ? "none" : "unclear";
  const note = typeof o.reason === "string" ? o.reason.trim().slice(0, 300) : "";
  return { status, note };
}

/** Pauses before each retry when Gemini says it is overloaded (503): the busy spells are short. */
const OVERLOAD_RETRY_MS = [2_000, 6_000, 15_000];

/** Fetch the picture and ask Gemini about it. Throws SatelliteUnavailable when imagery or Gemini cannot be used right now. */
export async function checkSatellite(lat: number, lng: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<SatelliteVerdict> {
  const image = await fetchSatelliteImage(lat, lng);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const { data, model } = await geminiJson<unknown>({
          system: SYSTEM,
          prompt: PROMPT,
          schema: SCHEMA,
          images: [{ mimeType: image.mimeType, data: image.data.toString("base64") }],
          model: env.satelliteModel,
        });
        return { ...parseVerdict(data), source: image.source, model };
      } catch (e) {
        // Only an overloaded model (503) is worth waiting for; no credit, quota and key problems will not clear in seconds.
        if (e instanceof GeminiUnavailable && /returned 503/.test(e.message) && attempt < OVERLOAD_RETRY_MS.length) {
          await sleep(OVERLOAD_RETRY_MS[attempt]);
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    if (e instanceof GeminiUnavailable) throw new SatelliteUnavailable(e.message);
    if (e instanceof GeminiError && /GEMINI_API_KEY/.test(e.message)) throw new SatelliteUnavailable(e.message);
    throw e;
  }
}

/**
 * How a satellite verdict moves the grade. A building at the point lifts low to medium; medium to high only when the point is also in
 * its village and ward (the building could be any building, so it needs the other evidence too). "None" and "unclear" never lower it.
 */
export function satelliteLift(current: Confidence, status: SatelliteStatus | null | undefined, agree: { inVillage: boolean | null; inWard: boolean | null }): Confidence {
  if (status !== "building") return current;
  if (current === "low") return "medium";
  if (current === "medium" && agree.inVillage !== false && agree.inWard !== false && (agree.inVillage === true || agree.inWard === true)) return "high";
  return current;
}
