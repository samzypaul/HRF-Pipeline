import { sql, type SQL } from "drizzle-orm";
import { q } from "./db/client";
import { whereFor, type Filters } from "./data";

/**
 * What the distribution can be split by. Every expression is fixed here, never taken from the request.
 * Rows are grouped by name (some facilities carry a region code but no name, or the reverse); `ru` is the region the code names,
 * used to fill a missing region name. `key` is the code the Review tab filters on.
 */
const REGION = "coalesce(f.region_name, ru.name)";
export const DIMENSIONS = {
  type: { label: "Facility type", key: "f.facility_type", name: "f.facility_type", sub: "NULL", from: "" },
  region: { label: "Region", key: "f.region_code", name: REGION, sub: "NULL", from: "" },
  council: { label: "Council", key: "f.council_code", name: "f.council_name", sub: REGION, from: "" },
  ward: { label: "Ward", key: "f.ward_code", name: "f.ward_name", sub: `concat_ws(', ', f.council_name, ${REGION})`, from: "" },
  ownership: { label: "Ownership", key: "f.ownership_category", name: "f.ownership_category", sub: "NULL", from: "" },
  status: { label: "Operating status", key: "f.operating_status", name: "f.operating_status", sub: "NULL", from: "" },
  service: {
    label: "Service category",
    key: "s.category",
    name: "s.category",
    sub: "NULL",
    from: "JOIN facility_services s ON s.facility_code = f.facility_code",
  },
} as const;

export type DimensionKey = keyof typeof DIMENSIONS;
export const isDimension = (v: string | undefined): v is DimensionKey => !!v && Object.hasOwn(DIMENSIONS, v);

/** Rows beyond this are cut (wards run to thousands); the page says so and asks for a narrower filter. */
export const MAX_ROWS = 300;

export interface DistributionRow {
  key: string | null;
  label: string | null;
  sub: string | null;
  high: number;
  medium: number;
  low: number;
  unchecked: number;
  total: number;
}

export interface Distribution {
  rows: DistributionRow[];
  /** groups before the cut at MAX_ROWS */
  groups: number;
}

/** Grade counts per group of the chosen dimension, for the facilities matching the filters (confidence and issue are ignored). */
export async function gradeDistribution(by: DimensionKey, filters: Filters): Promise<Distribution> {
  const d = DIMENSIONS[by];
  const where: SQL = whereFor({ region: filters.region, council: filters.council, ward: filters.ward, type: filters.type });
  const rows = await q<DistributionRow & { groups: number }>(sql`
    SELECT max(${sql.raw(d.key)}) AS key, ${sql.raw(d.name)} AS label, ${sql.raw(d.sub)} AS sub,
           count(DISTINCT f.facility_code) FILTER (WHERE g.confidence = 'high')::int AS high,
           count(DISTINCT f.facility_code) FILTER (WHERE g.confidence = 'medium')::int AS medium,
           count(DISTINCT f.facility_code) FILTER (WHERE g.confidence = 'low')::int AS low,
           count(DISTINCT f.facility_code) FILTER (WHERE g.confidence IS NULL)::int AS unchecked,
           count(DISTINCT f.facility_code)::int AS total,
           count(*) OVER ()::int AS groups
    FROM facilities f ${sql.raw(d.from)}
    LEFT JOIN admin_units ru ON ru.code = f.region_code AND ru.level = 1
    LEFT JOIN geo_validation g ON g.facility_code = f.facility_code
    WHERE ${where}
    GROUP BY 2, 3
    ORDER BY total DESC, label NULLS LAST
    LIMIT ${MAX_ROWS}`);
  return { rows, groups: rows[0]?.groups ?? 0 };
}
