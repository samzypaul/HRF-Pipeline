/**
 * Load village polygons from a shapefile (.shp with its .dbf next to it) into village_boundaries.
 * Coordinates may be WGS 84 or Web Mercator (EPSG:3857, detected from the .prj or, without one, from the extent).
 *
 *   npx tsx scripts/load-villages.ts data/villages.shp [--name=Vil_Mtaa_N] [--ward=Ward_Name] [--district=District_N] [--region=Region_Nam] [--replace] [--encoding=utf-8]
 *
 * Field names are auto-detected when not given (anything containing "village"/"vil"/"mtaa"/"kijiji", "ward",
 * "district"/"council"/"lga", "region", or COD-AB ADM4_EN/ADM3_EN/ADM2_EN/ADM1_EN). Any other projection: reproject first with
 *   npx mapshaper villages.shp -proj wgs84 -o villages-wgs84.shp
 */
import "./_env";
import { existsSync, readFileSync } from "node:fs";
import { open } from "shapefile";
import { sql } from "drizzle-orm";
import { closeDb, q } from "../src/lib/db/client";

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

/** SRID of the file's coordinates: 4326 or 3857. Anything else is rejected. */
function detectSrid(shpPath: string): 4326 | 3857 | 3395 {
  const prj = shpPath.replace(/\.shp$/i, ".prj");
  if (existsSync(prj)) {
    const wkt = readFileSync(prj, "utf8");
    if (/Mercator_Auxiliary_Sphere|Pseudo.?Mercator|EPSG.{0,5}3857|WGS_1984_Web_Mercator/i.test(wkt)) return 3857;
    // Ellipsoidal Mercator (differs from 3857 by kilometres in latitude, so it must not be treated as 3857).
    if (/WGS_1984_World_Mercator|EPSG.{0,5}3395/i.test(wkt)) return 3395;
    if (/^GEOGCS/i.test(wkt.trim()) && /WGS[_ ]?84/i.test(wkt)) return 4326;
    throw new Error(`Unsupported projection in the .prj (${wkt.slice(0, 80)}…). Reproject first: npx mapshaper <file>.shp -proj wgs84 -o <out>.shp`);
  }
  // No .prj: the header holds the bounding box. Degrees stay within ±180/±90, Web Mercator metres do not.
  const h = readFileSync(shpPath).subarray(0, 100);
  const extent = [36, 44, 52, 60].map((o) => Math.abs(h.readDoubleLE(o)));
  const srid = Math.max(...extent) > 360 ? 3857 : 4326;
  console.warn(`No .prj file: assuming EPSG:${srid} from the extent.`);
  return srid;
}

async function main() {
  const file = process.argv[2];
  if (!file || file.startsWith("--") || !/\.shp$/i.test(file)) {
    throw new Error("Usage: tsx scripts/load-villages.ts <villages.shp> [--name=..] [--ward=..] [--district=..] [--region=..] [--replace]");
  }
  const dbf = file.replace(/\.shp$/i, ".dbf");
  if (!existsSync(dbf)) throw new Error(`Missing ${dbf}: the .dbf holds the village, ward and district names. Copy it next to the .shp.`);
  const srid = detectSrid(file);
  console.log(`Coordinate system: EPSG:${srid}`);
  const source = await open(file, undefined, { encoding: arg("encoding") ?? "utf-8" });

  let nameKey = arg("name");
  let wardKey = arg("ward");
  let districtKey = arg("district");
  let regionKey = arg("region");
  let idKey: string | undefined;

  // With --replace the old rows are deleted only after every new row is in, so a dropped connection never leaves the table empty.
  const [{ max_id: oldMax }] = await q<{ max_id: number }>(sql`SELECT coalesce(max(id), 0)::int max_id FROM village_boundaries`);
  const pending: ReturnType<typeof sql>[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    const rows = pending.splice(0);
    for (let attempt = 1; ; attempt++) {
      try {
        await q(sql`INSERT INTO village_boundaries (source_id, name, ward_name, district_name, region_name, properties, geom) VALUES ${sql.join(rows, sql`, `)}`);
        return;
      } catch (e) {
        if (attempt >= 5) throw e;
        console.warn(`  batch failed (${(e as Error).message.slice(0, 80)}), retry ${attempt}/4…`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  };

  let loaded = 0;
  let skipped = 0;
  for (;;) {
    const { done, value: f } = await source.read();
    if (done) break;
    const p = (f.properties ?? {}) as Record<string, unknown>;
    if (loaded + skipped === 0) {
      const keys = Object.keys(p);
      nameKey ??= detect(keys, [/^ADM4_EN$/i, /^vil(lage)?_?(mtaa_?)?n(ame)?$/i, /village|mtaa|kijiji/i, /^vil/i, /^name$/i]);
      wardKey ??= detect(keys, [/^ADM3_EN$/i, /ward|kata/i]);
      districtKey ??= detect(keys, [/^ADM2_EN$/i, /^dist(rict)?(_name)?$/i, /district/i, /council|lga/i]);
      regionKey ??= detect(keys, [/^ADM1_EN$/i, /^reg(ion)?(_name)?$/i, /region/i]);
      idKey = detect(keys, [/^ADM4_PCODE$/i, /^vil.*(code|id)$/i, /^OBJECTID$/i, /^id$/i]);
      if (!nameKey) throw new Error(`Could not find the village name field among: ${keys.join(", ")}. Pass --name=<field>.`);
      console.log(`Fields → village: ${nameKey}, ward: ${wardKey ?? "-"}, district: ${districtKey ?? "-"}, region: ${regionKey ?? "-"}, id: ${idKey ?? "-"}`);
    }
    if (!f.geometry || !/Polygon/.test(f.geometry.type)) {
      skipped++;
      continue;
    }
    const s = (k?: string) => (k && p[k] != null && String(p[k]).trim() !== "" ? String(p[k]).trim() : null);
    pending.push(sql`(${s(idKey)}, ${s(nameKey) ?? "Unknown"}, ${s(wardKey)}, ${s(districtKey)}, ${s(regionKey)}, ${JSON.stringify(p)}::jsonb,
        ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(f.geometry)}), ${srid}), 4326)), 3)))`);
    loaded++;
    if (pending.length >= 100) await flush();
    if (loaded % 2000 === 0) console.log(`  ${loaded} loaded…`);
  }
  await flush();
  const [{ n: stored }] = await q<{ n: number }>(sql`SELECT count(*)::int n FROM village_boundaries WHERE id > ${oldMax}`);
  if (stored !== loaded) throw new Error(`Stored ${stored} rows but read ${loaded}: not replacing the old rows. Delete id > ${oldMax} and retry.`);
  if (process.argv.includes("--replace")) await q(sql`DELETE FROM village_boundaries WHERE id <= ${oldMax}`);
  console.log(`Loaded ${loaded} village polygons (${skipped} skipped).`);
  await q(sql`ANALYZE village_boundaries`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
