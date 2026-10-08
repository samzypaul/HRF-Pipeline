import type { ListRow } from "../hfr/parse";
import { hashOf } from "../util";

/** Fields taken from the list page, keyed by facilities column (snake_case). */
export function listData(r: ListRow) {
  return {
    name: r.name,
    facility_type: r.facilityType,
    region_name: r.regionName,
    council_name: r.councilName,
    ownership_category: r.ownershipCategory,
    ownership_authority: r.ownershipAuthority,
    moh_authority: r.mohAuthority,
    operating_status: r.operatingStatus,
  };
}

export type ListData = ReturnType<typeof listData>;
export const listHash = (d: ListData) => hashOf(d);

export interface FieldDiff {
  field: string;
  from: unknown;
  to: unknown;
}

export function diffFields(before: Record<string, unknown>, after: Record<string, unknown>, fields?: string[]): FieldDiff[] {
  const keys = fields ?? [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const out: FieldDiff[] = [];
  for (const k of keys) {
    const a = before[k] ?? null;
    const b = after[k] ?? null;
    const same = typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-7 : JSON.stringify(a) === JSON.stringify(b);
    if (!same) out.push({ field: k, from: a, to: b });
  }
  return out;
}

const isOperating = (s: unknown) => typeof s === "string" && /^operating$/i.test(s.trim());

/** Classify a list-level change. */
export function classifyChange(diffs: FieldDiff[]): "closed" | "reopened" | "updated" {
  const status = diffs.find((d) => d.field === "operating_status");
  if (status) {
    if (isOperating(status.from) && !isOperating(status.to)) return "closed";
    if (!isOperating(status.from) && isOperating(status.to)) return "reopened";
  }
  return "updated";
}

/** Detail-page fields we track for changes (facilities column names). */
export const DETAIL_FIELDS = [
  "common_name",
  "date_opened",
  "zone",
  "district_name",
  "ward_name",
  "village_name",
  "ownership_details",
  "registration_status",
  "phone",
  "website",
  "nearest_facility",
  "ctc_id",
  "msd_id",
  "mtuha_id",
  "hfr_lat",
  "hfr_lng",
] as const;
