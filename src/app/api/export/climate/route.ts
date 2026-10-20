import { sql } from "drizzle-orm";
import { q } from "@/lib/db/client";
import { readFilters, whereFor, type Filters } from "@/lib/data";
import { CATEGORIES, SERVICES, TIERS, UNMATCHED } from "@/lib/climate/catalogue";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The climate-sensitive facility dataset for the El Niño app, as five CSV sheets (UTF-8, one header row, snake_case):
 *   facilities, facility_services, service_lookup, exclusions, data_quality
 * Filters: the usual export filters, plus `climate` (which services count), `operating` and `located` (both on unless "0").
 * Facilities are never changed; every row traces back to the registry by facility_code and service code.
 */

type Row = Record<string, unknown>;
type Sheet = { columns: string[]; rows: Row[] };

const csvCell = (v: unknown) => {
  if (v == null) return "";
  const s = Array.isArray(v) ? v.join("|") : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const toCsv = ({ columns, rows }: Sheet) => "﻿" + columns.join(",") + "\n" + rows.map((r) => columns.map((c) => csvCell(r[c])).join(",")).join("\n") + (rows.length ? "\n" : "");

/** Which climate-sensitive services the export is about: the chosen ones, else all of them. */
function chosenServices(climate: string | undefined): { codes: string[]; label: string } {
  const all = SERVICES.map((s) => s.code);
  if (climate?.startsWith("svc:")) {
    const codes = climate.slice(4).split(",").filter((c) => all.includes(c));
    if (codes.length) return { codes, label: `services ${codes.join(", ")}` };
  }
  if (climate?.startsWith("tier:")) {
    const tiers = climate.slice(5).split(",").map(Number);
    const codes = SERVICES.filter((s) => tiers.includes(s.tier)).map((s) => s.code);
    if (codes.length) return { codes, label: `tier ${tiers.join(", ")}` };
  }
  return { codes: all, label: "all climate-sensitive services" };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sheet = url.searchParams.get("sheet") ?? "facilities";
  // A checkbox posts "1" when ticked and a hidden "0" always; with neither parameter (a plain link) the check is on.
  const flag = (name: string) => {
    const v = url.searchParams.getAll(name);
    return v.length === 0 || v.includes("1");
  };
  const operatingOnly = flag("operating");
  const locatedOnly = flag("located");
  // The "climate" filter is handled here (it also narrows the services listed), so it is not passed on to whereFor.
  const base: Filters = { ...readFilters(url.searchParams), climate: undefined };
  const { codes, label } = chosenServices(readFilters(url.searchParams).climate);
  const where = whereFor(base);
  const codeList = sql.param(codes);
  const operating = sql`f.operating_status ILIKE 'operating'`;
  const located = sql`coalesce(g.final_lat, f.hfr_lat) IS NOT NULL`;
  const hasService = sql`EXISTS (SELECT 1 FROM facility_climate_services cs WHERE cs.facility_code = f.facility_code AND cs.service_code = ANY(${codeList}::text[]))`;
  const included = sql`${hasService} AND ${operatingOnly ? operating : sql`true`} AND ${locatedOnly ? located : sql`true`}`;
  const from = sql`FROM facilities f LEFT JOIN geo_validation g ON g.facility_code = f.facility_code`;

  let out: Sheet;
  switch (sheet) {
    case "facilities": {
      out = {
        columns: [
          "facility_code", "facility_name", "facility_type", "ownership_category", "ownership_authority", "region", "district", "council", "ward", "village",
          "latitude", "longitude", "location_source", "location_confidence", "hfr_latitude", "hfr_longitude", "phone", "operating_status",
          "climate_service_count", "climate_services", "best_priority_tier",
        ],
        rows: await q<Row>(sql`
          SELECT f.facility_code, f.name AS facility_name, f.facility_type, f.ownership_category, f.ownership_authority, f.region_name AS region,
                 f.district_name AS district, f.council_name AS council, f.ward_name AS ward, f.village_name AS village,
                 coalesce(g.final_lat, f.hfr_lat) AS latitude, coalesce(g.final_lng, f.hfr_lng) AS longitude,
                 coalesce(g.geocode_source, 'hfr') AS location_source, g.confidence AS location_confidence, f.hfr_lat AS hfr_latitude, f.hfr_lng AS hfr_longitude,
                 coalesce(f.phone_e164, f.phone) AS phone, f.operating_status,
                 (SELECT count(*)::int FROM facility_climate_services cs WHERE cs.facility_code = f.facility_code AND cs.service_code = ANY(${codeList}::text[])) AS climate_service_count,
                 (SELECT array_agg(cs.service_code ORDER BY cs.tier, cs.service_code) FROM facility_climate_services cs WHERE cs.facility_code = f.facility_code AND cs.service_code = ANY(${codeList}::text[])) AS climate_services,
                 (SELECT min(cs.tier) FROM facility_climate_services cs WHERE cs.facility_code = f.facility_code AND cs.service_code = ANY(${codeList}::text[])) AS best_priority_tier
          ${from} WHERE ${where} AND ${included} ORDER BY f.region_name, f.council_name, f.name`),
      };
      break;
    }
    case "facility_services": {
      out = {
        columns: ["facility_code", "service_code", "service_name_en", "service_name_sw", "category_en", "category_sw", "priority_tier", "tier_name_en", "tier_name_sw"],
        rows: await q<Row>(sql`
          SELECT cs.facility_code, cs.service_code, s.name_en AS service_name_en, s.name_sw AS service_name_sw, s.category_en, s.category_sw,
                 s.tier AS priority_tier, s.tier_en AS tier_name_en, s.tier_sw AS tier_name_sw
          ${from} JOIN facility_climate_services cs ON cs.facility_code = f.facility_code
          JOIN climate_services s ON s.code = cs.service_code
          WHERE ${where} AND ${included} AND cs.service_code = ANY(${codeList}::text[])
          ORDER BY cs.facility_code, s.tier, cs.service_code`),
      };
      break;
    }
    case "service_lookup": {
      const counts = await q<{ service_code: string; n: number }>(sql`
        SELECT cs.service_code, count(DISTINCT f.facility_code)::int n
        ${from} JOIN facility_climate_services cs ON cs.facility_code = f.facility_code
        WHERE ${where} AND ${included} GROUP BY 1`);
      const n = new Map(counts.map((c) => [c.service_code, c.n]));
      out = {
        columns: [
          "service_code", "service_name_en", "service_name_sw", "description_en", "description_sw", "category_en", "category_sw", "priority_tier",
          "tier_name_en", "tier_name_sw", "climate_health_rationale", "source", "translation_confidence", "mapping_note", "facilities_in_export",
        ],
        rows: SERVICES.filter((s) => codes.includes(s.code)).map((s) => ({
          service_code: s.code,
          service_name_en: s.nameEn,
          service_name_sw: s.nameSw,
          description_en: s.descEn,
          description_sw: s.descSw,
          category_en: CATEGORIES[s.category].en,
          category_sw: CATEGORIES[s.category].sw,
          priority_tier: s.tier,
          tier_name_en: TIERS[s.tier].en,
          tier_name_sw: TIERS[s.tier].sw,
          climate_health_rationale: s.rationale,
          source: s.source === "draft" ? "Original draft" : "Added - not in original draft",
          translation_confidence: s.confidence === "high" ? "High" : "Needs review",
          mapping_note: s.mappingNote ?? "",
          facilities_in_export: n.get(s.code) ?? 0,
        })),
      };
      break;
    }
    case "exclusions": {
      out = {
        columns: ["facility_code", "facility_name", "facility_type", "region", "council", "operating_status", "reason"],
        rows: await q<Row>(sql`
          SELECT f.facility_code, f.name AS facility_name, f.facility_type, f.region_name AS region, f.council_name AS council, f.operating_status,
                 CASE WHEN NOT (${operating}) THEN 'not operating (closed, non-operational or unknown status)'
                      WHEN NOT (${hasService}) THEN 'no climate-sensitive service recorded'
                      ELSE 'no usable location (missing critical data)' END AS reason
          ${from} WHERE ${where} AND NOT (${included}) ORDER BY reason, f.region_name, f.name`),
      };
      // Removed facilities are listed too: they dropped off the portal's list.
      const removed = await q<Row>(sql`
        SELECT f.facility_code, f.name AS facility_name, f.facility_type, f.region_name AS region, f.council_name AS council, f.operating_status,
               'removed from the portal list (de-registered)' AS reason
        FROM facilities f WHERE f.removed_at IS NOT NULL ORDER BY f.facility_code`);
      out.rows.push(...removed);
      break;
    }
    case "data_quality": {
      const [t] = await q<Record<string, number>>(sql`
        SELECT count(*)::int total,
               count(*) FILTER (WHERE NOT (${operating}))::int not_operating,
               count(*) FILTER (WHERE NOT (${located}))::int no_location,
               count(*) FILTER (WHERE f.hfr_lat IS NULL)::int no_hfr_point,
               count(*) FILTER (WHERE g.confidence = 'low')::int low_confidence,
               count(*) FILTER (WHERE 'shared_point' = ANY(g.sanity_flags))::int shared_point,
               count(*) FILTER (WHERE 'outside_village' = ANY(g.sanity_flags))::int outside_village,
               count(*) FILTER (WHERE g.geocode_source IN ('village_centroid', 'ward_centroid', 'council_centroid'))::int stand_in,
               count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM facility_services s WHERE s.facility_code = f.facility_code))::int no_services
        ${from} WHERE ${where}`);
      const [d] = await q<Record<string, number>>(sql`
        SELECT count(*)::int dup_names FROM (
          SELECT upper(name), ward_code FROM facilities WHERE removed_at IS NULL AND ward_code IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1) x`);
      const [m] = await q<Record<string, number>>(sql`
        SELECT count(*)::int mislabeled FROM (SELECT DISTINCT category, description FROM facility_services
          WHERE (category = 'Vaccination' AND description LIKE 'Nutritional%') OR (category = 'Growth Monitoring / Nutrition Surveillance' AND description NOT ILIKE '%growth%' AND description NOT ILIKE '%nutrition%')) x`);
      const rows = [
        ["facilities_checked", t.total, "Facilities matching the filters, before the climate checks.", "Counted."],
        ["not_operating", t.not_operating, "Closed, non-operational or unknown operating status.", operatingOnly ? "Excluded (see exclusions)." : "Kept because 'only operating' is off."],
        ["no_location", t.no_location, "No portal point and no corrected point.", locatedOnly ? "Excluded (see exclusions)." : "Kept without coordinates."],
        ["no_portal_coordinates", t.no_hfr_point, "The portal has no coordinates; a corrected point may have been found.", "Corrected point used; the portal value is kept in hfr_latitude / hfr_longitude."],
        ["low_confidence_location", t.low_confidence, "The pipeline could not confirm the location.", "Kept, with location_confidence = low so the app can show it differently."],
        ["stand_in_location", t.stand_in, "Location is the centre of a village, ward or council, not a located facility.", "Kept; location_source says which."],
        ["outside_registered_village", t.outside_village, "The point lies outside the village named in the registry.", "Kept and flagged for review."],
        ["shared_coordinates", t.shared_point, "Another facility has exactly the same coordinates.", "Kept and flagged for review."],
        ["duplicate_names_in_ward", d.dup_names, "Facilities with the same name in the same ward (possible duplicates).", "Kept; not merged. Registry team to review."],
        ["no_services_recorded", t.no_services, "No services recorded at all.", "Cannot be climate-sensitive; listed in exclusions."],
        ["mislabelled_service_categories", m.mislabeled, "Service names filed under the wrong portal category (for example nutrition under 'Vaccination').", "Matched on the service name, not the category."],
        ["draft_services_not_in_registry", UNMATCHED.length, UNMATCHED.map((u) => u.name).join("; "), "Reported; no facility can be listed for them."],
      ];
      out = { columns: ["check", "count", "what", "how_handled"], rows: rows.map(([check, count, what, how]) => ({ check, count, what, how_handled: how })) };
      break;
    }
    default:
      return Response.json({ error: "Unknown sheet" }, { status: 400 });
  }

  return new Response(toCsv(out), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="climate-${sheet}-${new Date().toISOString().slice(0, 10)}.csv"`,
      "X-Climate-Scope": label,
    },
  });
}
