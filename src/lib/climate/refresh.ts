import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { CATEGORIES, SERVICES, TIERS } from "./catalogue";
import { classifyService } from "./classify";

export interface ClimateRefresh {
  services: number;
  facilities: number;
  links: number;
  /** distinct (category, service name) pairs in the registry that matched at least one climate-sensitive service */
  matchedPairs: number;
  totalPairs: number;
}

/**
 * Work out which facilities offer climate-sensitive services and store the result.
 *
 * 1. The catalogue is written to `climate_services` (a lookup people can read in the database).
 * 2. Each distinct (category, service name) pair in `facility_services` is classified once (a few hundred pairs, not 300,000 rows).
 * 3. `facility_climate_services` is brought in line with the result: new links added, links that no longer hold removed.
 * Safe to run at any time and as often as you like.
 */
export async function refreshClimateServices(): Promise<ClimateRefresh> {
  await q(sql`
    INSERT INTO climate_services (code, tier, category_key, tier_en, tier_sw, category_en, category_sw, name_en, name_sw, desc_en, desc_sw,
                                  rationale, source, confidence, mapping_note, updated_at)
    VALUES ${sql.join(
      SERVICES.map((s) => sql`(${s.code}, ${s.tier}, ${s.category}, ${TIERS[s.tier].en}, ${TIERS[s.tier].sw}, ${CATEGORIES[s.category].en}, ${CATEGORIES[s.category].sw},
        ${s.nameEn}, ${s.nameSw}, ${s.descEn}, ${s.descSw}, ${s.rationale}, ${s.source}, ${s.confidence}, ${s.mappingNote ?? null}, now())`),
      sql`, `,
    )}
    ON CONFLICT (code) DO UPDATE SET tier = EXCLUDED.tier, category_key = EXCLUDED.category_key, tier_en = EXCLUDED.tier_en, tier_sw = EXCLUDED.tier_sw,
      category_en = EXCLUDED.category_en, category_sw = EXCLUDED.category_sw, name_en = EXCLUDED.name_en, name_sw = EXCLUDED.name_sw,
      desc_en = EXCLUDED.desc_en, desc_sw = EXCLUDED.desc_sw, rationale = EXCLUDED.rationale, source = EXCLUDED.source,
      confidence = EXCLUDED.confidence, mapping_note = EXCLUDED.mapping_note, updated_at = now()`);
  await q(sql`DELETE FROM climate_services WHERE code <> ALL(${sql.param(SERVICES.map((s) => s.code))}::text[])`);

  const pairs = await q<{ category: string; description: string }>(sql`SELECT DISTINCT category, description FROM facility_services`);
  const map: { category: string; description: string; code: string; tier: number }[] = [];
  const matched = new Set<string>();
  for (const p of pairs) {
    for (const s of classifyService(p.category, p.description)) {
      map.push({ category: p.category, description: p.description, code: s.code, tier: s.tier });
      matched.add(`${p.category}\u0000${p.description}`);
    }
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
  return {
    services: SERVICES.length,
    facilities: Number(totals?.facilities ?? 0),
    links: Number(totals?.links ?? 0),
    matchedPairs: matched.size,
    totalPairs: pairs.length,
  };
}
