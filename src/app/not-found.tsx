import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Page not found | HFR Pipeline" };

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-soft/60 to-canvas px-4">
      <div className="w-full max-w-md text-center">
        <svg width="44" height="44" viewBox="0 0 26 26" aria-hidden className="mx-auto">
          <rect width="26" height="26" rx="7" fill="var(--color-brand)" />
          <path d="M13 5.5c-3.3 0-6 2.6-6 5.9 0 4.3 6 9.1 6 9.1s6-4.8 6-9.1c0-3.3-2.7-5.9-6-5.9Z" fill="none" stroke="#fff" strokeWidth="1.6" />
          <path d="M13 8.9v4.4M10.8 11.1h4.4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <p className="eyebrow mt-5">Error 404</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-2 text-sm text-muted">The page you are looking for does not exist or has moved. Check the address, or go back to the dashboard.</p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Link href="/" className="btn btn-primary">
            Go to the dashboard
          </Link>
          <Link href="/map" className="btn">
            Open the map
          </Link>
        </div>
      </div>
    </div>
  );
}
