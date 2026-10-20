import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { errorMessage } from "../util";
import { ratio } from "./name-match";
import { forwardSearch, isUnavailable, resolveProvider } from "./provider";
import { getSettings } from "../settings";
import { normAdmin, setManualWardLink } from "./wards";

export interface SuggestResult {
  checked: number;
  suggested: number;
  noResult: number;
  stoppedEarly: string | null;
}

/**
 * For HFR wards with no boundary link: geocode "ward, council, region" with the chosen provider, find the ward polygon that contains
 * the point, and store it as a pending suggestion. Nothing is linked until someone approves it on the Admin page.
 * Wards already suggested or rejected are skipped.
 */
export async function suggestWardLinks(limit = 25): Promise<SuggestResult> {
  const result: SuggestResult = { checked: 0, suggested: 0, noResult: 0, stoppedEarly: null };
  const provider = resolveProvider((await getSettings()).geoProvider);
  if (!provider) {
    result.stoppedEarly = "No geocoder key available for the chosen provider (MAPTILER_API_KEY, GOOGLE_MAPS_API_KEY or ARCGIS_API_KEY)";
    return result;
  }
  const wards = await q<{ code: string; ward: string; council: string | null; region: string | null }>(sql`
    SELECT w.code, w.name ward, c.name council, r.name region
    FROM admin_units w
    LEFT JOIN admin_units c ON c.code = w.parent_code
    LEFT JOIN admin_units d ON d.code = c.parent_code
    LEFT JOIN admin_units r ON r.code = d.parent_code
    WHERE w.level = 4
      AND NOT EXISTS (SELECT 1 FROM ward_crosswalk x WHERE x.ward_code = w.code)
      AND NOT EXISTS (SELECT 1 FROM ward_suggestions s WHERE s.ward_code = w.code)
    ORDER BY w.code LIMIT ${limit}`);

  for (const w of wards) {
    result.checked++;
    const query = [w.ward, w.council, w.region, "Tanzania"].filter(Boolean).join(", ");
    try {
      let found: { id: number; lat: number; lng: number } | null = null;
      for (const p of await forwardSearch(provider, query)) {
        const [b] = await q<{ id: number; name: string; district_name: string | null }>(sql`
          SELECT id, name, district_name FROM ward_boundaries
          WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)) LIMIT 1`);
        // The polygon must carry the same ward name, otherwise a nearby unrelated ward would be suggested.
        if (b && ratio(normAdmin(w.ward), normAdmin(b.name)) >= 70) {
          found = { id: b.id, lat: p.lat, lng: p.lng };
          break;
        }
      }
      if (found) {
        await q(sql`
          INSERT INTO ward_suggestions (ward_code, boundary_id, lat, lng, query)
          VALUES (${w.code}, ${found.id}, ${found.lat}, ${found.lng}, ${query})
          ON CONFLICT (ward_code) DO NOTHING`);
        result.suggested++;
      } else {
        // Remember the miss so the same ward is not searched again on every click.
        await q(sql`
          INSERT INTO ward_suggestions (ward_code, query, status) VALUES (${w.code}, ${query}, 'no_result')
          ON CONFLICT (ward_code) DO NOTHING`);
        result.noResult++;
      }
    } catch (e) {
      if (isUnavailable(e)) {
        result.stoppedEarly = errorMessage(e);
        break;
      }
      console.warn(`[ward-suggest] ${w.code}: ${errorMessage(e)}`);
    }
  }
  return result;
}

export async function approveWardSuggestion(wardCode: string): Promise<void> {
  const [s] = await q<{ boundary_id: number }>(sql`SELECT boundary_id FROM ward_suggestions WHERE ward_code = ${wardCode} AND status = 'pending'`);
  if (!s?.boundary_id) throw new Error("No pending suggestion for this ward");
  await setManualWardLink(wardCode, s.boundary_id);
  await q(sql`UPDATE ward_suggestions SET status = 'approved' WHERE ward_code = ${wardCode}`);
}

export async function rejectWardSuggestion(wardCode: string): Promise<void> {
  await q(sql`UPDATE ward_suggestions SET status = 'rejected' WHERE ward_code = ${wardCode}`);
}
