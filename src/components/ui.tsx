import Link from "next/link";

const CONF_STYLE: Record<string, string> = {
  high: "bg-high/10 text-high",
  medium: "bg-medium/10 text-medium",
  low: "bg-low/10 text-low",
  unchecked: "bg-line text-muted",
};

export const CONF_COLOR: Record<string, string> = {
  high: "var(--color-high)",
  medium: "var(--color-medium)",
  low: "var(--color-low)",
  unchecked: "var(--color-faint)",
};

export function ConfidenceBadge({ value }: { value: string | null | undefined }) {
  const v = value ?? "unchecked";
  return <span className={`badge badge-dot ${CONF_STYLE[v] ?? CONF_STYLE.unchecked}`}>{v}</span>;
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
  return <span className={`badge badge-dot ${style}`}>{v}</span>;
}

/** A headline number. `progress` (0-100) draws a thin bar under it; `href` makes the whole tile a link. */
export function Stat({
  label,
  value,
  hint,
  href,
  progress,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  href?: string;
  progress?: number;
}) {
  const body = (
    <div className={`card h-full ${href ? "transition-shadow group-hover:shadow-md group-focus-visible:shadow-md" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="eyebrow">{label}</div>
        {href && (
          <span className="text-faint transition-transform group-hover:translate-x-0.5" aria-hidden>
            →
          </span>
        )}
      </div>
      <div className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">{value}</div>
      {progress != null && (
        <div className="progress mt-3" role="img" aria-label={`${Math.round(progress)} percent`}>
          <span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
        </div>
      )}
      {hint && <div className="mt-2 text-xs text-muted">{hint}</div>}
    </div>
  );
  return href ? (
    <Link href={href} className="group block rounded-xl">
      {body}
    </Link>
  ) : (
    body
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="h1">{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** A section title with an optional right-hand slot, for the top of a card. */
export function CardHeader({ title, hint, children }: { title: string; hint?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div>
        <h2 className="h2">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children && <p className="mt-1 text-sm text-muted">{children}</p>}
    </div>
  );
}

export interface BarSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

/**
 * One horizontal bar split into parts of a whole, with a 2px gap between parts. Each part also carries its label in the
 * tooltip and the accessible name, so the colour is never the only signal.
 */
export function StackedBar({ segments, height = 10 }: { segments: BarSegment[]; height?: number }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const label = segments.map((s) => `${s.label} ${s.value.toLocaleString()}`).join(", ");
  return (
    <div className="flex w-full gap-0.5 overflow-hidden rounded-full bg-line" style={{ height }} role="img" aria-label={label}>
      {total > 0 &&
        segments
          .filter((s) => s.value > 0)
          .map((s) => (
            <span key={s.key} title={`${s.label}: ${s.value.toLocaleString()}`} style={{ width: `${(s.value / total) * 100}%`, background: s.color, minWidth: 3 }} />
          ))}
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
    <div className="mt-4 flex items-center justify-between text-sm text-muted">
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

/** Share of a whole as a rounded percentage string, "—" when the whole is zero. */
export const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");

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
