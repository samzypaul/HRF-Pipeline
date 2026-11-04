/**
 * Two review workbooks for the tier 1 and 2 climate-sensitive services (the team's 13 named services):
 *   1. tier1-2-service-counts.xlsx          how many facilities offer each service, and the facility-level aggregate
 *   2. tier1-2-services-en-sw-review.xlsx   the services in English and Kiswahili, with blank columns for the reviewer
 *
 *   npx tsx scripts/export-tier12-review.ts [outDir]
 */
import "./_env";
import path from "node:path";
import ExcelJS from "exceljs";
import { sql } from "drizzle-orm";
import { closeDb, q } from "../src/lib/db/client";
import { SERVICES, TIERS } from "../src/lib/climate/catalogue";

const outDir = process.argv[2] ?? ".";
const inScope = SERVICES.filter((s) => s.tier === 1 || s.tier === 2).sort((a, b) => a.tier - b.tier || a.code.localeCompare(b.code));
const codes = inScope.map((s) => s.code);

type Cell = string | number | null;

function sheet(wb: ExcelJS.Workbook, name: string, columns: { header: string; width?: number; wrap?: boolean }[], rows: Cell[][]) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, width: c.width ?? 16 }));
  rows.forEach((r) => ws.addRow(r));
  const h = ws.getRow(1);
  h.font = { bold: true, color: { argb: "FFFFFFFF" } };
  h.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } };
  h.alignment = { vertical: "middle", wrapText: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  columns.forEach((c, i) => {
    if (c.wrap) ws.getColumn(i + 1).alignment = { wrapText: true, vertical: "top" };
  });
  return ws;
}

async function counts() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "HFR Pipeline";
  const list = sql.param(codes);

  const perService = await q<{ code: string; total: number; hospitals: number; operating: number; sharing: number; sharing_agg: number; only: number }>(sql`
    WITH n AS (
      SELECT facility_code, count(*)::int AS k FROM facility_climate_services WHERE service_code = ANY(${list}::text[]) GROUP BY 1)
    SELECT c.service_code AS code,
           count(*)::int AS total,
           count(*) FILTER (WHERE f.facility_type ILIKE '%hospital%')::int AS hospitals,
           count(*) FILTER (WHERE f.operating_status ILIKE 'operating')::int AS operating,
           count(*) FILTER (WHERE n.k > 1)::int AS sharing,
           coalesce(sum(n.k) FILTER (WHERE n.k > 1), 0)::int AS sharing_agg,
           count(*) FILTER (WHERE n.k = 1)::int AS only
    FROM facility_climate_services c JOIN facilities f USING (facility_code) JOIN n USING (facility_code)
    WHERE c.service_code = ANY(${list}::text[]) GROUP BY 1`);
  const by = new Map(perService.map((r) => [r.code, r]));

  const [distinct] = await q<{ facilities: number; links: number }>(sql`
    SELECT count(DISTINCT facility_code)::int AS facilities, count(*)::int AS links FROM facility_climate_services WHERE service_code = ANY(${list}::text[])`);

  const rows: Cell[][] = inScope.map((s) => {
    const r = by.get(s.code);
    return [s.tier, s.code, s.name, s.category, r?.total ?? 0, r?.hospitals ?? 0, (r?.total ?? 0) - (r?.hospitals ?? 0), r?.operating ?? 0,
      r?.sharing ?? 0, r?.sharing_agg ?? 0, r?.only ?? 0];
  });
  for (const t of [1, 2] as const) {
    const part = inScope.filter((s) => s.tier === t).map((s) => by.get(s.code));
    rows.push([t, "", `Tier ${t} subtotal (facility-service links, a facility counts once per service)`, "", part.reduce((a, r) => a + (r?.total ?? 0), 0), "", "", "", "", "", ""]);
  }
  rows.push(["", "", "All 13 services: distinct facilities / total facility-service links", "", distinct.facilities, "", "", "", "", distinct.links, ""]);
  sheet(wb, "Service counts", [
    { header: "tier", width: 6 }, { header: "code", width: 8 }, { header: "service", width: 48, wrap: true }, { header: "portal category", width: 34, wrap: true },
    { header: "facilities offering it", width: 14 }, { header: "of which hospitals", width: 12 }, { header: "of which other facilities", width: 14 },
    { header: "of which operating", width: 12 },
    { header: "facilities that also offer another of the 13", width: 18 },
    { header: "aggregate: services offered by those shared facilities (sum)", width: 22 },
    { header: "facilities offering only this one", width: 16 },
  ], rows);

  // facility-level aggregate
  const facilities = await q<{ facility_code: string; name: string; facility_type: string; region: string; council: string; operating_status: string; t1: number; t2: number; codes: string[] }>(sql`
    SELECT f.facility_code, f.name, f.facility_type, f.region_name AS region, f.council_name AS council, f.operating_status,
           count(*) FILTER (WHERE c.tier = 1)::int AS t1, count(*) FILTER (WHERE c.tier = 2)::int AS t2,
           array_agg(c.service_code ORDER BY c.tier, c.service_code) AS codes
    FROM facility_climate_services c JOIN facilities f USING (facility_code)
    WHERE c.service_code = ANY(${list}::text[])
    GROUP BY f.facility_code, f.name, f.facility_type, f.region_name, f.council_name, f.operating_status
    ORDER BY count(*) DESC, f.facility_code`);

  const dist = new Map<number, number>();
  for (const f of facilities) dist.set(f.t1 + f.t2, (dist.get(f.t1 + f.t2) ?? 0) + 1);
  const distRows: Cell[][] = [...dist.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => [k, n, k * n]);
  distRows.push(["Total", facilities.length, distRows.reduce((a, r) => a + Number(r[2]), 0)]);
  sheet(wb, "Aggregate by facility", [
    { header: "number of the 13 services a facility offers", width: 22 }, { header: "facilities", width: 12 }, { header: "service links (services x facilities)", width: 20 },
  ], distRows);

  sheet(wb, "Facilities", [
    { header: "facility_code", width: 16 }, { header: "facility_name", width: 36 }, { header: "facility_type", width: 22 }, { header: "region", width: 16 },
    { header: "council", width: 22 }, { header: "operating_status", width: 16 }, { header: "tier 1 services", width: 10 }, { header: "tier 2 services", width: 10 },
    { header: "total (aggregate)", width: 12 }, { header: "service codes", width: 50 },
  ], facilities.map((f) => [f.facility_code, f.name, f.facility_type, f.region, f.council, f.operating_status, f.t1, f.t2, f.t1 + f.t2, f.codes.join(", ")]));

  const types = await q<{ facility_type: string; code: string; n: number }>(sql`
    SELECT f.facility_type, c.service_code AS code, count(*)::int AS n
    FROM facility_climate_services c JOIN facilities f USING (facility_code) WHERE c.service_code = ANY(${list}::text[]) GROUP BY 1, 2`);
  const typeNames = [...new Set(types.map((t) => t.facility_type ?? "(none)"))].sort();
  const cellOf = new Map(types.map((t) => [`${t.facility_type ?? "(none)"}|${t.code}`, t.n]));
  sheet(wb, "By facility type", [{ header: "service", width: 48 }, ...typeNames.map((t) => ({ header: t, width: 16 }))].map((c) => ({ ...c, wrap: false })),
    inScope.map((s) => [`${s.code} ${s.name}`, ...typeNames.map((t) => cellOf.get(`${t}|${s.code}`) ?? 0)]));

  await wb.xlsx.writeFile(path.join(outDir, "tier1-2-service-counts.xlsx"));
  return { facilities: distinct.facilities, links: distinct.links, perService: rows.slice(0, inScope.length), dist: distRows };
}

async function review() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "HFR Pipeline";
  sheet(wb, "Tier 1 and 2 services", [
    { header: "tier", width: 6 }, { header: "tier name (EN)", width: 28, wrap: true }, { header: "tier name (SW)", width: 30, wrap: true }, { header: "code", width: 8 },
    { header: "service (EN)", width: 40, wrap: true }, { header: "service (SW)", width: 44, wrap: true },
    { header: "category (EN)", width: 30, wrap: true }, { header: "category (SW)", width: 32, wrap: true },
    { header: "description (EN)", width: 50, wrap: true }, { header: "description (SW)", width: 54, wrap: true },
    { header: "climate-health rationale", width: 44, wrap: true }, { header: "source", width: 10 }, { header: "translation confidence", width: 12 },
    { header: "mapping note", width: 36, wrap: true },
    { header: "reviewer: approved? (Y/N)", width: 14 }, { header: "reviewer: corrected service name (SW)", width: 34, wrap: true },
    { header: "reviewer: corrected description (SW)", width: 40, wrap: true }, { header: "reviewer: comments", width: 36, wrap: true },
  ], inScope.map((s) => [s.tier, TIERS[s.tier].en, TIERS[s.tier].sw, s.code, s.name, s.nameSw, s.category, s.categorySw, s.descEn, s.descSw, s.rationale,
    s.source, s.confidence, s.mappingNote ?? null, null, null, null, null]));
  await wb.xlsx.writeFile(path.join(outDir, "tier1-2-services-en-sw-review.xlsx"));
}

(async () => {
  const r = await counts();
  await review();
  console.log(`${r.facilities} distinct facilities, ${r.links} facility-service links`);
  for (const row of r.perService) console.log(row.join(" | "));
  console.log("distribution:", JSON.stringify(r.dist));
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
