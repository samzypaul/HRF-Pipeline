import {
  pgTable,
  text,
  integer,
  serial,
  bigserial,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  real,
  primaryKey,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";

/**
 * PostGIS geometry column. Values are read and written with raw SQL
 * (ST_* functions), so the TypeScript side treats them as opaque text.
 */
const geometry = (name: string, kind: "Point" | "MultiPolygon") =>
  customType<{ data: string; driverData: string }>({
    dataType() {
      return `geometry(${kind}, 4326)`;
    },
  })(name);

const ts = (name: string) => timestamp(name, { withTimezone: true });

/** Region → district → council → ward tree from the HFR portal. */
export const adminUnits = pgTable(
  "admin_units",
  {
    code: text("code").primaryKey(), // e.g. TZ.CL.DO.BA.6.7
    level: integer("level").notNull(), // 1 region, 2 district, 3 council, 4 ward
    name: text("name").notNull(),
    parentCode: text("parent_code"),
    updatedAt: ts("updated_at").defaultNow().notNull(),
  },
  (t) => [index("admin_units_parent_idx").on(t.parentCode), index("admin_units_level_idx").on(t.level)],
);

/** Ward polygons from an external boundary dataset (NBS / HDX). */
export const wardBoundaries = pgTable(
  "ward_boundaries",
  {
    id: serial("id").primaryKey(),
    sourceId: text("source_id"),
    name: text("name").notNull(),
    districtName: text("district_name"),
    regionName: text("region_name"),
    properties: jsonb("properties"),
    geom: geometry("geom", "MultiPolygon").notNull(),
  },
  (t) => [index("ward_boundaries_geom_idx").using("gist", t.geom)],
);

/** Links an HFR ward code to a boundary polygon. */
export const wardCrosswalk = pgTable("ward_crosswalk", {
  wardCode: text("ward_code").primaryKey(),
  boundaryId: integer("boundary_id").notNull(),
  method: text("method").notNull(), // auto | manual
  score: real("score"),
  updatedAt: ts("updated_at").defaultNow().notNull(),
});

/** Current state of every facility. */
export const facilities = pgTable(
  "facilities",
  {
    facilityCode: text("facility_code").primaryKey(),
    hfrId: integer("hfr_id"),
    name: text("name").notNull(),
    commonName: text("common_name"),
    facilityType: text("facility_type"),
    zone: text("zone"),
    regionName: text("region_name"),
    districtName: text("district_name"),
    councilName: text("council_name"),
    wardName: text("ward_name"),
    villageName: text("village_name"),
    regionCode: text("region_code"),
    councilCode: text("council_code"),
    wardCode: text("ward_code"),
    ownershipCategory: text("ownership_category"),
    ownershipAuthority: text("ownership_authority"),
    ownershipDetails: text("ownership_details"),
    mohAuthority: text("moh_authority"),
    operatingStatus: text("operating_status"),
    registrationStatus: text("registration_status"),
    dateOpened: text("date_opened"),
    phone: text("phone"),
    website: text("website"),
    nearestFacility: text("nearest_facility"),
    ctcId: text("ctc_id"),
    msdId: text("msd_id"),
    mtuhaId: text("mtuha_id"),
    hfrLat: doublePrecision("hfr_lat"),
    hfrLng: doublePrecision("hfr_lng"),
    geom: geometry("geom", "Point"),
    listHash: text("list_hash"),
    detailHash: text("detail_hash"),
    firstSeen: ts("first_seen").defaultNow().notNull(),
    lastSeen: ts("last_seen").defaultNow().notNull(),
    lastDetailAt: ts("last_detail_at"),
    removedAt: ts("removed_at"),
  },
  (t) => [
    index("facilities_ward_idx").on(t.wardCode),
    index("facilities_council_idx").on(t.councilCode),
    index("facilities_region_idx").on(t.regionCode),
    index("facilities_geom_idx").using("gist", t.geom),
  ],
);

export const facilityServices = pgTable(
  "facility_services",
  {
    id: serial("id").primaryKey(),
    facilityCode: text("facility_code").notNull(),
    category: text("category").notNull(),
    description: text("description").notNull(),
  },
  (t) => [uniqueIndex("facility_services_uq").on(t.facilityCode, t.category, t.description)],
);

/** Full copy of a facility each time its detail page is fetched. */
export const facilitySnapshots = pgTable(
  "facility_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: integer("run_id").notNull(),
    facilityCode: text("facility_code").notNull(),
    data: jsonb("data").notNull(),
    hash: text("hash").notNull(),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [index("facility_snapshots_code_idx").on(t.facilityCode)],
);

/** What changed in each run. change_type: new | updated | closed | reopened | removed */
export const facilityChanges = pgTable(
  "facility_changes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: integer("run_id").notNull(),
    facilityCode: text("facility_code").notNull(),
    changeType: text("change_type").notNull(),
    fieldDiffs: jsonb("field_diffs"),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [index("facility_changes_run_idx").on(t.runId), index("facility_changes_code_idx").on(t.facilityCode)],
);

/** Rows seen in this run's list sweeps (staging for the diff). */
export const listRows = pgTable(
  "list_rows",
  {
    runId: integer("run_id").notNull(),
    facilityCode: text("facility_code").notNull(),
    hfrId: integer("hfr_id"),
    data: jsonb("data").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.facilityCode] })],
);

/** Ward assignment seen in this run's ward sweep. */
export const wardRows = pgTable(
  "ward_rows",
  {
    runId: integer("run_id").notNull(),
    facilityCode: text("facility_code").notNull(),
    wardCode: text("ward_code").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.facilityCode] })],
);

/** Result of the location checks for each facility. */
export const geoValidation = pgTable(
  "geo_validation",
  {
    facilityCode: text("facility_code").primaryKey(),
    hasBoundary: boolean("has_boundary"),
    inWard: boolean("in_ward"),
    inCouncil: boolean("in_council"),
    distanceToWardM: doublePrecision("distance_to_ward_m"),
    sanityFlags: text("sanity_flags").array(),
    matchSource: text("match_source"), // osm | google | none
    matchedName: text("matched_name"), // OSM names only (Google content is not stored)
    nameScore: real("name_score"),
    matchDistanceM: doublePrecision("match_distance_m"),
    osmId: text("osm_id"),
    googlePlaceId: text("google_place_id"),
    googleCheckedAt: ts("google_checked_at"),
    geocodeSource: text("geocode_source"), // hfr | osm_match | google_match | nominatim | google_geocode | ward_centroid | review
    finalLat: doublePrecision("final_lat"),
    finalLng: doublePrecision("final_lng"),
    confidence: text("confidence"), // high | medium | low
    notes: text("notes"),
    checkedAt: ts("checked_at").defaultNow().notNull(),
  },
  (t) => [index("geo_validation_conf_idx").on(t.confidence)],
);

/** Reviewer decisions from the dashboard. Never overwritten by automatic runs. */
export const reviewDecisions = pgTable("review_decisions", {
  facilityCode: text("facility_code").primaryKey(),
  decision: text("decision").notNull(), // accept_hfr | accept_corrected | manual
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  note: text("note"),
  reviewer: text("reviewer"),
  decidedAt: ts("decided_at").defaultNow().notNull(),
});

/** One row per pipeline run. kind: full | pilot | weekly | validate */
export const jobRuns = pgTable("job_runs", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("running"), // running | done | failed | cancelled
  phase: text("phase"),
  params: jsonb("params").$type<Record<string, unknown>>().default({}).notNull(),
  counts: jsonb("counts").$type<Record<string, unknown>>().default({}).notNull(),
  error: text("error"),
  startedAt: ts("started_at").defaultNow().notNull(),
  finishedAt: ts("finished_at"),
  heartbeatAt: ts("heartbeat_at"),
});

export const jobTasks = pgTable(
  "job_tasks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: integer("run_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    status: text("status").notNull().default("pending"), // pending | running | done | failed
    priority: integer("priority").notNull().default(100),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("job_tasks_claim_idx").on(t.status, t.priority, t.id),
    index("job_tasks_run_idx").on(t.runId, t.status),
  ],
);

/** Single-row lease so only one runner works at a time. */
export const runnerLease = pgTable("runner_lease", {
  id: integer("id").primaryKey(),
  holder: text("holder"),
  expiresAt: ts("expires_at"),
});

export const weeklyReports = pgTable("weekly_reports", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").notNull().unique(),
  summaryMd: text("summary_md"),
  anomalies: jsonb("anomalies"),
  reviewList: jsonb("review_list"),
  digest: jsonb("digest"),
  model: text("model"),
  verified: boolean("verified").notNull().default(false),
  verification: jsonb("verification"),
  createdAt: ts("created_at").defaultNow().notNull(),
  emailedAt: ts("emailed_at"),
});

export const apiUsage = pgTable(
  "api_usage",
  {
    provider: text("provider").notNull(), // google_places | google_geocode | nominatim | overpass | gemini
    month: text("month").notNull(), // YYYY-MM
    calls: integer("calls").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.provider, t.month] })],
);

/** Cached OpenStreetMap health places per council. */
export const osmCache = pgTable("osm_cache", {
  key: text("key").primaryKey(),
  data: jsonb("data").notNull(),
  fetchedAt: ts("fetched_at").defaultNow().notNull(),
});
