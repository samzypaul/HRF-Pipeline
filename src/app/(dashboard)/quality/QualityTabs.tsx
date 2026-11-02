"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/quality", label: "Review" },
  { href: "/quality/distribution", label: "Distribution" },
];

/** Tabs at the top of the Data quality section. */
export default function QualityTabs() {
  const path = usePathname() ?? "/quality";
  return (
    <nav className="mb-5 flex gap-1 border-b border-line text-sm" aria-label="Data quality">
      {TABS.map((t) => {
        const active = t.href === "/quality" ? path === "/quality" : path.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 font-medium transition-colors ${active ? "border-brand text-brand" : "border-transparent text-muted hover:text-ink"}`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
