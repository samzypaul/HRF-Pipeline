import { ATTRIBUTION, ok, preflight } from "@/lib/climate/http";

export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/** GET /api/v1/climate: where to start. */
export function GET(req: Request) {
  const base = `${new URL(req.url).origin}/api/v1/climate`;
  return ok(
    {
      name: "HFR climate-sensitive health facilities API",
      version: "1.0.0",
      description: "Open, read-only data for the El Niño health facility app. Names are in English (lang=en) or Kiswahili (lang=sw).",
      endpoints: {
        facilities: `${base}/facilities`,
        facility: `${base}/facilities/{code}`,
        services: `${base}/services`,
        regions: `${base}/regions`,
        openapi: `${base}/openapi.json`,
      },
      examples: [
        `${base}/facilities?lat=-6.8&lng=39.28&radius_km=10&service=MAL-MRDT&lang=sw`,
        `${base}/facilities?tier=1&region=TZ.CL.DO&limit=20`,
      ],
      attribution: ATTRIBUTION,
    },
    3600,
  );
}
