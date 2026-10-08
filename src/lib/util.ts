import { createHash } from "node:crypto";

/** Collapse whitespace and trim; empty → null. */
export function clean(s: string | null | undefined): string | null {
  if (s == null) return null;
  const v = s.replace(/\s+/g, " ").trim();
  return v === "" ? null : v;
}

/** Stable JSON (sorted keys) so equal objects hash the same. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export function hashOf(value: unknown): string {
  return createHash("sha1").update(stableStringify(value)).digest("hex");
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

/** Great-circle distance in metres. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
