import { SHEET_NAMES, buildSheet, paramsFrom, type SheetName, type Sheet } from "@/lib/climate/dataset";
import { buildWorkbook } from "@/lib/climate/workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 180; // the workbook has about 160,000 rows

/**
 * The climate-sensitive facility dataset for the El Niño app.
 *   ?sheet=facilities | facility_services | service_lookup | exclusions | data_quality   one sheet as CSV (UTF-8, one header row, snake_case)
 *   ?sheet=workbook                                                                       all of it as one Excel workbook (with a summary)
 * Filters: the usual export filters, plus `climate` (which services count), `operating` and `located` (both on unless unticked).
 */

const csvCell = (v: unknown) => {
  if (v == null) return "";
  const s = Array.isArray(v) ? v.join("|") : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const toCsv = ({ columns, rows }: Sheet) =>
  "﻿" + columns.join(",") + "\n" + rows.map((r) => columns.map((c) => csvCell(r[c])).join(",")).join("\n") + (rows.length ? "\n" : "");

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sheet = url.searchParams.get("sheet") ?? "facilities";
  const params = paramsFrom(url);
  const stamp = new Date().toISOString().slice(0, 10);

  if (sheet === "workbook") {
    const { buffer, scope } = await buildWorkbook(params);
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="climate-sensitive-facilities-${stamp}.xlsx"`,
        "X-Climate-Scope": scope,
      },
    });
  }
  if (!(SHEET_NAMES as readonly string[]).includes(sheet)) return Response.json({ error: "Unknown sheet" }, { status: 400 });
  const built = await buildSheet(sheet as SheetName, params);
  return new Response(toCsv(built.sheet), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="climate-${sheet}-${stamp}.csv"`,
      "X-Climate-Scope": built.scope,
    },
  });
}
