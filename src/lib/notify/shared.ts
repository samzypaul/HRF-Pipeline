import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { env } from "../env";
import { pointKey } from "../geo/shared";
import { getSettings } from "../settings";
import { sendMail } from "./email";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const GROUP_LIMIT = 30;

/** Stand-in centres are shared by design (every facility with no point in a village gets its centre), so they never trigger an email. */
const STAND_IN = sql`coalesce(g.geocode_source, '') IN ('village_centroid', 'ward_centroid', 'council_centroid')`;
/** Shared points the team has not been told about yet (aliases f and g). */
const FRESH = sql`(f.removed_at IS NULL AND g.final_lat IS NOT NULL AND g.shared_count > 0 AND NOT ${STAND_IN}
  AND g.shared_with IS DISTINCT FROM g.shared_emailed_with)`;

interface Row {
  facility_code: string;
  name: string;
  council_name: string | null;
  ward_name: string | null;
  lat: number;
  lng: number;
  geocode_source: string | null;
}

export interface SharedEmailResult {
  sent: boolean;
  groups: number;
  facilities: number;
  reason?: string;
}

export interface SharedGroup {
  key: string;
  lat: number;
  lng: number;
  members: Row[];
}

/** Put the facilities that share a point together, biggest groups first. */
export function groupRows(rows: Row[]): SharedGroup[] {
  const map = new Map<string, SharedGroup>();
  for (const r of rows) {
    const key = pointKey(r.lat, r.lng);
    const g = map.get(key) ?? { key, lat: r.lat, lng: r.lng, members: [] };
    g.members.push(r);
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key));
}

/**
 * Tell the team which facilities sit on exactly the same point. Each shared point is emailed once; a facility is mentioned again only
 * if the facilities it shares with change. Stand-in centres are left out of the email (they are shared on purpose) but still show in the
 * data tables. Uses the approval-email settings, like the other data-quality emails.
 */
export async function notifySharedLocations(): Promise<SharedEmailResult> {
  const settings = await getSettings();
  if (!settings.approvals.emailEnabled) return { sent: false, groups: 0, facilities: 0, reason: "approval emails are switched off" };
  const to = settings.approvals.recipients.length ? settings.approvals.recipients : env.reportRecipients;
  if (!env.resendKey || to.length === 0) return { sent: false, groups: 0, facilities: 0, reason: "email is not configured or has no recipients" };

  const rows = await q<Row>(sql`
    SELECT f.facility_code, f.name, f.council_name, f.ward_name, g.final_lat AS lat, g.final_lng AS lng, g.geocode_source
    FROM facilities f JOIN geo_validation g ON g.facility_code = f.facility_code
    WHERE ${FRESH}
    ORDER BY f.name, f.facility_code`);
  if (rows.length === 0) return { sent: false, groups: 0, facilities: 0, reason: "no new shared points" };
  const groups = groupRows(rows);

  const [standIn] = await q<{ n: number }>(sql`
    SELECT count(*)::int n FROM facilities f JOIN geo_validation g ON g.facility_code = f.facility_code
    WHERE f.removed_at IS NULL AND g.shared_count > 0 AND ${STAND_IN}`);

  const n = (x: number) => Number(x).toLocaleString("en-US");
  const base = env.publicUrl;
  const button = base
    ? `<a href="${base}/quality?issue=shared_location" style="background:#0f766e;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Review the shared points</a>`
    : "";
  const shown = groups.slice(0, GROUP_LIMIT);
  const line = (g: SharedGroup) => `<tr style="vertical-align:top">
      <td style="padding:6px 8px;white-space:nowrap">${g.lat.toFixed(6)}, ${g.lng.toFixed(6)}<br><span style="color:#666">${n(g.members.length)} facilities</span></td>
      <td style="padding:6px 8px">${g.members
        .map((m) => `<b>${escapeHtml(m.name)}</b> <span style="color:#666">${escapeHtml(m.facility_code)} · ${escapeHtml(m.council_name ?? "—")}</span>`)
        .join("<br>")}</td>
      <td style="padding:6px 8px">${escapeHtml([...new Set(g.members.map((m) => m.geocode_source ?? "hfr"))].join(", "))}</td>
    </tr>`;
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:720px">
      <h2 style="margin:0 0 12px">${n(rows.length)} health facilities share a location with another facility</h2>
      <p>${n(groups.length)} point${groups.length === 1 ? " is" : "s are"} each used by two or more facilities. Two facilities cannot stand on exactly the
      same spot, so at least one of each group is probably wrong: a coordinate copied in the portal, or a geocoder that returned one place for two names.
      ${Number(standIn?.n ?? 0) > 0 ? `${n(Number(standIn.n))} more share a village centre on purpose (no coordinates were available) and are not listed.` : ""}</p>
      <p>${button}</p>
      <table style="border-collapse:collapse;font-size:14px" cellspacing="0">
        <tr style="text-align:left;color:#666"><th style="padding:4px 8px">Point</th><th style="padding:4px 8px">Facilities on it</th><th style="padding:4px 8px">Placed by</th></tr>
        ${shown.map(line).join("")}
      </table>
      ${groups.length > shown.length ? `<p style="color:#666">…and ${n(groups.length - shown.length)} more points in the dashboard.</p>` : ""}
      <p style="color:#666;font-size:13px">The HFR coordinates are never changed. In the data tables, <i>location_sharing</i> says whether a facility shares its point and <i>shares_location_with</i> names the others.</p>
    </div>`;

  const sent = await sendMail(to, `${n(rows.length)} health facilities share a location with another facility`, html);
  if (sent) {
    await q(sql`UPDATE geo_validation g SET shared_emailed_with = g.shared_with FROM facilities f WHERE f.facility_code = g.facility_code AND ${FRESH}`);
  }
  return { sent, groups: groups.length, facilities: rows.length };
}
