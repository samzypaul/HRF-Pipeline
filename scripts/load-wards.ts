/**
 * Load ward boundary polygons (GeoJSON, EPSG:4326) into ward_boundaries,
 * then link them to HFR ward codes.
 *
 *   npx tsx scripts/load-wards.ts path/to/wards.geojson [--name=Ward_Name] [--district=District_N] [--region=Region_Nam] [--replace]
 *
 * Field names are auto-detected when not given (HDX COD-AB ADM3_EN/ADM2_EN/ADM1_EN, or anything containing "ward",
 * "district"/"council"/"lga", "region"). Convert a shapefile first, e.g.
 *   npx mapshaper wards.shp -proj wgs84 -o format=geojson wards.geojson
 */
import "./_env";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { closeDb, q } from "../src/lib/db/client";
import { matchWards } from "../src/lib/geo/wards";

interface Feature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown } | null;
}

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}

function detect(keys: string[], patterns: RegExp[]): string | undefined {
  for (const p of patterns) {
    const k = keys.find((k) => p.test(k));
    if (k) return k;
  }
  return undefined;
}

async function main() {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) throw new Error("Usage: tsx scripts/load-wards.ts <wards.geojson> [--name=..] [--district=..] [--region=..] [--replace]");
  const fc = JSON.parse(readFileSync(file, "utf8")) as { features: Feature[] };
  const keys = Object.keys(fc.features[0]?.properties ?? {});
  const nameKey = arg("name") ?? detect(keys, [/^ADM3_EN$/i, /^ward_?name$/i, /^ward$/i, /ward/i, /^name$/i]);
  const districtKey = arg("district") ?? detect(keys, [/^ADM2_EN$/i, /council/i, /lga/i, /district/i]);
  const regionKey = arg("region") ?? detect(keys, [/^ADM1_EN$/i, /region/i]);
  if (!nameKey) throw new Error(`Could not find the ward name field among: ${keys.join(", ")}`);
  console.log(`Fields → ward: ${nameKey}, district/council: ${districtKey ?? "-"}, region: ${regionKey ?? "-"}`);

  if (process.argv.includes("--replace")) {
    await q(sql`DELETE FROM ward_crosswalk WHERE method = 'auto'`);
    await q(sql`DELETE FROM ward_boundaries`);
  }

  let loaded = 0;
  let skipped = 0;
  for (const f of fc.features) {
    if (!f.geometry || !/Polygon/.test(f.geometry.type)) {
      skipped++;
      continue;
    }
    const p = f.properties ?? {};
    const s = (k?: string) => (k && p[k] != null ? String(p[k]) : null);
    await q(sql`
      INSERT INTO ward_boundaries (source_id, name, district_name, region_name, properties, geom)
      VALUES (${s("ADM3_PCODE") ?? s("id") ?? s("OBJECTID") ?? null}, ${s(nameKey) ?? "Unknown"}, ${s(districtKey)}, ${s(regionKey)},
        ${JSON.stringify(p)}::jsonb,
        ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(f.geometry)}), 4326)), 3)))`);
    loaded++;
    if (loaded % 500 === 0) console.log(`  ${loaded} loaded…`);
  }
  console.log(`Loaded ${loaded} ward polygons (${skipped} skipped).`);

  const r = await matchWards();
  console.log(`Matched ${r.matched} of ${r.totalWards} HFR wards (${r.ambiguous} ambiguous, ${r.unmatched.length} unmatched).`);
  if (r.unmatched.length) {
    console.log("First unmatched wards (link these manually on the Admin page):");
    for (const u of r.unmatched.slice(0, 30)) console.log(`  ${u.ward_code}  ${u.ward}  (${u.council}, ${u.region})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
