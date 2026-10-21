import { SatelliteUnavailable, fetchSatelliteImage } from "@/lib/geo/satellite";

export const dynamic = "force-dynamic";

/**
 * GET /api/satellite?lat=..&lng=..: the satellite picture around a point, for the facility page (signed-in users only: the middleware
 * guards every /api route that is not listed as public). The picture is fetched here so the imagery key never reaches the browser.
 */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const lat = Number(sp.get("lat"));
  const lng = Number(sp.get("lng"));
  // Tanzania's bounding box, so the route cannot be used to fetch pictures of anywhere else.
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -12.5 || lat > -0.9 || lng < 28.9 || lng > 41.2) {
    return Response.json({ error: "lat and lng must be a point in Tanzania" }, { status: 400 });
  }
  try {
    const img = await fetchSatelliteImage(lat, lng);
    return new Response(new Uint8Array(img.data), { headers: { "Content-Type": img.mimeType, "Cache-Control": "private, max-age=86400" } });
  } catch (e) {
    if (e instanceof SatelliteUnavailable) return Response.json({ error: e.message }, { status: 503 });
    console.error("[satellite]", e);
    return Response.json({ error: "Could not load the satellite picture" }, { status: 502 });
  }
}
