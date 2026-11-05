import Link from "next/link";
import { sql } from "drizzle-orm";
import { CONF_COLOR, CardHeader, Empty, PageHeader, Stat, StackedBar, fmt, pct } from "@/components/ui";
import { q } from "@/lib/db/client";
import { councilsOf, filterOptions, readFilters, type Filters } from "@/lib/data";
import { DIMENSIONS, MAX_ROWS, gradeDistribution, isDimension, sharingTotals, type DimensionKey, type DistributionRow } from "@/lib/quality-distribution";

export const dynamic = "force-dynamic";

const GRADES = [
  { key: "high", label: "High" },
  { key: "medium", label: "Medium" },
  { key: "low", label: "Low" },
  { key: "unchecked", label: "Not checked" },
] as const;

/** The filter on the Review tab that matches a dimension (only these can be opened as a list). */
const LIST_FILTER: Partial<Record<DimensionKey, keyof Filters>> = { type: "type", region: "region", council: "council", ward: "ward" };

function href(path: string, params: Record<string, string | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, v);
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}

export default async function DistributionPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const filters = readFilters(sp);
  const scope = { region: filters.region, council: filters.council, ward: filters.ward, type: filters.type };
  // Default split goes one level down from the narrowest area chosen.
  const fallback: DimensionKey = filters.council || filters.ward ? "ward" : filters.region ? "council" : "region";
  const by: DimensionKey = isDimension(sp.by) && sp.by !== "type" ? sp.by : fallback;

  const [{ regions, types }, councils, byType, byDim, names, sharing] = await Promise.all([
    filterOptions(),
    filters.region ? councilsOf(filters.region) : Promise.resolve([]),
    gradeDistribution("type", filters),
    gradeDistribution(by, filters),
    q<{ code: string; name: string }>(sql`SELECT code, name FROM admin_units WHERE code = ANY(${sql.param([filters.region, filters.council, filters.ward].filter(Boolean) as string[])}::text[])`),
    sharingTotals(filters),
  ]);
  const nameOf = (code?: string) => names.find((n) => n.code === code)?.name ?? code;

  const totals = byType.rows.reduce(
    (a, r) => ({ high: a.high + r.high, medium: a.medium + r.medium, low: a.low + r.low, unchecked: a.unchecked + r.unchecked, total: a.total + r.total }),
    { high: 0, medium: 0, low: 0, unchecked: 0, total: 0 },
  );
  const narrowed = [
    filters.region && `Region ${nameOf(filters.region)}`,
    filters.council && `Council ${nameOf(filters.council)}`,
    filters.ward && `Ward ${nameOf(filters.ward)}`,
    filters.type && `Type ${filters.type}`,
  ].filter(Boolean) as string[];

  /** A count that opens the Review tab on exactly those facilities. */
  const cell = (n: number, dim: DimensionKey, row: DistributionRow, grade?: string) => {
    const f = LIST_FILTER[dim];
    if (!f || row.key == null || n === 0) return fmt(n);
    return (
      <Link className="link" href={href("/quality", { ...scope, [f]: row.key, confidence: grade, issue: "" })}>
        {fmt(n)}
      </Link>
    );
  };

  /** Clicking a region or council narrows to it and splits by the next level. */
  const drill = (dim: DimensionKey, row: DistributionRow) => {
    const label = row.label ?? "(not recorded)";
    if (row.key == null) return <span className="text-muted">{label}</span>;
    if (dim === "region") return <Link className="link" href={href("/quality/distribution", { ...scope, region: row.key, council: undefined, ward: undefined, by: "council" })}>{label}</Link>;
    if (dim === "council") return <Link className="link" href={href("/quality/distribution", { ...scope, council: row.key, ward: undefined, by: "ward" })}>{label}</Link>;
    return <>{label}</>;
  };

  const table = (dim: DimensionKey, rows: DistributionRow[], groups: number) => (
    <div className="card overflow-x-auto p-0">
      <table className="table">
        <thead>
          <tr>
            <th>{DIMENSIONS[dim].label}</th>
            {GRADES.map((g) => (
              <th key={g.key} className="text-right">
                {g.label}
              </th>
            ))}
            <th className="text-right">Total</th>
            <th className="text-right">% high</th>
            <th className="w-48">Spread</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={8}>
                <Empty title="No facilities match.">Reset the filters above.</Empty>
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={`${r.key}|${r.label}|${r.sub}`}>
              <td>
                {drill(dim, r)}
                {r.sub && <div className="text-xs text-muted">{r.sub}</div>}
              </td>
              {GRADES.map((g) => (
                <td key={g.key} className="text-right tabular-nums">
                  {cell(r[g.key], dim, r, g.key)}
                </td>
              ))}
              <td className="text-right font-medium tabular-nums">{cell(r.total, dim, r)}</td>
              <td className="text-right tabular-nums text-muted">{pct(r.high, r.total)}</td>
              <td>
                <StackedBar segments={GRADES.map((g) => ({ key: g.key, label: g.label, value: r[g.key], color: CONF_COLOR[g.key] }))} />
              </td>
            </tr>
          ))}
        </tbody>
        {rows.length > 1 && groups <= MAX_ROWS && (
          <tfoot>
            <tr className="font-medium">
              <td>All shown</td>
              {GRADES.map((g) => (
                <td key={g.key} className="text-right tabular-nums">
                  {fmt(rows.reduce((a, r) => a + r[g.key], 0))}
                </td>
              ))}
              <td className="text-right tabular-nums">{fmt(rows.reduce((a, r) => a + r.total, 0))}</td>
              <td />
              <td />
            </tr>
          </tfoot>
        )}
      </table>
      {groups > MAX_ROWS && (
        <p className="border-t border-line px-4 py-2 text-xs text-muted">
          Showing the {fmt(MAX_ROWS)} largest of {fmt(groups)} groups. Choose a region or council above to see the rest.
        </p>
      )}
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Data quality distribution"
        subtitle="How many facilities have a high, medium or low confidence location, split by facility type, area, ownership and service."
      />

      <form className="card mb-5 flex flex-wrap items-end gap-3 p-4" method="get">
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
          Council
          <select className="input max-w-56" name="council" defaultValue={filters.council ?? ""} disabled={!filters.region}>
            <option value="">{filters.region ? "All councils" : "Choose a region first"}</option>
            {councils.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
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
          Split the second table by
          <select className="input" name="by" defaultValue={by}>
            {(Object.keys(DIMENSIONS) as DimensionKey[])
              .filter((k) => k !== "type")
              .map((k) => (
                <option key={k} value={k}>
                  {DIMENSIONS[k].label}
                </option>
              ))}
          </select>
        </label>
        {filters.ward && <input type="hidden" name="ward" value={filters.ward} />}
        <button className="btn btn-primary" type="submit">
          Apply
        </button>
        <a className="btn border-transparent bg-transparent shadow-none" href="/quality/distribution">
          Reset
        </a>
        {narrowed.length > 0 && <p className="w-full text-xs text-muted">Showing: {narrowed.join(" · ")}</p>}
      </form>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Facilities" value={fmt(totals.total)} />
        {GRADES.map((g) => (
          <Stat key={g.key} label={g.label} value={fmt(totals[g.key])} hint={`${pct(totals[g.key], totals.total)} of facilities`} />
        ))}
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Same HFR coordinates" value={fmt(sharing.hfrShared)} hint={`${pct(sharing.hfrShared, totals.total)} of facilities · portal point shared, before geocoding`} />
        <Stat label="Still sharing a point" value={fmt(sharing.afterGeocoding)} hint={`${pct(sharing.afterGeocoding, totals.total)} of facilities · after geocoding, hidden from the climate API`} />
        <Stat label="Shared stand-in centre" value={fmt(sharing.standIn)} hint="village, ward or council centre used on purpose" />
        <div className="flex items-center gap-3 text-sm">
          <Link className="link" href={href("/quality", { ...scope, issue: "shared_point" })}>List same HFR coordinates</Link>
          <Link className="link" href={href("/quality", { ...scope, issue: "shared_after_geocoding" })}>List still sharing</Link>
        </div>
      </div>

      <section className="mb-8">
        <CardHeader title="Grade by facility type" hint="How many facilities of each type sit in each grade. Click a number to open those facilities on the Review tab." />
        {table("type", byType.rows, byType.groups)}
      </section>

      <section>
        <CardHeader
          title={`Grade by ${DIMENSIONS[by].label.toLowerCase()}`}
          hint={
            by === "service"
              ? "A facility is counted once in every service category it offers, so the rows add up to more than the number of facilities."
              : by === "region" || by === "council"
                ? "Click a name to narrow to it and see the next level down (region, then council, then ward)."
                : "Narrow by region, council or facility type above to shorten the list."
          }
        />
        {table(by, byDim.rows, byDim.groups)}
      </section>
    </div>
  );
}
