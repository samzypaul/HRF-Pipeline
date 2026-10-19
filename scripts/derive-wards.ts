/**
 * Build ward polygons from the village polygons (each village carries its ward, district and region),
 * then link them to HFR ward codes. Use it when no official ward file is available; load-wards.ts is preferred when one is.
 *
 *   npx tsx scripts/derive-wards.ts [--replace]
 *
 * Without --replace the script refuses to run when ward_boundaries already has rows. Rows from this script are tagged
 * source_id = 'derived:villages', so --replace only removes those (a real ward file is never deleted) and manual
 * crosswalk links are kept by matchWards.
 */
import "./_env";
import { sql } from "drizzle-orm";
import { closeDb, q } from "../src/lib/db/client";
import { matchWards } from "../src/lib/geo/wards";

const SOURCE = "derived:villages";

async function main() {
  const replace = process.argv.includes("--replace");
  const [{ n: villages }] = await q<{ n: number }>(sql`SELECT count(*)::int n FROM village_boundaries WHERE ward_name IS NOT NULL`);
  if (villages === 0) throw new Error("village_boundaries is empty (or has no ward names): run scripts/load-villages.ts first.");
  const [{ n: existing, derived }] = await q<{ n: number; derived: number }>(
    sql`SELECT count(*)::int n, count(*) FILTER (WHERE source_id = ${SOURCE})::int derived FROM ward_boundaries`,
  );
  if (existing - derived > 0) throw new Error(`ward_boundaries holds ${existing - derived} rows from a ward file; refusing to mix them with derived wards.`);
  if (existing > 0 && !replace) throw new Error(`ward_boundaries already holds ${existing} derived rows. Pass --replace to rebuild them.`);

  // Villages tile their ward with small gaps, so the union is closed by a ~100 m buffer out and back in (geography-free, in degrees).
  // The new rows go in first and the old derived ones are deleted afterwards, so a failure never leaves the table empty.
  const [{ max_id: oldMax }] = await q<{ max_id: number }>(sql`SELECT coalesce(max(id), 0)::int max_id FROM ward_boundaries`);
  await q(sql`
    INSERT INTO ward_boundaries (source_id, name, district_name, region_name, properties, geom)
    SELECT ${SOURCE}, ward_name, district_name, region_name,
           jsonb_build_object('villages', count(*)),
           ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Buffer(ST_Buffer(ST_Union(geom), 0.001), -0.001)), 3))
    FROM village_boundaries
    WHERE ward_name IS NOT NULL
    GROUP BY ward_name, district_name, region_name`);
  const [{ n: built }] = await q<{ n: number }>(sql`SELECT count(*)::int n FROM ward_boundaries WHERE id > ${oldMax}`);
  if (built === 0) throw new Error("No ward polygons were built.");
  if (replace) await q(sql`DELETE FROM ward_boundaries WHERE id <= ${oldMax} AND source_id = ${SOURCE}`);
  await q(sql`ANALYZE ward_boundaries`);
  console.log(`Built ${built} ward polygons from ${villages} villages.`);

  // Links made against the deleted rows are stale; auto links are rebuilt, manual ones are kept.
  await q(sql`DELETE FROM ward_crosswalk WHERE method <> 'manual'`);
  const m = await matchWards();
  console.log(`Linked ${m.matched} of ${m.totalWards} HFR wards (${m.ambiguous} ambiguous, ${m.unmatched.length} unmatched).`);
  for (const u of m.unmatched.slice(0, 15)) console.log(`  unmatched: ${u.ward} / ${u.council ?? "-"} / ${u.region ?? "-"}`);
  if (m.unmatched.length > 15) console.log(`  … and ${m.unmatched.length - 15} more (link them by hand on the Admin page).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
