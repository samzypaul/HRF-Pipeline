import { sql } from "drizzle-orm";
import { q } from "@/lib/db/client";
import { FilterBar } from "@/components/Filters";
import { CardHeader, PageHeader, fmt } from "@/components/ui";
import { climatePredicate, filterOptions, listFacilities, readFilters, whereFor } from "@/lib/data";
import { SERVICES } from "@/lib/climate/catalogue";

export const dynamic = "force-dynamic";

const SHEETS = [
  { sheet: "facilities", label: "Facilities", note: "one row per facility with its climate-sensitive services" },
  { sheet: "facility_services", label: "Facility services", note: "one row per facility and service, in English and Kiswahili" },
  { sheet: "service_lookup", label: "Service lookup", note: "every service with names, descriptions, tier and rationale" },
  { sheet: "exclusions", label: "Exclusions", note: "facilities left out, and why" },
  { sheet: "data_quality", label: "Data quality", note: "issues found and how they were handled" },
];

export default async function ExportPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const filters = readFilters(sp);
  const [{ total }, { regions, types }] = await Promise.all([listFacilities(filters, 1, 1), filterOptions()]);
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]).toString();

  // The climate dataset: the filters, minus the climate choice (which only narrows the services), then the climate-sensitive checks.
  const operatingOnly = sp.operating !== "0";
  const locatedOnly = sp.located !== "0";
  const [climate] = await q<{ included: number; no_service: number; closed: number }>(sql`
    SELECT count(*) FILTER (WHERE ${climatePredicate(filters.climate?.startsWith("svc:") || filters.climate?.startsWith("tier:") ? filters.climate : "any")}
                              AND ${operatingOnly ? sql`f.operating_status ILIKE 'operating'` : sql`true`}
                              AND ${locatedOnly ? sql`coalesce(g.final_lat, f.hfr_lat) IS NOT NULL` : sql`true`})::int included,
           count(*) FILTER (WHERE NOT ${climatePredicate("any")})::int no_service,
           count(*) FILTER (WHERE NOT (f.operating_status ILIKE 'operating'))::int closed
    FROM facilities f LEFT JOIN geo_validation g ON g.facility_code = f.facility_code
    WHERE ${whereFor({ ...filters, climate: undefined })}`);

  return (
    <div className="space-y-6">
      <PageHeader title="Export" subtitle="Download the registry, or the climate-sensitive facilities for the El Niño app." />
      <FilterBar filters={filters} regions={regions} types={types} showIssue />

      <div className="card">
        <CardHeader title="Registry files" hint={`${fmt(total)} facilities match these filters.`} />
        <div className="flex flex-wrap gap-2">
          <a className="btn btn-primary" href={`/api/export?format=csv&${query}`}>
            Facilities CSV
          </a>
          <a className="btn" href={`/api/export?format=geojson&${query}`}>
            Facilities GeoJSON
          </a>
          <a className="btn" href={`/api/export?table=services&${query}`}>
            Services CSV
          </a>
          <a className="btn" href={`/api/export?table=validation&${query}`}>
            Validation CSV
          </a>
        </div>
        <p className="mt-3 text-xs text-muted">
          <strong>Services</strong> has one row per facility service. <strong>Validation</strong> has the geo-check results only. The facilities files include the
          original HFR coordinates and the corrected point side by side, with the confidence grade, ward check and any reviewer decision, so registry errors can
          be reported back to the Ministry of Health. The <strong>Climate-sensitive services</strong> filter above narrows any of these to facilities that offer
          the chosen services.
        </p>
      </div>

      <form className="card" method="get" action="/api/export/climate">
        {(["region", "council", "confidence", "type", "q", "issue", "climate"] as const).map((k) => (filters[k] ? <input key={k} type="hidden" name={k} value={filters[k]} /> : null))}
        <CardHeader
          title="Climate-sensitive facility dataset"
          hint="For the El Niño climate-adapted health facility app: facilities offering climate-sensitive services, each service in English and Kiswahili, five CSV sheets."
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg bg-brand-soft/60 p-3">
            <div className="eyebrow">In the dataset</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{fmt(climate?.included ?? 0)}</div>
            <div className="text-xs text-muted">
              {filters.climate?.startsWith("svc:") || filters.climate?.startsWith("tier:") ? "offer the chosen services" : `offer at least one of ${SERVICES.length} services`}
            </div>
          </div>
          <div className="rounded-lg bg-canvas p-3">
            <div className="eyebrow">No climate-sensitive service</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{fmt(climate?.no_service ?? 0)}</div>
            <div className="text-xs text-muted">of the facilities matching the other filters</div>
          </div>
          <div className="rounded-lg bg-canvas p-3">
            <div className="eyebrow">Not operating</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{fmt(climate?.closed ?? 0)}</div>
            <div className="text-xs text-muted">closed, non-operational or unknown status</div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="hidden" name="operating" value="0" />
            <input type="checkbox" name="operating" value="1" defaultChecked={operatingOnly} />
            Only operating facilities
          </label>
          <label className="flex items-center gap-2">
            <input type="hidden" name="located" value="0" />
            <input type="checkbox" name="located" value="1" defaultChecked={locatedOnly} />
            Only facilities with a location
          </label>
        </div>
        <p className="mt-1 text-xs text-muted">
          Unticked boxes keep those facilities in the files; the Exclusions sheet always lists what is left out under the ticked ones. Choose a tier or services in
          &ldquo;Climate-sensitive services&rdquo; above to export only those.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {SHEETS.map((s, i) => (
            <button key={s.sheet} className={`btn ${i === 0 ? "btn-primary" : ""}`} name="sheet" value={s.sheet} title={s.note}>
              {s.label} CSV
            </button>
          ))}
        </div>
        <ul className="mt-3 grid gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-2">
          {SHEETS.map((s) => (
            <li key={s.sheet}>
              <strong className="text-ink">{s.label}:</strong> {s.note}
            </li>
          ))}
        </ul>
      </form>
    </div>
  );
}
