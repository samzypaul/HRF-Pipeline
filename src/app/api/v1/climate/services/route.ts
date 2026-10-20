import { listServices, parseLang } from "@/lib/climate/api";
import { ATTRIBUTION, fail, guarded, ok, preflight } from "@/lib/climate/http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const OPTIONS = preflight;

/** GET /api/v1/climate/services: every climate-sensitive service, with the number of facilities that offer it. */
export function GET(req: Request) {
  return guarded(req, async () => {
    const lang = parseLang(new URL(req.url).searchParams);
    if (!lang.ok) return fail(400, "bad_request", lang.message);
    const data = await listServices(lang.value);
    // The catalogue changes rarely, so this can be cached for longer than the facility lists.
    return ok({ data, meta: { count: data.length, lang: lang.value, attribution: ATTRIBUTION } }, 1800);
  });
}
