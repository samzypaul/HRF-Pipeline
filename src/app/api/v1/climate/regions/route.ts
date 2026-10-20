import { listRegions } from "@/lib/climate/api";
import { ATTRIBUTION, fail, guarded, ok, preflight } from "@/lib/climate/http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const OPTIONS = preflight;

/** GET /api/v1/climate/regions: the regions with climate-sensitive facilities; with ?region=CODE, that region's councils. */
export function GET(req: Request) {
  return guarded(req, async () => {
    const region = new URL(req.url).searchParams.get("region")?.trim().toUpperCase() || undefined;
    if (region && !/^TZ(\.[A-Z0-9]{1,4}){0,5}$/.test(region)) return fail(400, "bad_request", "region must be a portal region code such as TZ.CL.DO.");
    const data = await listRegions(region);
    return ok({ data, meta: { count: data.length, level: region ? "council" : "region", attribution: ATTRIBUTION } }, 1800);
  });
}
