import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { allowedLoginEmails } from "@/lib/settings";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/map", label: "Map" },
  { href: "/quality", label: "Data quality" },
  { href: "/reports", label: "Reports" },
  { href: "/export", label: "Export" },
  { href: "/admin", label: "Admin" },
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const email = (await headers()).get("x-user-email");
  // Sessions last 30 days, so an address removed on the Admin page is signed out here rather than waiting for its cookie to expire.
  if (email && !env.authDisabled && !(await allowedLoginEmails()).includes(email.toLowerCase())) redirect("/login?error=" + encodeURIComponent("This address no longer has access"));
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/" className="flex items-center gap-2 font-semibold text-brand">
            <span className="inline-block h-3 w-3 rounded-full bg-brand" aria-hidden />
            HFR Pipeline
          </Link>
          <nav className="flex flex-wrap gap-1 text-sm">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="rounded-md px-2.5 py-1.5 text-muted hover:bg-canvas hover:text-ink">
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-xs text-muted">
            {email && <span>{email}</span>}
            {email && (
              <form action="/api/auth/logout" method="post">
                <button className="underline">Sign out</button>
              </form>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
