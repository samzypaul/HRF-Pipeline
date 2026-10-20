import { parseFacilityQuery, searchFacilities } from "@/lib/climate/api";
import { ATTRIBUTION, fail, guarded, ok, preflight } from "@/lib/climate/http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const OPTIONS = preflight;

/** GET /api/v1/climate/facilities: search the climate-sensitive facilities (public, read-only). */
export function GET(req: Request) {
  return guarded(req, async () => {
    const parsed = parseFacilityQuery(new URL(req.url).searchParams);
    if (!parsed.ok) return fail(400, "bad_request", parsed.message);
    const { total, data } = await searchFacilities(parsed.value);
    const { limit, offset, lang } = parsed.value;
    return ok({ data, meta: { total, limit, offset, count: data.length, lang, attribution: ATTRIBUTION } });
  });
}
