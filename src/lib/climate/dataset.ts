import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { readFilters, whereFor, type Filters } from "../data";
import { SERVICES, SERVICE_BY_CODE, TIERS, UNMATCHED } from "./catalogue";

/**
 * The climate-sensitive facility dataset for the El Niño app, as sheets (one header row, snake_case columns, UTF-8 when saved as CSV):
 * facilities, facility_services, service_lookup, exclusions, data_quality, plus a short summary for the workbook.
 * Facilities are never changed; every row traces back to the registry by facility_code and service code.
 */

export type Row = Record<string, unknown>;
export interface Sheet {
  columns: string[];
  rows: Row[];
}

export const SHEET_NAMES = ["facilities", "facility_services", "service_lookup", "exclusions", "data_quality"] as const;
export type SheetName = (typeof SHEET_NAMES)[number];

export interface DatasetParams {
  filters: Filters;
  operatingOnly: boolean;
  locatedOnly: boolean;
}

/** Read the dataset parameters from a URL: the usual filters plus `operating` and `located`. */
export function paramsFrom(url: URL): DatasetParams {
  // A checkbox posts "1" when ticked and a hidden "0" always; with neither parameter (a plain link) the check is on.
  const flag = (name: string) => {
    const v = url.searchParams.getAll(name);
    return v.length === 0 || v.includes("1");
  };
  return { filters: readFilters(url.searchParams), operatingOnly: flag("operating"), locatedOnly: flag("located") };
}

/** Which climate-sensitive services the export is about: the chosen ones, else all of them. */
export function chosenServices(climate: string | undefined): { codes: string[]; label: string } {
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

/** The SQL pieces every sheet shares. */
function parts(p: DatasetParams) {
  // The "climate" filter is handled here (it also narrows the services listed), so it is not passed on to whereFor.
  const { codes, label } = chosenServices(p.filters.climate);
  const where = whereFor({ ...p.filters, climate: undefined });
  const codeList = sql.param(codes);
  const operating = sql`f.operating_status ILIKE 'operating'`;
  const located = sql`coalesce(g.final_lat, f.hfr_lat) IS NOT NULL`;
  const hasService = sql`EXISTS (SELECT 1 FROM facility_climate_services cs WHERE cs.facility_code = f.facility_code AND cs.service_code = ANY(${codeList}::text[]))`;
  const included = sql`${hasService} AND ${p.operatingOnly ? operating : sql`true`} AND ${p.locatedOnly ? located : sql`true`}`;
  const from = sql`FROM facilities f LEFT JOIN geo_validation g ON g.facility_code = f.facility_code`;
  // The facilities in the dataset, worked out once (MATERIALIZED), so a sheet with many rows per facility does not repeat the test per row.
  const inSet = sql`WITH fac AS MATERIALIZED (SELECT f.facility_code ${from} WHERE ${where} AND ${included})`;
  return { codes, label, where, codeList, operating, located, hasService, included, from, inSet };
}

export async function buildSheet(name: SheetName, p: DatasetParams): Promise<{ sheet: Sheet; scope: string }> {
  const { codes, label, where, codeList, operating, located, hasService, included, from, inSet } = parts(p);
  switch (name) {
    case "facilities":
      return {
        scope: label,
        sheet: {
          columns: [
            "facility_code", "facility_name", "facility_type", "ownership_category", "ownership_authority", "region", "district", "council", "ward", "village",
            "latitude", "longitude", "location_source", "location_confidence", "hfr_latitude", "hfr_longitude", "phone", "operating_status",
            "climate_service_count", "climate_services", "best_priority_tier",
          ],
          rows: await q<Row>(sql`
            ${inSet},
            agg AS (SELECT cs.facility_code, count(*)::int AS n, array_agg(cs.service_code ORDER BY cs.tier, cs.service_code) AS codes, min(cs.tier) AS best
                    FROM facility_climate_services cs JOIN fac USING (facility_code) WHERE cs.service_code = ANY(${codeList}::text[]) GROUP BY 1)
            SELECT f.facility_code, f.name AS facility_name, f.facility_type, f.ownership_category, f.ownership_authority, f.region_name AS region,
                   f.district_name AS district, f.council_name AS council, f.ward_name AS ward, f.village_name AS village,
                   coalesce(g.final_lat, f.hfr_lat) AS latitude, coalesce(g.final_lng, f.hfr_lng) AS longitude,
                   coalesce(g.geocode_source, 'hfr') AS location_source, g.confidence AS location_confidence, f.hfr_lat AS hfr_latitude, f.hfr_lng AS hfr_longitude,
                   coalesce(f.phone_e164, f.phone) AS phone, f.operating_status,
                   coalesce(agg.n, 0) AS climate_service_count, agg.codes AS climate_services, agg.best AS best_priority_tier
            FROM fac JOIN facilities f ON f.facility_code = fac.facility_code
            LEFT JOIN geo_validation g ON g.facility_code = f.facility_code
            LEFT JOIN agg ON agg.facility_code = f.facility_code
            ORDER BY f.region_name, f.council_name, f.name`),
        },
      };
    case "facility_services": {
      // Only the two codes come from the database; the names are added here from the catalogue (about 145,000 rows would otherwise
      // repeat the same long English and Kiswahili text and be slow to transfer).
      const pairs = await q<{ facility_code: string; service_code: string }>(sql`
        ${inSet}
        SELECT cs.facility_code, cs.service_code
        FROM fac JOIN facility_climate_services cs ON cs.facility_code = fac.facility_code
        WHERE cs.service_code = ANY(${codeList}::text[])`);
      const rows: Row[] = [];
      for (const pair of pairs) {
        const s = SERVICE_BY_CODE.get(pair.service_code);
        if (!s) continue;
        rows.push({
          facility_code: pair.facility_code,
          service_code: s.code,
          service_name_en: s.name,
          service_name_sw: s.nameSw,
          category_en: s.category,
          category_sw: s.categorySw,
          priority_tier: s.tier,
          tier_name_en: TIERS[s.tier].en,
          tier_name_sw: TIERS[s.tier].sw,
        });
      }
      rows.sort((a, b) => String(a.facility_code).localeCompare(String(b.facility_code)) || Number(a.priority_tier) - Number(b.priority_tier) || String(a.service_code).localeCompare(String(b.service_code)));
      return {
        scope: label,
        sheet: {
          columns: ["facility_code", "service_code", "service_name_en", "service_name_sw", "category_en", "category_sw", "priority_tier", "tier_name_en", "tier_name_sw"],
          rows,
        },
      };
    }
    case "service_lookup": {
      const counts = await q<{ service_code: string; n: number }>(sql`
        ${inSet}
        SELECT cs.service_code, count(DISTINCT fac.facility_code)::int n
        FROM fac JOIN facility_climate_services cs ON cs.facility_code = fac.facility_code GROUP BY 1`);
      const n = new Map(counts.map((c) => [c.service_code, c.n]));
      return {
        scope: label,
        sheet: {
          columns: [
            "service_code", "service_name_en", "service_name_sw", "description_en", "description_sw", "category_en", "category_sw", "priority_tier",
            "tier_name_en", "tier_name_sw", "climate_health_rationale", "source", "translation_confidence", "mapping_note", "facilities_in_export",
          ],
          rows: SERVICES.filter((s) => codes.includes(s.code)).map((s) => ({
            service_code: s.code,
            service_name_en: s.name,
            service_name_sw: s.nameSw,
            description_en: s.descEn,
            description_sw: s.descSw,
            category_en: s.category,
            category_sw: s.categorySw,
            priority_tier: s.tier,
            tier_name_en: TIERS[s.tier].en,
            tier_name_sw: TIERS[s.tier].sw,
            climate_health_rationale: s.rationale,
            source: s.source === "draft" ? "Original draft" : "Added - not in original draft",
            translation_confidence: s.confidence === "high" ? "High" : "Needs review",
            mapping_note: s.mappingNote ?? "",
            facilities_in_export: n.get(s.code) ?? 0,
          })),
        },
      };
    }
    case "exclusions": {
      const rows = await q<Row>(sql`
        SELECT f.facility_code, f.name AS facility_name, f.facility_type, f.region_name AS region, f.council_name AS council, f.operating_status,
               CASE WHEN NOT (${operating}) THEN 'not operating (closed, non-operational or unknown status)'
                    WHEN NOT (${hasService}) THEN 'no climate-sensitive service recorded'
                    ELSE 'no usable location (missing critical data)' END AS reason
        ${from} WHERE ${where} AND NOT (${included}) ORDER BY reason, f.region_name, f.name`);
      // Removed facilities are listed too: they dropped off the portal's list.
      rows.push(
        ...(await q<Row>(sql`
          SELECT f.facility_code, f.name AS facility_name, f.facility_type, f.region_name AS region, f.council_name AS council, f.operating_status,
                 'removed from the portal list (de-registered)' AS reason
          FROM facilities f WHERE f.removed_at IS NOT NULL ORDER BY f.facility_code`)),
      );
      return { scope: label, sheet: { columns: ["facility_code", "facility_name", "facility_type", "region", "council", "operating_status", "reason"], rows } };
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
      const rows: [string, number, string, string][] = [
        ["facilities_checked", t.total, "Facilities matching the filters, before the climate checks.", "Counted."],
        ["not_operating", t.not_operating, "Closed, non-operational or unknown operating status.", p.operatingOnly ? "Excluded (see exclusions)." : "Kept because 'only operating' is off."],
        ["no_location", t.no_location, "No portal point and no corrected point.", p.locatedOnly ? "Excluded (see exclusions)." : "Kept without coordinates."],
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
      return {
        scope: label,
        sheet: { columns: ["check", "count", "what", "how_handled"], rows: rows.map(([check, count, what, how]) => ({ check, count, what, how_handled: how })) },
      };
    }
  }
}

/**
 * A short summary for the workbook: how many facilities went in and why others were left out, how they split by region and priority tier,
 * which draft services could not be matched, which services were added, and the assumptions that need the team's decision.
 */
export async function buildSummary(p: DatasetParams): Promise<Sheet> {
  const { codeList, where, included, from, label, inSet } = parts(p);
  const [t] = await q<Record<string, number>>(sql`
    SELECT (SELECT count(*) FROM facilities WHERE removed_at IS NULL)::int active,
           count(*)::int matching,
           count(*) FILTER (WHERE ${included})::int in_dataset
    ${from} WHERE ${where}`);
  const byRegion = await q<{ region: string | null; n: number }>(sql`
    ${inSet}
    SELECT f.region_name AS region, count(*)::int n FROM fac JOIN facilities f ON f.facility_code = fac.facility_code GROUP BY 1 ORDER BY n DESC`);
  const byTier = await q<{ tier: number; n: number }>(sql`
    ${inSet}
    SELECT cs.tier, count(DISTINCT fac.facility_code)::int n
    FROM fac JOIN facility_climate_services cs ON cs.facility_code = fac.facility_code
    WHERE cs.service_code = ANY(${codeList}::text[]) GROUP BY 1 ORDER BY 1`);

  const rows: Row[] = [];
  const add = (section: string, item: string, value: unknown, note = "") => rows.push({ section, item, value, note });
  add("Totals", "Active facilities in the registry", t.active);
  add("Totals", "Facilities matching the filters", t.matching);
  add("Totals", "Facilities in this dataset", t.in_dataset, `Scope: ${label}.${p.operatingOnly ? " Operating facilities only." : ""}${p.locatedOnly ? " With a location only." : ""}`);
  add("Totals", "Facilities left out", t.matching - t.in_dataset, "See the Exclusions sheet for each one and the reason.");
  for (const r of byTier) add("Facilities per priority tier", `Tier ${r.tier}: ${TIERS[r.tier as 1 | 2 | 3 | 4 | 5].en}`, r.n, "A facility counts in every tier it has a service in.");
  for (const r of byRegion) add("Facilities per region", r.region ?? "Unknown", r.n);
  for (const u of UNMATCHED) add("Not in the registry", u.name, `Tier ${u.tier}`, `${u.origin === "draft" ? "Named in the brainstorm" : "Suggested by the prompt"}. ${u.reason}`);
  for (const s of SERVICES.filter((x) => x.source === "added")) add("Services added (not in the original draft)", `${s.code}: ${s.name}`, `Tier ${s.tier}`, s.rationale);
  for (const s of SERVICES.filter((x) => x.confidence === "review")) add("Needs review by the team", `${s.code}: ${s.name}`, s.nameSw, s.mappingNote ?? "Kiswahili needs a native-speaker health professional.");
  const decisions = [
    "Services are matched by their name in the registry, not by the portal category, because categories are sometimes wrong.",
    "Any laboratory test counts as the laboratory service; a test for a specific disease also counts as that disease's service.",
    "Tiers for the added services are our judgement from the prompt and need the team's agreement.",
    "Kiswahili names and descriptions are a first draft; entries marked Needs review must be checked by a health professional.",
    "Closed or non-operational facilities and facilities with no location are excluded and listed, not silently dropped.",
    "The portal's coordinates are never changed; the corrected point is in latitude and longitude, the original in hfr_latitude and hfr_longitude.",
  ];
  decisions.forEach((d, i) => add("Assumptions and decisions", `${i + 1}`, d));
  return { columns: ["section", "item", "value", "note"], rows };
}
