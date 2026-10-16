import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { env } from "../env";
import { HfrClient, LIST_PAGE_SIZE } from "../hfr/client";
import { parseAdminJson, parseCoords, parseDetail, parseListPage, parseRegions, parseServices } from "../hfr/parse";
import { DETAIL_FIELDS, diffFields, listData, listHash } from "../diff/fields";
import { hashOf } from "../util";
import { validateFacilities } from "../geo/validate";
import { generateDailyReport } from "../ai/report";
import { enqueue, incrementCounts, mergeCounts, type RunRow, type TaskRow } from "./queue";

export interface TaskContext {
  hfr: HfrClient;
  run: RunRow;
}

type Handler = (task: TaskRow, ctx: TaskContext) => Promise<void>;

const LEVEL_PRIORITY = { 2: 10, 3: 11, 4: 12 } as const;

async function upsertAdmin(level: number, parent: string | null, items: { code: string; name: string }[]) {
  for (const it of items) {
    await q(sql`
      INSERT INTO admin_units (code, level, name, parent_code, updated_at)
      VALUES (${it.code}, ${level}, ${it.name}, ${parent}, now())
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, level = EXCLUDED.level,
        parent_code = EXCLUDED.parent_code, updated_at = now()`);
  }
}

// ---- Admin tree --------------------------------------------------------------

const adminRegions: Handler = async (task, { hfr, run }) => {
  const regions = parseRegions(await hfr.advancedSearch());
  if (regions.length === 0) throw new Error("No regions found on the advanced-search page");
  await upsertAdmin(1, null, regions);
  const only = run.params.region as string | undefined;
  const scope = only ? regions.filter((r) => r.code === only) : regions;
  await enqueue(run.id, "admin_children", scope.map((r) => ({ level: 2, parent: r.code })), LEVEL_PRIORITY[2]);
  await mergeCounts(run.id, { regions: regions.length });
};

const adminChildren: Handler = async (task, { hfr, run }) => {
  const level = Number(task.payload.level) as 2 | 3 | 4;
  const parent = String(task.payload.parent);
  const items = parseAdminJson(await hfr.adminChildren(level, parent));
  await upsertAdmin(level, parent, items);
  if (level < 4 && items.length) {
    const next = (level + 1) as 3 | 4;
    await enqueue(run.id, "admin_children", items.map((i) => ({ level: next, parent: i.code })), LEVEL_PRIORITY[next]);
  }
  await incrementCounts(run.id, { [`adminLevel${level}`]: items.length });
};

// ---- List sweeps ---------------------------------------------------------------

async function storeListRows(runId: number, rows: ReturnType<typeof parseListPage>["rows"]) {
  if (!rows.length) return;
  await q(sql`
    INSERT INTO list_rows (run_id, facility_code, hfr_id, data, hash)
    VALUES ${sql.join(
      rows.map((r) => {
        const d = listData(r);
        return sql`(${runId}, ${r.facilityCode}, ${r.hfrId}, ${JSON.stringify(d)}::jsonb, ${listHash(d)})`;
      }),
      sql`, `,
    )}
    ON CONFLICT (run_id, facility_code) DO UPDATE SET data = EXCLUDED.data, hash = EXCLUDED.hash, hfr_id = EXCLUDED.hfr_id`);
}

/** National (or one-region) list, 50 rows per page. Page 1 schedules the rest. */
const listPage: Handler = async (task, { hfr, run }) => {
  const page = Number(task.payload.page ?? 1);
  const region = (task.payload.region as string | undefined) ?? undefined;
  const parsed = parseListPage(await hfr.listPage({ page, region }));
  await storeListRows(run.id, parsed.rows);
  if (page === 1) {
    const pages = Math.ceil(parsed.total / LIST_PAGE_SIZE);
    await mergeCounts(run.id, { listTotal: parsed.total, listPages: pages });
    if (pages > 1) {
      await enqueue(
        run.id,
        "list_page",
        Array.from({ length: pages - 1 }, (_, i) => ({ page: i + 2, region })),
        20,
      );
    }
  }
  await incrementCounts(run.id, { listRows: parsed.rows.length });
};

/** Facilities of one ward → ward assignment. */
const wardList: Handler = async (task, { hfr, run }) => {
  const ward = String(task.payload.ward);
  const page = Number(task.payload.page ?? 1);
  const parsed = parseListPage(await hfr.listPage({ page, ward }));
  if (parsed.rows.length) {
    await q(sql`
      INSERT INTO ward_rows (run_id, facility_code, ward_code)
      VALUES ${sql.join(parsed.rows.map((r) => sql`(${run.id}, ${r.facilityCode}, ${ward})`), sql`, `)}
      ON CONFLICT (run_id, facility_code) DO UPDATE SET ward_code = EXCLUDED.ward_code`);
    // Ward lists are also list rows: keeps facilities that the national list missed.
    await storeListRows(run.id, parsed.rows);
  }
  if (page === 1 && parsed.total > LIST_PAGE_SIZE) {
    const pages = Math.ceil(parsed.total / LIST_PAGE_SIZE);
    await enqueue(run.id, "ward_list", Array.from({ length: pages - 1 }, (_, i) => ({ ward, page: i + 2 })), 30);
  }
  await incrementCounts(run.id, { wardRows: parsed.rows.length });
};

// ---- Facility detail -------------------------------------------------------------

const facilityDetail: Handler = async (task, { hfr, run }) => {
  const code = String(task.payload.code);
  const detail = parseDetail(await hfr.detail(code));
  const hfrId = detail.hfrId ?? (task.payload.hfrId as number | null) ?? null;
  const coords = hfrId != null ? parseCoords(await hfr.coords(hfrId)) : null;
  const services = hfrId != null && env.hfrFetchServices ? parseServices(await hfr.services(hfrId)) : null;

  const fields: Record<string, string | number | null> = {
    common_name: detail.commonName,
    date_opened: detail.dateOpened,
    zone: detail.address.zone,
    district_name: detail.address.districtName,
    ward_name: coords?.wardName ?? detail.address.wardName,
    village_name: coords?.villageName ?? detail.address.villageName,
    ownership_details: coords?.ownershipDetails ?? detail.ownership,
    registration_status: coords?.registrationStatus ?? null,
    phone: detail.phone,
    website: detail.website,
    nearest_facility: detail.nearestFacility,
    ctc_id: detail.ctcId,
    msd_id: detail.msdId,
    mtuha_id: detail.mtuhaId,
    hfr_lat: coords?.lat ?? null,
    hfr_lng: coords?.lng ?? null,
  };
  const detailHash = hashOf(fields);

  const [prev] = await q<Record<string, unknown> & { detail_hash: string | null }>(sql`
    SELECT detail_hash, ${sql.raw(DETAIL_FIELDS.join(", "))} FROM facilities WHERE facility_code = ${code}`);
  if (!prev) {
    // Not in the list sweep (should not happen) – create a minimal row.
    await q(sql`INSERT INTO facilities (facility_code, name) VALUES (${code}, ${detail.name ?? code}) ON CONFLICT DO NOTHING`);
  } else if (prev.detail_hash && prev.detail_hash !== detailHash) {
    const diffs = diffFields(prev, fields, [...DETAIL_FIELDS]);
    if (diffs.length) {
      await q(sql`
        INSERT INTO facility_changes (run_id, facility_code, change_type, field_diffs)
        VALUES (${run.id}, ${code}, 'updated', ${JSON.stringify(diffs)}::jsonb)`);
      await incrementCounts(run.id, { detailChanges: 1 });
    }
  }

  const lat = fields.hfr_lat as number | null;
  const lng = fields.hfr_lng as number | null;
  await q(sql`
    UPDATE facilities SET
      hfr_id = coalesce(${hfrId}, hfr_id),
      common_name = ${fields.common_name}, date_opened = ${fields.date_opened}, zone = ${fields.zone},
      district_name = ${fields.district_name}, ward_name = ${fields.ward_name}, village_name = ${fields.village_name},
      ownership_details = ${fields.ownership_details}, registration_status = ${fields.registration_status},
      phone = ${fields.phone}, website = ${fields.website}, nearest_facility = ${fields.nearest_facility},
      ctc_id = ${fields.ctc_id}, msd_id = ${fields.msd_id}, mtuha_id = ${fields.mtuha_id},
      hfr_lat = ${lat}, hfr_lng = ${lng},
      geom = ${lat != null && lng != null ? sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)` : sql`NULL`},
      detail_hash = ${detailHash}, last_detail_at = now()
    WHERE facility_code = ${code}`);

  await q(sql`
    INSERT INTO facility_snapshots (run_id, facility_code, data, hash)
    VALUES (${run.id}, ${code}, ${JSON.stringify({ ...fields, addressRaw: detail.addressRaw, services: services?.length ?? null })}::jsonb, ${detailHash})`);

  if (services) {
    await q(sql`DELETE FROM facility_services WHERE facility_code = ${code}`);
    if (services.length) {
      await q(sql`
        INSERT INTO facility_services (facility_code, category, description)
        VALUES ${sql.join(services.map((s) => sql`(${code}, ${s.category}, ${s.description})`), sql`, `)}
        ON CONFLICT DO NOTHING`);
    }
  }
  await incrementCounts(run.id, { details: 1, coordsMissing: coords?.lat == null ? 1 : 0 });
};

// ---- Validation + report ---------------------------------------------------------

const validateBatch: Handler = async (task, { run }) => {
  const codes = (task.payload.codes as string[]) ?? [];
  const s = await validateFacilities(codes);
  await incrementCounts(run.id, { validated: s.validated, googlePlaces: s.googlePlaces, geocoded: s.geocoded });
};

const dailyReport: Handler = async (task, { run }) => {
  const forRun = Number(task.payload.runId ?? run.id);
  await generateDailyReport(forRun);
};

export const HANDLERS: Record<string, Handler> = {
  admin_regions: adminRegions,
  admin_children: adminChildren,
  list_page: listPage,
  ward_list: wardList,
  facility_detail: facilityDetail,
  validate_batch: validateBatch,
  weekly_report: dailyReport, // task name kept so queued tasks survive the rename
};
