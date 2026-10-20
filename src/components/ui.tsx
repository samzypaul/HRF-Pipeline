import Link from "next/link";

const CONF_STYLE: Record<string, string> = {
  high: "bg-high/10 text-high",
  medium: "bg-medium/15 text-medium",
  low: "bg-low/10 text-low",
  unchecked: "bg-line text-muted",
};

export function ConfidenceBadge({ value }: { value: string | null | undefined }) {
  const v = value ?? "unchecked";
  return <span className={`badge ${CONF_STYLE[v] ?? CONF_STYLE.unchecked}`}>{v}</span>;
}

export function StatusBadge({ value }: { value: string | null | undefined }) {
  const v = value ?? "—";
  const style =
    v === "done" || v === "Operating"
      ? "bg-high/10 text-high"
      : v === "running"
        ? "bg-brand-soft text-brand"
        : v === "failed" || v === "paused" || v === "cancelled"
          ? "bg-low/10 text-low"
          : "bg-line text-muted";
  return <span className={`badge ${style}`}>{v}</span>;
}

export function Stat({ label, value, hint, href }: { label: string; value: React.ReactNode; hint?: string; href?: string }) {
  const body = (
    <div className="card h-full">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
  return href ? (
    <Link href={href} className="block hover:opacity-90">
      {body}
    </Link>
  ) : (
    body
  );
}

export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <h1 className="h1">{title}</h1>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

export function Pagination({ page, pageSize, total, params }: { page: number; pageSize: number; total: number; params: Record<string, string | undefined> }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (p: number) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
    sp.set("page", String(p));
    return `?${sp.toString()}`;
  };
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-muted">
      <span>
        {total.toLocaleString()} facilities · page {page} of {pages}
      </span>
      <div className="flex gap-2">
        {page > 1 && (
          <Link className="btn" href={href(page - 1)}>
            ← Previous
          </Link>
        )}
        {page < pages && (
          <Link className="btn" href={href(page + 1)}>
            Next →
          </Link>
        )}
      </div>
    </div>
  );
}

export const fmt = (n: unknown) => (n == null ? "—" : typeof n === "number" ? n.toLocaleString() : String(n));

export function fmtDate(d: string | Date | null | undefined) {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("en-GB", { timeZone: "Africa/Dar_es_Salaam", dateStyle: "medium", timeStyle: "short" });
}

/** A calendar date (YYYY-MM-DD) as "Tue, 14 Oct 2026". */
export function fmtDay(d: string) {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

/** "6 Oct – 12 Oct 2026" for a week (or a single day when start = end). */
export function fmtPeriod(start: string, end: string) {
  if (start === end) return fmtDay(start);
  const f = (d: string, year: boolean) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) });
  return `${f(start, false)} – ${f(end, true)}`;
}
