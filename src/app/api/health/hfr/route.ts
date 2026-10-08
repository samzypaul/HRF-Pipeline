import { NextResponse } from "next/server";
import { HfrClient } from "@/lib/hfr/client";
import { parseListPage } from "@/lib/hfr/parse";
import { errorMessage } from "@/lib/util";

export const dynamic = "force-dynamic";

/** Can this deployment reach the HFR portal? (Step 6 of the build guide.) */
export async function GET() {
  const started = Date.now();
  try {
    const client = new HfrClient({ retries: 0 });
    const page = parseListPage(await client.listPage({ page: 1 }));
    return NextResponse.json({
      ok: page.rows.length > 0,
      rows: page.rows.length,
      portalTotal: page.total,
      firstCode: page.rows[0]?.facilityCode ?? null,
      ms: Date.now() - started,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: errorMessage(e), ms: Date.now() - started }, { status: 502 });
  }
}
