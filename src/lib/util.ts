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

/**
 * Run `fn` over `items` with at most `limit` in flight. Stops starting new items after the first failure,
 * waits for the ones already running, then throws that first failure.
 */
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
}

/** A counting semaphore: `limiter(fn)` runs `fn` once fewer than `limit` calls are in flight. */
export function createLimiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

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
