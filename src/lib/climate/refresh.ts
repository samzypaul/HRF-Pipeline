import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { SERVICES, TIERS } from "./catalogue";
import { classifyService } from "./classify";
import { CATEGORY_SW, NEEDS_REVIEW, SERVICE_SW } from "./translations";

export interface ClimateRefresh {
  services: number;
  facilities: number;
  links: number;
  /** distinct (category, service name) pairs in the registry that are climate-sensitive services */
  matchedPairs: number;
  totalPairs: number;
  /** distinct registry (category, service name) pairs with no Kiswahili name yet (new services the portal added) */
  untranslated: number;
  /** catalogue services that no facility in the registry offers (a sign the portal renamed or moved one) */
  missingFromRegistry: string[];
}

/**
 * Work out which facilities offer climate-sensitive services and store the result.
 *
 * 1. The catalogue is written to `climate_services` (a lookup people can read in the database).
 * 2. Every distinct (category, service name) pair in `facility_services` gets its Kiswahili name in `service_translations`.
 * 3. Each pair is matched to the catalogue by its exact portal text (a few hundred pairs, not 300,000 rows).
 * 4. `facility_climate_services` is brought in line: new links added, links that no longer hold removed.
 * Safe to run at any time and as often as you like.
 */
export async function refreshClimateServices(): Promise<ClimateRefresh> {
  await q(sql`
    INSERT INTO climate_services (code, tier, tier_en, tier_sw, category_en, category_sw, name_en, name_sw, desc_en, desc_sw,
                                  rationale, source, confidence, mapping_note, updated_at)
    VALUES ${sql.join(
      SERVICES.map((s) => sql`(${s.code}, ${s.tier}, ${TIERS[s.tier].en}, ${TIERS[s.tier].sw}, ${s.category}, ${s.categorySw}, ${s.name}, ${s.nameSw},
        ${s.descEn}, ${s.descSw}, ${s.rationale}, ${s.source}, ${s.confidence}, ${s.mappingNote ?? null}, now())`),
      sql`, `,
    )}
    ON CONFLICT (code) DO UPDATE SET tier = EXCLUDED.tier, tier_en = EXCLUDED.tier_en, tier_sw = EXCLUDED.tier_sw,
      category_en = EXCLUDED.category_en, category_sw = EXCLUDED.category_sw, name_en = EXCLUDED.name_en, name_sw = EXCLUDED.name_sw,
      desc_en = EXCLUDED.desc_en, desc_sw = EXCLUDED.desc_sw, rationale = EXCLUDED.rationale, source = EXCLUDED.source,
      confidence = EXCLUDED.confidence, mapping_note = EXCLUDED.mapping_note, updated_at = now()`);
  await q(sql`DELETE FROM climate_services WHERE code <> ALL(${sql.param(SERVICES.map((s) => s.code))}::text[])`);

  const pairs = await q<{ category: string; description: string }>(sql`SELECT DISTINCT category, description FROM facility_services`);

  // Kiswahili for every service the portal lists, climate-sensitive or not.
  const translated = pairs.map((p) => ({
    ...p,
    categorySw: CATEGORY_SW[p.category] ?? null,
    descriptionSw: SERVICE_SW[p.description] ?? null,
    review: NEEDS_REVIEW.has(`c:${p.category}`) || NEEDS_REVIEW.has(`s:${p.description}`),
  }));
  if (translated.length) {
    await q(sql`
      INSERT INTO service_translations (category, description, category_sw, description_sw, needs_review, updated_at)
      VALUES ${sql.join(translated.map((t) => sql`(${t.category}, ${t.description}, ${t.categorySw}, ${t.descriptionSw}, ${t.review}, now())`), sql`, `)}
      ON CONFLICT (category, description) DO UPDATE SET category_sw = EXCLUDED.category_sw, description_sw = EXCLUDED.description_sw,
        needs_review = EXCLUDED.needs_review, updated_at = now()`);
    await q(sql`DELETE FROM service_translations st WHERE NOT EXISTS (SELECT 1 FROM facility_services fs WHERE fs.category = st.category AND fs.description = st.description)`);
  }

  const map: { category: string; description: string; code: string; tier: number }[] = [];
  for (const p of pairs) {
    const s = classifyService(p.category, p.description);
    if (s) map.push({ category: p.category, description: p.description, code: s.code, tier: s.tier });
  }

  if (map.length === 0) {
    await q(sql`DELETE FROM facility_climate_services`);
  } else {
    const values = sql.join(map.map((m) => sql`(${m.category}, ${m.description}, ${m.code}, ${m.tier}::smallint)`), sql`, `);
    await q(sql`
      INSERT INTO facility_climate_services (facility_code, service_code, tier)
      SELECT DISTINCT fs.facility_code, m.code, m.tier
      FROM facility_services fs JOIN (VALUES ${values}) AS m(category, description, code, tier)
        ON m.category = fs.category AND m.description = fs.description
      ON CONFLICT (facility_code, service_code) DO UPDATE SET tier = EXCLUDED.tier`);
    await q(sql`
      DELETE FROM facility_climate_services c
      WHERE NOT EXISTS (
        SELECT 1 FROM facility_services fs JOIN (VALUES ${values}) AS m(category, description, code, tier)
          ON m.category = fs.category AND m.description = fs.description
        WHERE fs.facility_code = c.facility_code AND m.code = c.service_code)`);
  }

  const [totals] = await q<{ facilities: number; links: number }>(sql`
    SELECT count(DISTINCT facility_code)::int facilities, count(*)::int links FROM facility_climate_services`);
  const found = new Set(map.map((m) => m.code));
  return {
    services: SERVICES.length,
    facilities: Number(totals?.facilities ?? 0),
    links: Number(totals?.links ?? 0),
    matchedPairs: map.length,
    totalPairs: pairs.length,
    untranslated: translated.filter((t) => t.categorySw == null || t.descriptionSw == null).length,
    missingFromRegistry: SERVICES.filter((s) => !found.has(s.code)).map((s) => s.code),
  };
}
