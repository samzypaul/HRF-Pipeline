import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { ratio } from "./name-match";

/** Normalise an admin-unit name for matching ("Kinondoni MC" → "kinondoni"). */
export function normAdmin(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(region|district|council|municipal|municipality|town|city|ward|mkoa|wilaya|kata|dc|mc|tc|cc|vc)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface HfrWard {
  ward_code: string;
  ward: string;
  council: string | null;
  district: string | null;
  region: string | null;
}

interface Boundary {
  id: number;
  name: string;
  district_name: string | null;
  region_name: string | null;
}

export interface MatchResult {
  matched: number;
  ambiguous: number;
  unmatched: { ward_code: string; ward: string; council: string | null; region: string | null }[];
  totalWards: number;
}

/**
 * Link HFR ward codes to boundary polygons by name within the same region
 * (district/council name breaks ties). Manual links are never overwritten.
 */
export async function matchWards(): Promise<MatchResult> {
  const wards = await q<HfrWard>(sql`
    SELECT w.code ward_code, w.name ward, c.name council, d.name district, r.name region
    FROM admin_units w
    LEFT JOIN admin_units c ON c.code = w.parent_code
    LEFT JOIN admin_units d ON d.code = c.parent_code
    LEFT JOIN admin_units r ON r.code = d.parent_code
    WHERE w.level = 4`);
  const boundaries = await q<Boundary>(sql`SELECT id, name, district_name, region_name FROM ward_boundaries`);
  const manual = new Set(
    (await q<{ ward_code: string }>(sql`SELECT ward_code FROM ward_crosswalk WHERE method = 'manual'`)).map((r) => r.ward_code),
  );

  const byRegion = new Map<string, Boundary[]>();
  for (const b of boundaries) {
    const k = normAdmin(b.region_name);
    if (!byRegion.has(k)) byRegion.set(k, []);
    byRegion.get(k)!.push(b);
  }

  const result: MatchResult = { matched: 0, ambiguous: 0, unmatched: [], totalWards: wards.length };
  const links: { ward_code: string; boundary_id: number; score: number }[] = [];

  for (const w of wards) {
    if (manual.has(w.ward_code)) {
      result.matched++;
      continue;
    }
    const pool = byRegion.get(normAdmin(w.region)) ?? boundaries;
    const wn = normAdmin(w.ward);
    const districtNames = [normAdmin(w.council), normAdmin(w.district)].filter(Boolean);
    const scored = pool
      .map((b) => {
        const nameScore = ratio(wn, normAdmin(b.name));
        const bd = normAdmin(b.district_name);
        const districtScore = bd ? Math.max(0, ...districtNames.map((d) => ratio(d, bd))) : 50;
        return { b, nameScore, districtScore, total: nameScore * 0.75 + districtScore * 0.25 };
      })
      .filter((s) => s.nameScore >= 85)
      .sort((a, b) => b.total - a.total);

    if (scored.length === 0) {
      result.unmatched.push({ ward_code: w.ward_code, ward: w.ward, council: w.council, region: w.region });
      continue;
    }
    const [best, second] = scored;
    if (second && Math.abs(best.total - second.total) < 3 && best.districtScore < 80) {
      result.ambiguous++;
      result.unmatched.push({ ward_code: w.ward_code, ward: w.ward, council: w.council, region: w.region });
      continue;
    }
    links.push({ ward_code: w.ward_code, boundary_id: best.b.id, score: Math.round(best.total) });
    result.matched++;
  }

  for (let i = 0; i < links.length; i += 500) {
    const chunk = links.slice(i, i + 500);
    await q(sql`
      INSERT INTO ward_crosswalk (ward_code, boundary_id, method, score, updated_at)
      VALUES ${sql.join(chunk.map((l) => sql`(${l.ward_code}, ${l.boundary_id}, 'auto', ${l.score}, now())`), sql`, `)}
      ON CONFLICT (ward_code) DO UPDATE SET boundary_id = EXCLUDED.boundary_id, score = EXCLUDED.score, updated_at = now()
        WHERE ward_crosswalk.method <> 'manual'`);
  }
  return result;
}

/** Set a manual link (from the Admin page or a CSV). */
export async function setManualWardLink(wardCode: string, boundaryId: number) {
  await q(sql`
    INSERT INTO ward_crosswalk (ward_code, boundary_id, method, score, updated_at)
    VALUES (${wardCode}, ${boundaryId}, 'manual', 100, now())
    ON CONFLICT (ward_code) DO UPDATE SET boundary_id = EXCLUDED.boundary_id, method = 'manual', score = 100, updated_at = now()`);
}
