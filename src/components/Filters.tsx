import type { Filters } from "@/lib/data";
import { SERVICES, TIERS, type Tier } from "@/lib/climate/catalogue";

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
    <form className="card mb-5 flex flex-wrap items-end gap-3 p-4" method="get">
      <label className="flex flex-col gap-1.5 text-xs font-medium text-muted">
        Search
        <input className="input w-56" name="q" defaultValue={filters.q} placeholder="Name or facility code" />
      </label>
      <label className="flex flex-col gap-1.5 text-xs font-medium text-muted">
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
      <label className="flex flex-col gap-1.5 text-xs font-medium text-muted">
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
      <label className="flex flex-col gap-1.5 text-xs font-medium text-muted">
        Confidence
        <select className="input" name="confidence" defaultValue={filters.confidence ?? ""}>
          <option value="">Any</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="unchecked">Not checked yet</option>
        </select>
      </label>
      <label className="flex flex-col gap-1.5 text-xs font-medium text-muted">
        Climate-sensitive services
        <select className="input max-w-64" name="climate" defaultValue={filters.climate ?? ""}>
          <option value="">Any facility</option>
          <option value="any">Offers at least one</option>
          <option value="none">Offers none</option>
          {([1, 2, 3, 4, 5] as Tier[]).map((t) => (
            <optgroup key={t} label={`Tier ${t}: ${TIERS[t].en}`}>
              <option value={`tier:${t}`}>All of tier {t}</option>
              {SERVICES.filter((x) => x.tier === t).map((x) => (
                <option key={x.code} value={`svc:${x.code}`}>
                  {x.name} ({x.category})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {showIssue && (
        <label className="flex flex-col gap-1.5 text-xs font-medium text-muted">
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
            <option value="outside_village">Outside its HFR village</option>
            <option value="village_fix">Placed in its village (geocoded or village centre)</option>
            <option value="low">Low confidence</option>
            <option value="satellite_review">Satellite: no building seen or unclear</option>
          </select>
        </label>
      )}
      {extra}
      <button className="btn btn-primary" type="submit">
        Apply
      </button>
      <a className="btn border-transparent bg-transparent shadow-none" href="?">
        Reset
      </a>
    </form>
  );
}
