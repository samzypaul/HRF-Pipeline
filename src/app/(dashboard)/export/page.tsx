import { FilterBar } from "@/components/Filters";
import { PageHeader, fmt } from "@/components/ui";
import { filterOptions, listFacilities, readFilters } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function ExportPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const filters = readFilters(await searchParams);
  const [{ total }, { regions, types }] = await Promise.all([listFacilities(filters, 1, 1), filterOptions()]);
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]).toString();
  return (
    <div>
      <PageHeader title="Export" />
      <FilterBar filters={filters} regions={regions} types={types} showIssue />
      <div className="card">
        <p className="text-sm">
          <strong>{fmt(total)}</strong> facilities match these filters.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a className="btn btn-primary" href={`/api/export?format=csv&${query}`}>
            Download CSV
          </a>
          <a className="btn" href={`/api/export?format=geojson&${query}`}>
            Download GeoJSON
          </a>
        </div>
        <p className="mt-3 text-xs text-muted">
          Both files include the original HFR coordinates and the corrected point side by side, with the confidence grade, ward
          check and any reviewer decision, so registry errors can be reported back to the Ministry of Health.
        </p>
      </div>
    </div>
  );
}
