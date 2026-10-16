import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { env } from "../env";
import { haversineM } from "../util";
import { PENDING_CORRECTION } from "../data";
import { getSettings } from "../settings";
import { sendMail } from "./email";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const LIST_LIMIT = 50;

/** Pending corrections whose current corrected point has not been emailed yet. */
const NOT_YET_EMAILED = sql`(g.approval_emailed_lat IS DISTINCT FROM g.final_lat OR g.approval_emailed_lng IS DISTINCT FROM g.final_lng)`;

interface Row {
  facility_code: string;
  name: string;
  council_name: string | null;
  ward_name: string | null;
  hfr_lat: number | null;
  hfr_lng: number | null;
  final_lat: number;
  final_lng: number;
  geocode_source: string | null;
  confidence: string | null;
}

export interface ApprovalEmailResult {
  sent: boolean;
  pending: number;
  reason?: string;
}

/**
 * Email the people who approve corrections when a run has produced new corrected points. Each corrected point is
 * emailed once; a facility is mentioned again only if its corrected point changes. Sending is skipped (and nothing is
 * marked as emailed) when email is off, unconfigured, or there is nobody to send to.
 */
export async function notifyPendingCorrections(): Promise<ApprovalEmailResult> {
  const settings = await getSettings();
  if (!settings.approvals.emailEnabled) return { sent: false, pending: 0, reason: "approval emails are switched off" };
  const to = settings.approvals.recipients.length ? settings.approvals.recipients : env.reportRecipients;
  if (!env.resendKey || to.length === 0) return { sent: false, pending: 0, reason: "email is not configured or has no recipients" };

  const [count] = await q<{ n: number }>(sql`
    SELECT count(*)::int n FROM facilities f JOIN geo_validation g ON g.facility_code = f.facility_code
    WHERE ${PENDING_CORRECTION} AND ${NOT_YET_EMAILED}`);
  const fresh = Number(count?.n ?? 0);
  if (fresh === 0) return { sent: false, pending: 0, reason: "nothing new to approve" };

  const rows = await q<Row>(sql`
    SELECT f.facility_code, f.name, f.council_name, f.ward_name, f.hfr_lat, f.hfr_lng,
           g.final_lat, g.final_lng, g.geocode_source, g.confidence
    FROM facilities f JOIN geo_validation g ON g.facility_code = f.facility_code
    WHERE ${PENDING_CORRECTION} AND ${NOT_YET_EMAILED}
    ORDER BY f.region_name NULLS LAST, f.council_name NULLS LAST, f.name
    LIMIT ${LIST_LIMIT}`);
  const [all] = await q<{ n: number }>(sql`
    SELECT count(*)::int n FROM facilities f JOIN geo_validation g ON g.facility_code = f.facility_code WHERE ${PENDING_CORRECTION}`);

  const link = env.appUrl ? `${env.appUrl}/quality?issue=pending_approval` : null;
  const line = (r: Row) => {
    const moved = r.hfr_lat != null && r.hfr_lng != null ? `${Math.round(haversineM(r.hfr_lat, r.hfr_lng, r.final_lat, r.final_lng)).toLocaleString("en-US")} m` : "no HFR point";
    return `<tr>
      <td style="padding:4px 8px"><b>${escapeHtml(r.name)}</b><br><span style="color:#666">${escapeHtml(r.facility_code)}</span></td>
      <td style="padding:4px 8px">${escapeHtml(r.council_name ?? "—")}<br><span style="color:#666">${escapeHtml(r.ward_name ?? "no ward")}</span></td>
      <td style="padding:4px 8px">${escapeHtml(r.geocode_source ?? "—")}<br><span style="color:#666">${moved} · ${escapeHtml(r.confidence ?? "—")}</span></td>
    </tr>`;
  };
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:680px">
      <h2 style="margin:0 0 12px">${fresh.toLocaleString("en-US")} corrected location${fresh === 1 ? "" : "s"} need your approval</h2>
      <p>The pipeline found better coordinates for these health facilities. Nothing changes until someone approves them.
      ${all?.n && Number(all.n) > fresh ? `In total ${Number(all.n).toLocaleString("en-US")} are waiting.` : ""}</p>
      ${link ? `<p><a href="${link}" style="background:#0f766e;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Review and approve</a></p>` : ""}
      <table style="border-collapse:collapse;font-size:14px" cellspacing="0">
        <tr style="text-align:left;color:#666"><th style="padding:4px 8px">Facility</th><th style="padding:4px 8px">Council / ward</th><th style="padding:4px 8px">Corrected by</th></tr>
        ${rows.map(line).join("")}
      </table>
      ${fresh > rows.length ? `<p style="color:#666">…and ${(fresh - rows.length).toLocaleString("en-US")} more in the dashboard.</p>` : ""}
      <p style="color:#666;font-size:13px">In the dashboard you can approve many at once with the checkboxes, or every facility matching a filter.</p>
    </div>`;

  const sent = await sendMail(to, `${fresh.toLocaleString("en-US")} corrected health-facility location${fresh === 1 ? "" : "s"} need approval`, html);
  if (sent) {
    await q(sql`
      UPDATE geo_validation g SET approval_emailed_at = now(), approval_emailed_lat = g.final_lat, approval_emailed_lng = g.final_lng
      FROM facilities f WHERE f.facility_code = g.facility_code AND ${PENDING_CORRECTION} AND ${NOT_YET_EMAILED}`);
  }
  return { sent, pending: fresh };
}
