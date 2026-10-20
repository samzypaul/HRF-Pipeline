/**
 * Load council (LGA) polygons with their district and region (GeoJSON, EPSG:4326) into council_boundaries.
 *
 *   npx tsx scripts/load-councils.ts data/tanzania_map.json [--name=Council] [--district=District_N] [--region=Region] [--replace]
 */
import "./_env";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { closeDb, q } from "../src/lib/db/client";

interface Feature {
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
  if (!file || file.startsWith("--")) throw new Error("Usage: tsx scripts/load-councils.ts <councils.geojson> [--name=..] [--district=..] [--region=..] [--replace]");
  const fc = JSON.parse(readFileSync(file, "utf8")) as { features: Feature[] };
  const keys = Object.keys(fc.features[0]?.properties ?? {});
  const nameKey = arg("name") ?? detect(keys, [/^ADM2_EN$/i, /council/i, /lga/i, /^name$/i]);
  const districtKey = arg("district") ?? detect(keys, [/district/i, /^ADM2_EN$/i]);
  const regionKey = arg("region") ?? detect(keys, [/^ADM1_EN$/i, /region/i]);
  if (!nameKey) throw new Error(`Could not find the council name field among: ${keys.join(", ")}`);
  console.log(`Fields → council: ${nameKey}, district: ${districtKey ?? "-"}, region: ${regionKey ?? "-"}`);

  if (process.argv.includes("--replace")) await q(sql`DELETE FROM council_boundaries`);

  let loaded = 0;
  let skipped = 0;
  for (const f of fc.features) {
    if (!f.geometry || !/Polygon/.test(f.geometry.type)) {
      skipped++;
      continue;
    }
    const p = f.properties ?? {};
    const s = (k?: string) => (k && p[k] != null && String(p[k]).trim() !== "" ? String(p[k]).trim() : null);
    await q(sql`
      INSERT INTO council_boundaries (name, district_name, region_name, properties, geom)
      VALUES (${s(nameKey) ?? "Unknown"}, ${s(districtKey)}, ${s(regionKey)}, ${JSON.stringify(p)}::jsonb,
        ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(f.geometry)}), 4326)), 3)))`);
    loaded++;
  }
  console.log(`Loaded ${loaded} council polygons (${skipped} skipped).`);
  await q(sql`ANALYZE council_boundaries`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
