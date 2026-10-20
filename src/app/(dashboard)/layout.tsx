import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { allowedLoginEmails } from "@/lib/settings";
import NavLinks from "@/components/NavLinks";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const email = (await headers()).get("x-user-email");
  // Sessions last 30 days, so an address removed on the Admin page is signed out here rather than waiting for its cookie to expire.
  if (email && !env.authDisabled && !(await allowedLoginEmails()).includes(email.toLowerCase())) redirect("/login?error=" + encodeURIComponent("This address no longer has access"));
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-line bg-panel/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
          <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight text-ink">
            <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
              <rect width="26" height="26" rx="7" fill="var(--color-brand)" />
              <path d="M13 5.5c-3.3 0-6 2.6-6 5.9 0 4.3 6 9.1 6 9.1s6-4.8 6-9.1c0-3.3-2.7-5.9-6-5.9Z" fill="none" stroke="#fff" strokeWidth="1.6" />
              <path d="M13 8.9v4.4M10.8 11.1h4.4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            HFR Pipeline
          </Link>
          <NavLinks />
          <div className="ml-auto flex items-center gap-3 text-xs text-muted">
            {email && <span className="hidden rounded-full bg-canvas px-2.5 py-1 sm:inline">{email}</span>}
            {email && (
              <form action="/api/auth/logout" method="post">
                <button className="rounded-lg px-2 py-1 font-medium hover:bg-canvas hover:text-ink">Sign out</button>
              </form>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8">{children}</main>
    </div>
  );
}
