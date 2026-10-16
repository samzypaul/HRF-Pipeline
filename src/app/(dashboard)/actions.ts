"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { q } from "@/lib/db/client";
import { PENDING_CORRECTION, readFilters, whereFor } from "@/lib/data";
import { createRun, retryFailed, type RunKind } from "@/lib/jobs/queue";
import { kickOrRunHere } from "@/lib/jobs/kick";
import { validateFacilities } from "@/lib/geo/validate";
import { matchWards, setManualWardLink } from "@/lib/geo/wards";
import { generateDailyReport } from "@/lib/ai/report";
import { generateWeeklyReport, weekOf } from "@/lib/ai/weekly";
import { GEO_LAYER_INFO, normalizeSettings, parseEmails, saveSettings } from "@/lib/settings";
import { approveWardSuggestion, rejectWardSuggestion, suggestWardLinks } from "@/lib/geo/ward-suggest";

const KINDS: RunKind[] = ["full", "pilot", "weekly", "validate", "improve", "report"];

export async function startRunAction(form: FormData) {
  const kind = String(form.get("kind")) as RunKind;
  if (!KINDS.includes(kind)) throw new Error("Unknown run kind");
  const params: Record<string, unknown> = {};
  const region = String(form.get("region") ?? "").trim();
  if (kind === "pilot" && !region) {
    redirect("/admin?notice=" + encodeURIComponent("A pilot covers one region: choose it, or pick \"Full load\" with \"All regions\" for the whole country."));
  }
  // Pilot and full loads can be limited to one region; "All regions" (empty) loads the whole country.
  if ((kind === "pilot" || kind === "full") && region) params.region = region;
  if (kind === "report") params.runId = Number(form.get("runId"));
  await createRun(kind, params);
  await kickOrRunHere(`start-${kind}`);
  revalidatePath("/admin");
}

/** One-click data-quality improvement (used from the Data quality page). */
export async function startImproveAction() {
  await createRun("improve");
  await kickOrRunHere("start-improve");
  revalidatePath("/admin");
  revalidatePath("/quality");
}

export async function resumeRunAction(form: FormData) {
  const id = Number(form.get("runId"));
  await q(sql`UPDATE job_runs SET status = 'running', error = NULL WHERE id = ${id} AND status IN ('paused', 'failed')`);
  await kickOrRunHere("resume");
  revalidatePath("/admin");
}

export async function retryFailedAction(form: FormData) {
  await retryFailed(Number(form.get("runId")));
  await kickOrRunHere("retry");
  revalidatePath("/admin");
}

export async function cancelRunAction(form: FormData) {
  const id = Number(form.get("runId"));
  await q(sql`UPDATE job_runs SET status = 'cancelled', finished_at = now() WHERE id = ${id} AND status IN ('running', 'paused')`);
  await q(sql`UPDATE job_tasks SET status = 'failed', last_error = 'cancelled' WHERE run_id = ${id} AND status IN ('pending', 'running')`);
  revalidatePath("/admin");
}

export async function kickAction() {
  await kickOrRunHere("manual");
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

/** Schedule, daily email and location-check layers from the Admin settings form. */
export async function saveSettingsAction(form: FormData) {
  const next = normalizeSettings({
    schedule: { cadence: String(form.get("cadence")), weekday: Number(form.get("weekday")) },
    dailyEmail: { enabled: form.get("dailyEmail") === "on" },
    geoProvider: String(form.get("geoProvider")),
    reports: { recipients: parseEmails(form.get("reportRecipients")) },
    approvals: { emailEnabled: form.get("approvalEmail") === "on", recipients: parseEmails(form.get("approvalRecipients")) },
    geoLayers: Object.fromEntries(GEO_LAYER_INFO.map((l) => [l.key, form.get(`layer_${l.key}`) === "on"])),
  });
  await saveSettings(next);
  revalidatePath("/admin");
}

/** Ask MapTiler for ward-link suggestions for the next batch of unlinked wards. */
export async function suggestWardLinksAction() {
  await suggestWardLinks(25);
  revalidatePath("/admin");
}

export async function approveWardSuggestionAction(form: FormData) {
  await approveWardSuggestion(String(form.get("wardCode")));
  revalidatePath("/admin");
}

export async function rejectWardSuggestionAction(form: FormData) {
  await rejectWardSuggestion(String(form.get("wardCode")));
  revalidatePath("/admin");
}

/** Rewrite one report: a daily one from its run, a weekly one from that week's daily reports. */
export async function regenerateReportAction(form: FormData) {
  const id = Number(form.get("reportId"));
  const [r] = await q<{ kind: string; run_id: number | null; period_start: string }>(sql`SELECT kind, run_id, period_start::text FROM reports WHERE id = ${id}`);
  if (!r) throw new Error("Report not found");
  if (r.kind === "weekly") await generateWeeklyReport(r.period_start);
  else if (r.run_id != null) await generateDailyReport(r.run_id);
  revalidatePath("/reports");
  revalidatePath(`/reports/${id}`);
}

/** Build the weekly report for the week containing the given date, from the daily reports already written. */
export async function generateWeekReportAction(form: FormData) {
  const date = String(form.get("date"));
  const notice = (msg: string) => redirect(`/reports?type=weekly&notice=${encodeURIComponent(msg)}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) notice("Pick a date first.");
  const { start, end } = weekOf(date);
  const [have] = await q<{ n: number }>(sql`SELECT count(*)::int n FROM reports WHERE kind = 'daily' AND period_start BETWEEN ${start} AND ${end}`);
  if (!have || have.n === 0) {
    notice(`There are no daily reports for ${start} to ${end} yet, so there is nothing to combine. Pick a week that has daily reports, or run the pipeline first.`);
  }
  let id: number | null = null;
  try {
    id = (await generateWeeklyReport(date)).id;
  } catch (e) {
    console.error("[reports] weekly report failed", e);
  }
  if (id == null) notice("The weekly report could not be built. Check the server log and try again.");
  revalidatePath("/reports");
  redirect(`/reports/${id}`);
}

/**
 * Apply one decision to many facilities: the ticked rows, or everything matching the current filters.
 * Only facilities without a decision are touched, and decisions are written straight to the grade
 * (same result as the single-row action, without re-running the lookups).
 *  accept_corrected – needs a corrected point awaiting approval
 *  accept_hfr       – needs an HFR point
 */
export async function bulkReviewAction(form: FormData) {
  const decision = String(form.get("decision"));
  if (decision !== "accept_corrected" && decision !== "accept_hfr") throw new Error("Choose what to apply");
  const reviewer = (await headers()).get("x-user-email") ?? "unknown";
  const filterParams = new URLSearchParams();
  for (const k of ["region", "council", "confidence", "type", "q", "issue"]) {
    const v = String(form.get(k) ?? "");
    if (v) filterParams.set(k, v);
  }
  // An empty issue filter means "Any"; keep it distinct from a bare visit (which defaults to needs_review).
  if (!filterParams.has("issue")) filterParams.set("issue", "");

  const allMatching = form.get("scope") === "all";
  let selection;
  if (allMatching) {
    if (form.get("confirmAll") !== "on") throw new Error("Tick the confirmation to apply this to every matching facility");
    const filters = readFilters(filterParams);
    selection = sql`f.facility_code IN (
      SELECT f.facility_code FROM facilities f LEFT JOIN geo_validation g ON g.facility_code = f.facility_code WHERE ${whereFor(filters)})`;
  } else {
    const codes = form.getAll("codes").map(String).filter(Boolean);
    if (codes.length === 0) throw new Error("Tick at least one facility");
    selection = sql`f.facility_code IN (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})`;
  }

  const note = `reviewer: ${decision}`;
  const [matched] = await q<{ n: number }>(sql`SELECT count(*)::int n FROM facilities f WHERE f.removed_at IS NULL AND ${selection}`);
  const applied =
    decision === "accept_corrected"
      ? await q(sql`
          WITH sel AS (
            SELECT f.facility_code, g.final_lat lat, g.final_lng lng FROM facilities f
            JOIN geo_validation g ON g.facility_code = f.facility_code
            WHERE ${selection} AND ${PENDING_CORRECTION}
          ), ins AS (
            INSERT INTO review_decisions (facility_code, decision, lat, lng, note, reviewer, decided_at)
            SELECT facility_code, ${decision}, lat, lng, 'bulk approval', ${reviewer}, now() FROM sel
            ON CONFLICT (facility_code) DO NOTHING
            RETURNING facility_code, lat, lng
          )
          UPDATE geo_validation g SET confidence = 'high', final_lat = ins.lat, final_lng = ins.lng,
            geocode_source = 'review', notes = ${note}, checked_at = now()
          FROM ins WHERE g.facility_code = ins.facility_code RETURNING g.facility_code`)
      : await q(sql`
          WITH sel AS (
            SELECT f.facility_code, f.hfr_lat lat, f.hfr_lng lng FROM facilities f
            WHERE f.removed_at IS NULL AND f.hfr_lat IS NOT NULL AND f.hfr_lng IS NOT NULL AND ${selection}
              AND NOT EXISTS (SELECT 1 FROM review_decisions rd WHERE rd.facility_code = f.facility_code)
          ), ins AS (
            INSERT INTO review_decisions (facility_code, decision, lat, lng, note, reviewer, decided_at)
            SELECT facility_code, ${decision}, lat, lng, 'bulk approval', ${reviewer}, now() FROM sel
            ON CONFLICT (facility_code) DO NOTHING
            RETURNING facility_code, lat, lng
          )
          UPDATE geo_validation g SET confidence = 'high', final_lat = ins.lat, final_lng = ins.lng,
            geocode_source = 'review', notes = ${note}, checked_at = now()
          FROM ins WHERE g.facility_code = ins.facility_code RETURNING g.facility_code`);

  revalidatePath("/quality");
  filterParams.set("done", String(applied.length));
  filterParams.set("skipped", String(Math.max(0, Number(matched?.n ?? 0) - applied.length)));
  redirect(`/quality?${filterParams.toString()}`);
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
