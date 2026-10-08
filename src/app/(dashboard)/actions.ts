"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { q } from "@/lib/db/client";
import { createRun, retryFailed, type RunKind } from "@/lib/jobs/queue";
import { kickTick } from "@/lib/jobs/kick";
import { validateFacilities } from "@/lib/geo/validate";
import { matchWards, setManualWardLink } from "@/lib/geo/wards";
import { generateWeeklyReport } from "@/lib/ai/report";

const KINDS: RunKind[] = ["full", "pilot", "weekly", "validate", "report"];

export async function startRunAction(form: FormData) {
  const kind = String(form.get("kind")) as RunKind;
  if (!KINDS.includes(kind)) throw new Error("Unknown run kind");
  const params: Record<string, unknown> = {};
  const region = String(form.get("region") ?? "").trim();
  if (kind === "pilot") {
    if (!region) throw new Error("Choose a region for the pilot run");
    params.region = region;
  }
  if (kind === "report") params.runId = Number(form.get("runId"));
  await createRun(kind, params);
  await kickTick(`start-${kind}`);
  revalidatePath("/admin");
}

export async function resumeRunAction(form: FormData) {
  const id = Number(form.get("runId"));
  await q(sql`UPDATE job_runs SET status = 'running', error = NULL WHERE id = ${id} AND status IN ('paused', 'failed')`);
  await kickTick("resume");
  revalidatePath("/admin");
}

export async function retryFailedAction(form: FormData) {
  await retryFailed(Number(form.get("runId")));
  await kickTick("retry");
  revalidatePath("/admin");
}

export async function cancelRunAction(form: FormData) {
  const id = Number(form.get("runId"));
  await q(sql`UPDATE job_runs SET status = 'cancelled', finished_at = now() WHERE id = ${id} AND status IN ('running', 'paused')`);
  await q(sql`UPDATE job_tasks SET status = 'failed', last_error = 'cancelled' WHERE run_id = ${id} AND status IN ('pending', 'running')`);
  revalidatePath("/admin");
}

export async function kickAction() {
  await kickTick("manual");
  revalidatePath("/admin");
}

export async function matchWardsAction() {
  await matchWards();
  revalidatePath("/admin");
}

export async function manualWardLinkAction(form: FormData) {
  const ward = String(form.get("wardCode") ?? "").trim();
  const boundary = Number(form.get("boundaryId"));
  if (!ward || !Number.isFinite(boundary)) throw new Error("Ward code and boundary id are required");
  await setManualWardLink(ward, boundary);
  revalidatePath("/admin");
}

export async function regenerateReportAction(form: FormData) {
  await generateWeeklyReport(Number(form.get("runId")));
  revalidatePath("/reports");
}

/** Reviewer decision on a facility's location. Never overwritten by automatic runs. */
export async function reviewAction(form: FormData) {
  const code = String(form.get("code"));
  const decision = String(form.get("decision"));
  const reviewer = (await headers()).get("x-user-email") ?? "unknown";
  const note = String(form.get("note") ?? "").trim() || null;

  if (decision === "clear") {
    await q(sql`DELETE FROM review_decisions WHERE facility_code = ${code}`);
  } else {
    let lat: number | null = null;
    let lng: number | null = null;
    if (decision === "accept_hfr") {
      const [f] = await q<{ hfr_lat: number | null; hfr_lng: number | null }>(sql`SELECT hfr_lat, hfr_lng FROM facilities WHERE facility_code = ${code}`);
      lat = f?.hfr_lat ?? null;
      lng = f?.hfr_lng ?? null;
    } else if (decision === "accept_corrected") {
      const [g] = await q<{ final_lat: number | null; final_lng: number | null }>(sql`SELECT final_lat, final_lng FROM geo_validation WHERE facility_code = ${code}`);
      lat = g?.final_lat ?? null;
      lng = g?.final_lng ?? null;
    } else if (decision === "manual") {
      lat = Number(form.get("lat"));
      lng = Number(form.get("lng"));
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat > -0.9 || lat < -11.8 || lng < 29.2 || lng > 40.6) {
        throw new Error("Enter a latitude/longitude inside Tanzania");
      }
    } else {
      throw new Error("Unknown decision");
    }
    if (lat == null || lng == null) throw new Error("No point available for this decision");
    await q(sql`
      INSERT INTO review_decisions (facility_code, decision, lat, lng, note, reviewer, decided_at)
      VALUES (${code}, ${decision}, ${lat}, ${lng}, ${note}, ${reviewer}, now())
      ON CONFLICT (facility_code) DO UPDATE SET decision = EXCLUDED.decision, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
        note = EXCLUDED.note, reviewer = EXCLUDED.reviewer, decided_at = now()`);
  }
  await validateFacilities([code]);
  revalidatePath("/quality");
  revalidatePath(`/facility/${code}`);
}
