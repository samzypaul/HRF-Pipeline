import { FilterBar } from "@/components/Filters";
import { PageHeader } from "@/components/ui";
import { filterOptions, readFilters } from "@/lib/data";
import MapClient from "./MapClient";

export const dynamic = "force-dynamic";

export default async function MapPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const filters = readFilters(sp);
  const { regions, types } = await filterOptions();
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]).toString();
  return (
    <div>
      <PageHeader title="Map" />
      <FilterBar filters={filters} regions={regions} types={types} showIssue />
      <MapClient query={query} />
      <p className="mt-2 text-xs text-muted">
        Points show the corrected location when one exists, otherwise the HFR coordinates. Click a point to see its name, ward, council and region.
      </p>
    </div>
  );
}
