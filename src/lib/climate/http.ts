/** Shared plumbing for the public climate API: JSON responses, CORS, caching and a best-effort rate limit. */

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const BASE_HEADERS: Record<string, string> = { ...CORS, "X-Content-Type-Options": "nosniff" };

/** A successful JSON response. Cached by the CDN for `maxAge` seconds, so a busy app mostly never reaches the database. */
export function ok(body: unknown, maxAge = 300): Response {
  return Response.json(body, {
    headers: { ...BASE_HEADERS, "Cache-Control": `public, s-maxage=${maxAge}, max-age=${Math.min(maxAge, 60)}, stale-while-revalidate=${maxAge * 12}` },
  });
}

/** A JSON error in one fixed shape, never cached and never carrying internal detail. */
export function fail(status: number, code: string, message: string, extra: Record<string, string> = {}): Response {
  return Response.json({ error: { code, message } }, { status, headers: { ...BASE_HEADERS, "Cache-Control": "no-store", ...extra } });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip") || "unknown";
}

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

/**
 * Fixed-window limit per address. It lives in the memory of one server instance, so it is a guard against a runaway client,
 * not a hard quota; the CDN cache absorbs most repeat traffic before it gets here.
 */
export function rateLimit(ip: string, now = Date.now(), limit = 120, windowMs = 60_000): { ok: boolean; retryAfter: number } {
  if (buckets.size > 5000) for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  const b = buckets.get(ip);
  if (!b || b.resetAt <= now) {
    buckets.set(ip, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  b.count++;
  return b.count <= limit ? { ok: true, retryAfter: 0 } : { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
}

/** Run a handler behind the rate limit; any unexpected error becomes a plain 500 (details go to the server log only). */
export async function guarded(req: Request, handler: () => Promise<Response>): Promise<Response> {
  const limited = rateLimit(clientIp(req));
  if (!limited.ok) return fail(429, "rate_limited", "Too many requests. Please slow down.", { "Retry-After": String(limited.retryAfter) });
  try {
    return await handler();
  } catch (e) {
    console.error("[climate api]", e);
    return fail(500, "server_error", "Something went wrong. Please try again.");
  }
}

export const ATTRIBUTION =
  "Source: Tanzania Health Facility Registry (HFR), processed by the HFR Pipeline. Locations are checked but can be approximate; call the facility before travelling.";
