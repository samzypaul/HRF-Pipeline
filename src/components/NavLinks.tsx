"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/map", label: "Map" },
  { href: "/quality", label: "Data quality" },
  { href: "/reports", label: "Reports" },
  { href: "/export", label: "Export" },
  { href: "/admin", label: "Admin" },
];

/** The top navigation; the current section is highlighted so people always know where they are. */
export default function NavLinks() {
  const path = usePathname() ?? "/";
  const active = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));
  return (
    <nav className="flex flex-wrap gap-1 text-sm" aria-label="Main">
      {NAV.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          aria-current={active(n.href) ? "page" : undefined}
          className={`rounded-lg px-3 py-1.5 font-medium transition-colors ${
            active(n.href) ? "bg-brand-soft text-brand" : "text-muted hover:bg-canvas hover:text-ink"
          }`}
        >
          {n.label}
        </Link>
      ))}
    </nav>
  );
}
