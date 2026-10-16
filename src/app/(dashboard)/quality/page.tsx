import Link from "next/link";
import { FilterBar } from "@/components/Filters";
import { ConfidenceBadge, PageHeader, Pagination, fmt } from "@/components/ui";
import { filterOptions, listFacilities, readFilters } from "@/lib/data";
import { bulkReviewAction, reviewAction, startImproveAction } from "../actions";
import SelectAll from "./SelectAll";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function QualityPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const filters = readFilters(sp);
  // Default view only on a bare visit; choosing "Any" in the form must stay "Any".
  if (!("issue" in sp) && !filters.confidence && !filters.q) filters.issue = "needs_review";
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const [{ rows, total }, { regions, types }] = await Promise.all([listFacilities(filters, page, PAGE_SIZE), filterOptions()]);
  const done = sp.done != null ? Number(sp.done) : null;
  const skipped = Number(sp.skipped ?? 0);
  const exportQuery = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]).toString();

  return (
    <div>
      <PageHeader title="Data quality review">
        <form action={startImproveAction}>
          <button className="btn btn-primary" title="Re-checks weak locations and keeps geocoding until every facility has a point">
            Improve data quality
          </button>
        </form>
        <a className="btn" href={`/api/export?${exportQuery}`}>
          Download CSV
        </a>
      </PageHeader>
      <FilterBar filters={filters} regions={regions} types={types} showIssue />

      {done != null && Number.isFinite(done) && (
        <div className="card mb-3 border-brand text-sm">
          Applied to {fmt(done)} {done === 1 ? "facility" : "facilities"}
          {skipped > 0 && <>; {fmt(skipped)} skipped (already decided, or no point to apply)</>}.
        </div>
      )}

      <form id="bulk" action={bulkReviewAction} className="card mb-3 flex flex-wrap items-end gap-3 text-sm">
        {(["region", "council", "confidence", "type", "q", "issue"] as const).map((k) => (filters[k] ? <input key={k} type="hidden" name={k} value={filters[k]} /> : null))}
        <label className="flex flex-col gap-1 text-xs text-muted">
          Apply to several facilities at once
          <select className="input" name="decision" defaultValue="accept_corrected">
            <option value="accept_corrected">Use the corrected point</option>
            <option value="accept_hfr">Keep the HFR point</option>
          </select>
        </label>
        <button className="btn btn-primary" name="scope" value="selected">
          Apply to ticked rows
        </button>
        <span className="flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1">
            <input type="checkbox" name="confirmAll" /> I understand
          </label>
          <button className="btn" name="scope" value="all">
            Apply to all {fmt(total)} matching the filters
          </button>
        </span>
        <p className="w-full text-xs text-muted">
          Only facilities without a decision are changed. “Use the corrected point” skips rows that have no corrected point awaiting approval; the filter
          “Corrected point awaiting approval” shows exactly those.
        </p>
      </form>

      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead>
            <tr>
              <th className="w-8">
                <SelectAll />
              </th>
              <th>Facility</th>
              <th>Location (council / ward)</th>
              <th>Check result</th>
              <th>HFR point → corrected point</th>
              <th className="w-72">Decision</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-muted">
                  Nothing matches these filters.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.facility_code}>
                <td>
                  {!r.decision && <input type="checkbox" name="codes" form="bulk" value={r.facility_code} aria-label={`Select ${r.name}`} />}
                </td>
                <td>
                  <Link className="font-medium text-brand hover:underline" href={`/facility/${r.facility_code}`}>
                    {r.name}
                  </Link>
                  <div className="text-xs text-muted">
                    {r.facility_code} · {r.facility_type}
                  </div>
                </td>
                <td className="text-xs">
                  {r.council_name ?? "—"}
                  <div className="text-muted">{r.ward_name ?? "no ward"}</div>
                </td>
                <td className="text-xs">
                  <ConfidenceBadge value={r.confidence} />
                  <div className="mt-1 text-muted">
                    {r.in_ward === false && <>Outside ward by {fmt(Math.round(r.distance_to_ward_m ?? 0))} m. </>}
                    {r.match_source && r.match_source !== "none" && <>Name match: {r.match_source} ({r.name_score}). </>}
                  </div>
                  {r.notes && <div className="mt-1 max-w-xs text-muted">{r.notes}</div>}
                </td>
                <td className="text-xs tabular-nums">
                  {r.hfr_lat != null ? `${r.hfr_lat.toFixed(5)}, ${r.hfr_lng?.toFixed(5)}` : "none"}
                  {r.final_lat != null && (r.final_lat !== r.hfr_lat || r.final_lng !== r.hfr_lng) && (
                    <div className="text-brand">
                      → {r.final_lat.toFixed(5)}, {r.final_lng?.toFixed(5)} ({r.geocode_source})
                    </div>
                  )}
                  {r.final_lat != null && (
                    <a
                      className="ml-1 text-muted underline"
                      target="_blank"
                      rel="noreferrer"
                      href={`https://www.openstreetmap.org/?mlat=${r.final_lat}&mlon=${r.final_lng}#map=16/${r.final_lat}/${r.final_lng}`}
                    >
                      view
                    </a>
                  )}
                </td>
                <td>
                  {r.decision ? (
                    <form action={reviewAction} className="text-xs">
                      <input type="hidden" name="code" value={r.facility_code} />
                      <span className="badge bg-brand-soft text-brand">{r.decision.replace("_", " ")}</span>
                      <button className="ml-2 underline" name="decision" value="clear">
                        undo
                      </button>
                    </form>
                  ) : (
                    <form action={reviewAction} className="flex flex-wrap items-center gap-1 text-xs">
                      <input type="hidden" name="code" value={r.facility_code} />
                      {r.hfr_lat != null && (
                        <button className="btn px-2 py-1 text-xs" name="decision" value="accept_hfr">
                          HFR is right
                        </button>
                      )}
                      {r.final_lat != null && (r.geocode_source !== "hfr" || r.final_lat !== r.hfr_lat || r.final_lng !== r.hfr_lng) && (
                        <button className="btn px-2 py-1 text-xs" name="decision" value="accept_corrected">
                          Use corrected
                        </button>
                      )}
                      <details className="w-full">
                        <summary className="cursor-pointer text-muted">Set manually</summary>
                        <div className="mt-1 flex gap-1">
                          <input className="input w-24 text-xs" name="lat" placeholder="lat" />
                          <input className="input w-24 text-xs" name="lng" placeholder="lng" />
                          <button className="btn px-2 py-1 text-xs" name="decision" value="manual">
                            Save
                          </button>
                        </div>
                      </details>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} pageSize={PAGE_SIZE} total={total} params={{ ...filters }} />
    </div>
  );
}
