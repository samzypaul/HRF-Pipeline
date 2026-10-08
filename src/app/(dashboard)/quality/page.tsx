import Link from "next/link";
import { FilterBar } from "@/components/Filters";
import { ConfidenceBadge, PageHeader, Pagination, fmt } from "@/components/ui";
import { filterOptions, listFacilities, readFilters } from "@/lib/data";
import { reviewAction } from "../actions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function QualityPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const filters = readFilters(sp);
  if (!filters.issue && !filters.confidence && !filters.q) filters.issue = "outside_ward";
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const [{ rows, total }, { regions, types }] = await Promise.all([listFacilities(filters, page, PAGE_SIZE), filterOptions()]);
  const exportQuery = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]).toString();

  return (
    <div>
      <PageHeader title="Data quality review">
        <a className="btn" href={`/api/export?${exportQuery}`}>
          Download CSV
        </a>
      </PageHeader>
      <FilterBar filters={filters} regions={regions} types={types} showIssue />

      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead>
            <tr>
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
                <td colSpan={5} className="py-8 text-center text-muted">
                  Nothing matches these filters.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.facility_code}>
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
                      {r.final_lat != null && r.geocode_source !== "hfr" && (
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
