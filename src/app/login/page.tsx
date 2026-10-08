export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="card w-full max-w-sm">
        <div className="mb-4 flex items-center gap-2 font-semibold text-brand">
          <span className="inline-block h-3 w-3 rounded-full bg-brand" aria-hidden />
          HFR Pipeline
        </div>
        {sp.sent === "1" ? (
          <p className="text-sm">If that address is allowed, a sign-in link is on its way. It expires in 15 minutes.</p>
        ) : (
          <form action="/api/auth/login" method="post" className="space-y-3">
            <input type="hidden" name="next" value={sp.next ?? "/"} />
            <label className="flex flex-col gap-1 text-sm">
              Work email
              <input className="input" type="email" name="email" required autoComplete="email" />
            </label>
            <button className="btn btn-primary w-full justify-center">Email me a sign-in link</button>
          </form>
        )}
        {sp.error && <p className="mt-3 text-sm text-low">{sp.error}</p>}
      </div>
    </div>
  );
}
