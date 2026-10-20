export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-soft/60 to-canvas px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <svg width="44" height="44" viewBox="0 0 26 26" aria-hidden>
            <rect width="26" height="26" rx="7" fill="var(--color-brand)" />
            <path d="M13 5.5c-3.3 0-6 2.6-6 5.9 0 4.3 6 9.1 6 9.1s6-4.8 6-9.1c0-3.3-2.7-5.9-6-5.9Z" fill="none" stroke="#fff" strokeWidth="1.6" />
            <path d="M13 8.9v4.4M10.8 11.1h4.4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <h1 className="mt-3 text-xl font-semibold tracking-tight">HFR Pipeline</h1>
          <p className="mt-1 text-sm text-muted">Tanzania Health Facility Registry: locations, quality and reports</p>
        </div>
        <div className="card">
          {sp.sent === "1" ? (
            <div className="text-center">
              <p className="font-medium">Check your email</p>
              <p className="mt-1 text-sm text-muted">If that address is allowed, a sign-in link is on its way. It expires in 15 minutes.</p>
            </div>
          ) : (
            <form action="/api/auth/login" method="post" className="space-y-4">
              <input type="hidden" name="next" value={sp.next ?? "/"} />
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Work email
                <input className="input" type="email" name="email" required autoComplete="email" placeholder="name@example.org" />
              </label>
              <button className="btn btn-primary w-full">Email me a sign-in link</button>
              <p className="text-center text-xs text-muted">No password: we email you a one-time link.</p>
            </form>
          )}
          {sp.error && <p className="mt-4 rounded-lg bg-low/10 px-3 py-2 text-sm text-low">{sp.error}</p>}
        </div>
      </div>
    </div>
  );
}
