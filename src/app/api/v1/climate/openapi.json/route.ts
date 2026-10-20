import { openApiSpec } from "@/lib/climate/openapi";
import { ok, preflight } from "@/lib/climate/http";

export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/** GET /api/v1/climate/openapi.json: the machine-readable description of this API. */
export function GET(req: Request) {
  return ok(openApiSpec(new URL(req.url).origin), 3600);
}
