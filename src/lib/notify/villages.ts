import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { env } from "../env";
import { getSettings } from "../settings";
import { sendMail } from "./email";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const LIST_LIMIT = 50;

/** Points the village rule produced whose current location has not been emailed yet (aliases f and g). */
const NOT_YET_EMAILED = sql`(g.village_emailed_lat IS DISTINCT FROM g.final_lat OR g.village_emailed_lng IS DISTINCT FROM g.final_lng)`;
const VILLAGE_FIX = sql`(f.removed_at IS NULL AND 'village_fix' = ANY(g.sanity_flags) AND g.final_lat IS NOT NULL)`;

interface Row {
  facility_code: string;
  name: string;
  village_name: string | null;
  ward_name: string | null;
  council_name: string | null;
  geocode_source: string | null;
}

export interface VillageEmailResult {
  sent: boolean;
  fresh: number;
  reason?: string;
}

/**
 * Tell management which facilities the village rule placed inside their HFR village (by a geocoder, or at the centre of the
 * village polygon when there was no point and geocoding failed), and how many are still outside their village. Each placed
 * point is emailed once; a facility is mentioned again only if its point changes. Uses the approval-email settings.
 */
export async function notifyVillagePlacements(): Promise<VillageEmailResult> {
  const settings = await getSettings();
  if (!settings.approvals.emailEnabled) return { sent: false, fresh: 0, reason: "approval emails are switched off" };
  const to = settings.approvals.recipients.length ? settings.approvals.recipients : env.reportRecipients;
  if (!env.resendKey || to.length === 0) return { sent: false, fresh: 0, reason: "email is not configured or has no recipients" };

  const [counts] = await q<{ fresh: number; centre: number; geocoded: number; outside: number }>(sql`
    SELECT count(*) FILTER (WHERE ${VILLAGE_FIX} AND ${NOT_YET_EMAILED})::int fresh,
           count(*) FILTER (WHERE ${VILLAGE_FIX} AND ${NOT_YET_EMAILED} AND g.geocode_source = 'village_centroid')::int centre,
           count(*) FILTER (WHERE ${VILLAGE_FIX} AND ${NOT_YET_EMAILED} AND g.geocode_source <> 'village_centroid')::int geocoded,
           count(*) FILTER (WHERE f.removed_at IS NULL AND 'outside_village' = ANY(g.sanity_flags))::int outside
    FROM facilities f JOIN geo_validation g ON g.facility_code = f.facility_code`);
  const fresh = Number(counts?.fresh ?? 0);
  if (fresh === 0) return { sent: false, fresh: 0, reason: "no new village placements" };

  const rows = await q<Row>(sql`
    SELECT f.facility_code, f.name, f.village_name, f.ward_name, f.council_name, g.geocode_source
    FROM facilities f JOIN geo_validation g ON g.facility_code = f.facility_code
    WHERE ${VILLAGE_FIX} AND ${NOT_YET_EMAILED}
    ORDER BY f.region_name NULLS LAST, f.council_name NULLS LAST, f.name
    LIMIT ${LIST_LIMIT}`);

  const n = (x: number) => Number(x).toLocaleString("en-US");
  const base = env.appUrl;
  const link = (issue: string, text: string) =>
    base ? `<a href="${base}/quality?issue=${issue}" style="background:#0f766e;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">${text}</a>` : "";
  const line = (r: Row) => `<tr>
      <td style="padding:4px 8px"><b>${escapeHtml(r.name)}</b><br><span style="color:#666">${escapeHtml(r.facility_code)}</span></td>
      <td style="padding:4px 8px">${escapeHtml(r.village_name ?? "—")}<br><span style="color:#666">${escapeHtml(r.ward_name ?? "no ward")} · ${escapeHtml(r.council_name ?? "—")}</span></td>
      <td style="padding:4px 8px">${r.geocode_source === "village_centroid" ? "Village centre" : escapeHtml(r.geocode_source ?? "—")}</td>
    </tr>`;
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:680px">
      <h2 style="margin:0 0 12px">${n(fresh)} health facilit${fresh === 1 ? "y was" : "ies were"} placed inside ${fresh === 1 ? "its" : "their"} village</h2>
      <p>Every facility should sit inside the village named in the HFR. For these the pipeline now has a location inside that village:
      ${n(Number(counts.geocoded))} from a geocoder or name match, and ${n(Number(counts.centre))} at the centre of the village
      (no coordinates and geocoding found nothing inside the village).
      ${Number(counts.outside) > 0 ? `${n(Number(counts.outside))} facilities are still outside their village and are flagged for review.` : ""}</p>
      <p>${link("village_fix", "Review the placed facilities")} ${link("outside_village", "See those still outside")}</p>
      <table style="border-collapse:collapse;font-size:14px" cellspacing="0">
        <tr style="text-align:left;color:#666"><th style="padding:4px 8px">Facility</th><th style="padding:4px 8px">Village / ward / council</th><th style="padding:4px 8px">Placed by</th></tr>
        ${rows.map(line).join("")}
      </table>
      ${fresh > rows.length ? `<p style="color:#666">…and ${n(fresh - rows.length)} more in the dashboard.</p>` : ""}
      <p style="color:#666;font-size:13px">The HFR coordinates are never changed; the corrected point is stored beside them.</p>
    </div>`;

  const sent = await sendMail(to, `${n(fresh)} health facilit${fresh === 1 ? "y" : "ies"} placed inside their village`, html);
  if (sent) {
    await q(sql`
      UPDATE geo_validation g SET village_emailed_at = now(), village_emailed_lat = g.final_lat, village_emailed_lng = g.final_lng
      FROM facilities f WHERE f.facility_code = g.facility_code AND ${VILLAGE_FIX} AND ${NOT_YET_EMAILED}`);
  }
  return { sent, fresh };
}
