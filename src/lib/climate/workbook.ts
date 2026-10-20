import ExcelJS from "exceljs";
import { SHEET_NAMES, buildSheet, buildSummary, type DatasetParams, type Row, type Sheet } from "./dataset";

/** Sheet names as the dataset spec calls them (the summary comes first so it is what a reader sees on opening). */
const TAB: Record<string, string> = {
  summary: "Summary",
  facilities: "Facilities",
  facility_services: "Facility_Services",
  service_lookup: "Service_Lookup",
  exclusions: "Exclusions",
  data_quality: "Data_Quality",
};

/** Columns that hold sentences: wider, and wrapped. */
const LONG = new Set(["description_en", "description_sw", "climate_health_rationale", "mapping_note", "what", "how_handled", "note", "item", "value", "reason", "tier_name_sw", "tier_name_en"]);

const cell = (v: unknown): string | number | null => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  if (Array.isArray(v)) return v.join("|");
  return String(v);
};

function addSheet(wb: ExcelJS.Workbook, name: string, sheet: Sheet) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = sheet.columns.map((key) => {
    const widest = sheet.rows.slice(0, 300).reduce((w, r: Row) => Math.max(w, String(cell(r[key]) ?? "").length), key.length);
    return { header: key, key, width: LONG.has(key) ? Math.min(60, Math.max(18, widest + 2)) : Math.min(40, Math.max(10, widest + 2)) };
  });
  for (const r of sheet.rows) ws.addRow(sheet.columns.map((c) => cell(r[c])));
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } };
  header.alignment = { vertical: "middle" };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, sheet.columns.length) } };
  // Wrap the sentence columns so long text stays readable without merged cells.
  sheet.columns.forEach((key, i) => {
    if (LONG.has(key)) ws.getColumn(i + 1).alignment = { wrapText: true, vertical: "top" };
  });
}

/** The whole dataset as one Excel workbook: a summary, then the five sheets, with no merged cells and one header row each. */
export async function buildWorkbook(p: DatasetParams): Promise<{ buffer: Buffer; scope: string }> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "HFR Pipeline";
  wb.created = new Date();
  addSheet(wb, TAB.summary, await buildSummary(p));
  let scope = "all climate-sensitive services";
  for (const name of SHEET_NAMES) {
    const built = await buildSheet(name, p);
    scope = built.scope;
    addSheet(wb, TAB[name], built.sheet);
  }
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, scope };
}
