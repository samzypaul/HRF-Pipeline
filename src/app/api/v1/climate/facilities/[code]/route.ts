import { getFacility, parseLang } from "@/lib/climate/api";
import { ATTRIBUTION, fail, guarded, ok, preflight } from "@/lib/climate/http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const OPTIONS = preflight;

/** GET /api/v1/climate/facilities/{code}: one facility with its climate-sensitive services. */
export function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  return guarded(req, async () => {
    const { code } = await ctx.params;
    if (!/^[0-9A-Za-z-]{3,20}$/.test(code)) return fail(400, "bad_request", "That is not a facility code.");
    const lang = parseLang(new URL(req.url).searchParams);
    if (!lang.ok) return fail(400, "bad_request", lang.message);
    const facility = await getFacility(code, lang.value);
    if (!facility) return fail(404, "not_found", "No climate-sensitive facility with that code.");
    return ok({ data: facility, meta: { lang: lang.value, attribution: ATTRIBUTION } });
  });
}
