/**
 * Move facilities with no usable point that sit on a ward or council centre onto the centre of their HFR village, found by the
 * village name inside the council (the ward name in the village file is out of date for many wards). The village centre is graded
 * medium. No geocoder or Google calls are made. Validation does the same for new and re-checked facilities; this catches up the rest.
 *
 *   npx tsx scripts/backfill-village-centres.ts [--dry-run]
 */
import "./_env";
import { sql } from "drizzle-orm";
import { closeDb, q } from "../src/lib/db/client";
import { councilPolygon, pointInCouncilPolygon } from "../src/lib/geo/council";
import { pickVillageInCouncil, villagesOfRegion, type VillageCandidate } from "../src/lib/geo/village";

interface Row {
  facility_code: string;
  village_name: string;
  council_name: string;
  region_name: string;
  geocode_source: string;
}

async function main() {
  const dry = process.argv.includes("--dry-run");
  const rows = await q<Row>(sql`
    SELECT f.facility_code, f.village_name, f.council_name, f.region_name, g.geocode_source
    FROM facilities f JOIN geo_validation g ON g.facility_code = f.facility_code
    WHERE f.removed_at IS NULL AND g.geocode_source IN ('ward_centroid', 'council_centroid')
      AND coalesce(f.village_name, '') <> '' AND coalesce(f.council_name, '') <> ''
    ORDER BY f.facility_code`);
  const regions = new Map<string, VillageCandidate[]>();
  const councils = new Map<string, Awaited<ReturnType<typeof councilPolygon>>>();
  let moved = 0;
  let noMatch = 0;
  let outsideCouncil = 0;
  for (const r of rows) {
    let villages = regions.get(r.region_name);
    if (!villages) regions.set(r.region_name, (villages = await villagesOfRegion(r.region_name)));
    const v = pickVillageInCouncil(villages, r.village_name, r.council_name, r.region_name);
    if (!v) {
      noMatch++;
      continue;
    }
    const ckey = `${r.region_name}|${r.council_name}`;
    if (!councils.has(ckey)) councils.set(ckey, await councilPolygon(r.council_name, r.region_name));
    const council = councils.get(ckey);
    if (council && !(await pointInCouncilPolygon(council.id, v.lat, v.lng))) {
      outsideCouncil++;
      continue;
    }
    moved++;
    if (dry) continue;
    await q(sql`
      UPDATE geo_validation SET final_lat = ${v.lat}, final_lng = ${v.lng}, geocode_source = 'village_centroid', confidence = 'medium',
        village_check = 'agrees', boundary_village = ${v.name}, boundary_village_ward = ${v.ward_name},
        sanity_flags = (SELECT coalesce(array_agg(DISTINCT x), ARRAY[]::text[]) FROM unnest(coalesce(sanity_flags, ARRAY[]::text[]) || ARRAY['village_fix']) AS x),
        notes = ${`centre of the HFR village used as a stand-in (inside the right village, not on the building); was a ${r.geocode_source.replace("_", " ")}`},
        checked_at = now()
      WHERE facility_code = ${r.facility_code}`);
  }
  console.log(`${rows.length} stand-ins with a village name: ${moved} ${dry ? "would move" : "moved"} to their village centre, ${noMatch} with no single matching village, ${outsideCouncil} skipped (village centre outside the council).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
