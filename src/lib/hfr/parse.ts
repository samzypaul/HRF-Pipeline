import * as cheerio from "cheerio";
import { clean } from "../util";

// ---------------------------------------------------------------------------
// List page
// ---------------------------------------------------------------------------

export interface ListRow {
  hfrId: number | null;
  facilityCode: string;
  name: string;
  facilityType: string | null;
  regionName: string | null;
  councilName: string | null;
  ownershipCategory: string | null;
  ownershipAuthority: string | null;
  mohAuthority: string | null;
  operatingStatus: string | null;
}

export interface ListPage {
  total: number;
  from: number | null;
  to: number | null;
  rows: ListRow[];
}

const toInt = (s: string | null | undefined) => {
  if (!s) return null;
  const n = Number(s.replace(/[^\d]/g, ""));
  return Number.isFinite(n) && s.match(/\d/) ? n : null;
};

export function parseListPage(html: string): ListPage {
  const $ = cheerio.load(html);
  const rows: ListRow[] = [];
  $("table.kv-grid-table tbody tr").each((_, tr) => {
    const $tr = $(tr);
    const cell = (seq: number) => clean($tr.find(`td[data-col-seq="${seq}"]`).first().text());
    const code = cell(1);
    if (!code || !/^\d{6}-\d$/.test(code)) return; // "No results found." row etc.
    rows.push({
      hfrId: toInt($tr.attr("data-key")),
      facilityCode: code,
      name: cell(2) ?? "",
      facilityType: cell(3),
      regionName: cell(4),
      councilName: cell(5),
      ownershipCategory: cell(6),
      ownershipAuthority: cell(7),
      mohAuthority: cell(8),
      operatingStatus: cell(9),
    });
  });

  // "Showing <b>1-20</b> of <b>14,363</b> items."  or "Total <b>1</b> item."
  const summary = $(".summary").first();
  const bolds = summary.find("b").map((_, b) => $(b).text()).get();
  let total = rows.length;
  let from: number | null = null;
  let to: number | null = null;
  if (bolds.length >= 2) {
    const [range, tot] = bolds;
    const m = range.match(/([\d,]+)\s*-\s*([\d,]+)/);
    if (m) {
      from = toInt(m[1]);
      to = toInt(m[2]);
    }
    total = toInt(tot) ?? total;
  } else if (bolds.length === 1) {
    total = toInt(bolds[0]) ?? total;
  }
  return { total, from, to, rows };
}

// ---------------------------------------------------------------------------
// Detail page
// ---------------------------------------------------------------------------

export interface Address {
  zone: string | null;
  regionName: string | null;
  districtName: string | null;
  councilName: string | null;
  wardName: string | null;
  villageName: string | null;
}

export interface FacilityDetail {
  hfrId: number | null;
  facilityCode: string | null;
  name: string | null;
  commonName: string | null;
  operatingStatus: string | null;
  dateOpened: string | null;
  facilityType: string | null;
  ownership: string | null;
  address: Address;
  addressRaw: string | null;
  phone: string | null;
  website: string | null;
  inChargeQualification: string | null;
  ctcId: string | null;
  nearestFacility: string | null;
  msdId: string | null;
  mtuhaId: string | null;
}

/**
 * "Eastern Zone-Dar es Salaam Region - Kinondoni District - Kinondoni MC - Msasani - Masaki"
 * → zone, region, district, council, ward, village
 */
export function parseAddress(raw: string | null): Address {
  const empty: Address = {
    zone: null,
    regionName: null,
    districtName: null,
    councilName: null,
    wardName: null,
    villageName: null,
  };
  if (!raw) return empty;
  const parts = raw.split(/\s+-\s+/).map((p) => clean(p));
  if (parts.length === 0) return empty;
  let zone: string | null = null;
  let region = parts[0];
  const zm = region?.match(/^(.*?Zone)\s*-\s*(.*)$/i);
  if (zm) {
    zone = clean(zm[1]);
    region = clean(zm[2]);
  }
  return {
    zone,
    regionName: region ?? null,
    districtName: parts[1] ?? null,
    councilName: parts[2] ?? null,
    wardName: parts[3] ?? null,
    villageName: parts[4] ?? null,
  };
}

export function parseDetail(html: string): FacilityDetail {
  const $ = cheerio.load(html);
  const fields: Record<string, string | null> = {};
  $("label").each((_, el) => {
    const key = clean($(el).text())?.toLowerCase();
    if (!key) return;
    const span = $(el).nextAll("span").first();
    fields[key] = clean(span.text());
  });
  const title = clean($("h4").first().text());
  const name = title ? clean(title.replace(/^Facility Name:\s*/i, "")) : null;

  let hfrId: number | null = toInt($('input[name="FacilityMap[conditionviewmap]"]').attr("value"));
  if (hfrId == null) {
    const svc = $("#service").attr("value") ?? "";
    const m = svc.match(/[?&]id=(\d+)/);
    hfrId = m ? Number(m[1]) : null;
  }

  const addressRaw = fields["address"] ?? null;
  const dateOpened = fields["date opened"] ?? null;
  return {
    hfrId,
    facilityCode: fields["facility code"] ?? null,
    name,
    commonName: fields["common name"] ?? null,
    operatingStatus: fields["status"] ?? null,
    dateOpened: dateOpened && /^\d{4}-\d{2}-\d{2}/.test(dateOpened) ? dateOpened.slice(0, 10) : dateOpened,
    facilityType: fields["facility type"] ?? null,
    ownership: fields["ownership"] ?? null,
    address: parseAddress(addressRaw),
    addressRaw,
    phone: fields["official phone"] ?? null,
    website: fields["website"] ?? null,
    inChargeQualification: fields["in-charge qualification"] ?? null,
    ctcId: fields["ctc id"] ?? null,
    nearestFacility: fields["nearest facility"] ?? null,
    msdId: fields["msd id"] ?? null,
    mtuhaId: fields["mtuha id"] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Coordinates JSON
// ---------------------------------------------------------------------------

export interface FacilityCoords {
  hfrId: number;
  lat: number | null;
  lng: number | null;
  wardName: string | null;
  villageName: string | null;
  registrationStatus: string | null;
  operatingStatus: string | null;
  ownershipDetails: string | null;
}

export function parseCoords(body: string): FacilityCoords | null {
  let json: { facilities_list?: Array<Record<string, unknown>> };
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const f = json.facilities_list?.[0];
  if (!f) return null;
  const n = (v: unknown) => {
    const x = typeof v === "string" ? Number(v) : (v as number);
    return typeof x === "number" && Number.isFinite(x) ? x : null;
  };
  const s = (v: unknown) => (v == null ? null : clean(String(v)));
  return {
    hfrId: Number(f.id),
    lat: n(f.latitude),
    lng: n(f.longitude),
    wardName: s(f.Ward),
    villageName: s(f.Village_Mtaa),
    registrationStatus: s(f.registration_status),
    operatingStatus: s(f.operating_status),
    ownershipDetails: s(f.ownership_details),
  };
}

// ---------------------------------------------------------------------------
// Services table
// ---------------------------------------------------------------------------

export interface FacilityService {
  category: string;
  description: string;
}

export function parseServices(html: string): FacilityService[] {
  const $ = cheerio.load(html);
  const out: FacilityService[] = [];
  const seen = new Set<string>();
  $("table tbody tr").each((_, tr) => {
    const $tr = $(tr);
    const category = clean($tr.find('td[data-col-seq="1"]').text());
    const description = clean($tr.find('td[data-col-seq="2"]').text());
    if (!category || !description) return;
    const key = `${category}|${description}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ category, description });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Admin units
// ---------------------------------------------------------------------------

export interface AdminItem {
  code: string;
  name: string;
}

export function parseAdminJson(body: string): AdminItem[] {
  try {
    const json = JSON.parse(body) as { output?: Array<{ id: string; name: string }> };
    return (json.output ?? [])
      .filter((o) => o && o.id)
      .map((o) => ({ code: String(o.id).trim(), name: clean(o.name) ?? String(o.id) }));
  } catch {
    return [];
  }
}

export function parseRegions(html: string): AdminItem[] {
  const $ = cheerio.load(html);
  return $('select[name="region[]"] option')
    .map((_, o) => ({ code: ($(o).attr("value") ?? "").trim(), name: clean($(o).text()) ?? "" }))
    .get()
    .filter((r) => r.code);
}
