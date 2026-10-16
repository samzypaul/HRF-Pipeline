import type { Filters } from "@/lib/data";

/** Plain GET form so filters live in the URL (shareable, works without JS). */
export function FilterBar({
  filters,
  regions,
  types,
  showIssue = false,
  extra,
}: {
  filters: Filters;
  regions: { code: string; name: string }[];
  types: string[];
  showIssue?: boolean;
  extra?: React.ReactNode;
}) {
  return (
    <form className="card mb-4 flex flex-wrap items-end gap-3" method="get">
      <label className="flex flex-col gap-1 text-xs text-muted">
        Search
        <input className="input w-56" name="q" defaultValue={filters.q} placeholder="Name or facility code" />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Region
        <select className="input" name="region" defaultValue={filters.region ?? ""}>
          <option value="">All regions</option>
          {regions.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Facility type
        <select className="input max-w-56" name="type" defaultValue={filters.type ?? ""}>
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Confidence
        <select className="input" name="confidence" defaultValue={filters.confidence ?? ""}>
          <option value="">Any</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="unchecked">Not checked yet</option>
        </select>
      </label>
      {showIssue && (
        <label className="flex flex-col gap-1 text-xs text-muted">
          Issue
          <select className="input" name="issue" defaultValue={filters.issue ?? ""}>
            <option value="">Any</option>
            <option value="needs_review">Needs review (not high confidence)</option>
            <option value="pending_approval">Corrected point awaiting approval</option>
            <option value="outside_ward">Outside its ward</option>
            <option value="missing_coords">Missing or unusable coordinates</option>
            <option value="no_match">No name match (OSM / Google)</option>
            <option value="shared_point">Shares coordinates with another facility</option>
            <option value="no_ward">No ward assigned</option>
            <option value="low">Low confidence</option>
          </select>
        </label>
      )}
      {extra}
      <button className="btn btn-primary" type="submit">
        Apply
      </button>
    </form>
  );
}
