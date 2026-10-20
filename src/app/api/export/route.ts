import { sql } from "drizzle-orm";
import { q } from "@/lib/db/client";
import { readFilters, whereFor } from "@/lib/data";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const COLUMNS = [
  "facility_code",
  "name",
  "common_name",
  "facility_type",
  "operating_status",
  "registration_status",
  "ownership_category",
  "ownership_authority",
  "moh_authority",
  "region_name",
  "district_name",
  "council_name",
  "ward_name",
  "village_name",
  "region_code",
  "council_code",
  "ward_code",
  "date_opened",
  "phone",
  "phone_e164",
  "website",
  "hfr_lat",
  "hfr_lng",
  "confidence",
  "in_ward",
  "distance_to_ward_m",
  "match_source",
  "name_score",
  "geocode_source",
  "boundary_village",
  "village_check",
  "final_lat",
  "final_lng",
  "sanity_flags",
  "review_decision",
  "notes",
  "services_count",
  "services",
] as const;

const KEY = ["facility_code", "name", "region_name", "council_name", "ward_name"] as const;

/** Narrower datasets, one row per facility (validation) or per service. Always CSV. */
const TABLES = {
  services: {
    columns: [...KEY, "category", "description"],
    select: sql`SELECT f.facility_code, f.name, f.region_name, f.council_name, f.ward_name, s.category, s.description
      FROM facilities f JOIN facility_services s ON s.facility_code = f.facility_code`,
    order: sql`ORDER BY f.facility_code, s.category, s.description`,
  },
  validation: {
    columns: [
      ...KEY,
      "hfr_lat",
      "hfr_lng",
      "confidence",
      "in_ward",
      "distance_to_ward_m",
      "match_source",
      "name_score",
      "geocode_source",
      "boundary_village",
      "village_check",
      "final_lat",
      "final_lng",
      "sanity_flags",
      "review_decision",
      "notes",
    ],
    select: sql`SELECT f.facility_code, f.name, f.region_name, f.council_name, f.ward_name, f.hfr_lat, f.hfr_lng,
        g.confidence, g.in_ward, g.distance_to_ward_m, g.match_source, g.name_score, g.geocode_source, g.boundary_village, g.village_check,
        g.final_lat, g.final_lng, g.sanity_flags, r.decision AS review_decision, g.notes
      FROM facilities f
      JOIN geo_validation g ON g.facility_code = f.facility_code
      LEFT JOIN review_decisions r ON r.facility_code = f.facility_code`,
    order: sql`ORDER BY f.facility_code`,
  },
} as const;

const csvCell = (v: unknown) => {
  if (v == null) return "";
  const s = Array.isArray(v) ? v.join("|") : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Stream the body in chunks (Vercel caps non-streamed responses at 4.5 MB). */
function streamOf(parts: Iterable<string>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const it = parts[Symbol.iterator]();
  return new ReadableStream({
    pull(controller) {
      let buf = "";
      for (let i = 0; i < 500; i++) {
        const n = it.next();
        if (n.done) {
          if (buf) controller.enqueue(enc.encode(buf));
          controller.close();
          return;
        }
        buf += n.value;
      }
      controller.enqueue(enc.encode(buf));
    },
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tableParam = url.searchParams.get("table");
  const table = tableParam === "services" || tableParam === "validation" ? TABLES[tableParam] : null;
  if (table) {
    const data = await q<Record<string, unknown>>(sql`${table.select} WHERE ${whereFor(readFilters(url.searchParams))} ${table.order}`);
    const cols = table.columns as readonly string[];
    function* tableLines() {
      yield "﻿" + cols.join(",") + "\n";
      for (const r of data) yield cols.map((c) => csvCell(r[c])).join(",") + "\n";
    }
    return new Response(streamOf(tableLines()), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="hfr-${tableParam}-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }
  const format = url.searchParams.get("format") === "geojson" ? "geojson" : "csv";
  const rows = await q<Record<string, unknown>>(sql`
    SELECT f.facility_code, f.name, f.common_name, f.facility_type, f.operating_status, f.registration_status,
           f.ownership_category, f.ownership_authority, f.moh_authority, f.region_name, f.district_name, f.council_name,
           f.ward_name, f.village_name, f.region_code, f.council_code, f.ward_code, f.date_opened, f.phone, f.phone_e164, f.website, f.hfr_lat, f.hfr_lng,
           g.confidence, g.in_ward, g.distance_to_ward_m, g.match_source, g.name_score, g.geocode_source, g.boundary_village, g.village_check,
           g.final_lat, g.final_lng, g.sanity_flags, r.decision AS review_decision, g.notes,
           (SELECT count(*)::int FROM facility_services s WHERE s.facility_code = f.facility_code) AS services_count,
           (SELECT array_agg(s.category || ': ' || s.description ORDER BY s.category, s.description)
              FROM facility_services s WHERE s.facility_code = f.facility_code) AS services
    FROM facilities f
    LEFT JOIN geo_validation g ON g.facility_code = f.facility_code
    LEFT JOIN review_decisions r ON r.facility_code = f.facility_code
    WHERE ${whereFor(readFilters(url.searchParams))}
    ORDER BY f.facility_code`);
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === "geojson") {
    function* parts() {
      yield '{"type":"FeatureCollection","features":[';
      let first = true;
      for (const r of rows) {
        const lat = (r.final_lat ?? r.hfr_lat) as number | null;
        const lng = (r.final_lng ?? r.hfr_lng) as number | null;
        const feature = {
          type: "Feature",
          geometry: lat != null && lng != null ? { type: "Point", coordinates: [Number(lng), Number(lat)] } : null,
          properties: r,
        };
        yield (first ? "" : ",") + JSON.stringify(feature);
        first = false;
      }
      yield "]}";
    }
    return new Response(streamOf(parts()), {
      headers: {
        "Content-Type": "application/geo+json",
        "Content-Disposition": `attachment; filename="hfr-facilities-${stamp}.geojson"`,
      },
    });
  }
  function* lines() {
    yield "\uFEFF" + COLUMNS.join(",") + "\n";
    for (const r of rows) yield COLUMNS.map((c) => csvCell(r[c])).join(",") + "\n";
  }
  return new Response(streamOf(lines()), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="hfr-facilities-${stamp}.csv"`,
    },
  });
}
