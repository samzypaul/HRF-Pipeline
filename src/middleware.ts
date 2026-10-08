import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifyToken } from "@/lib/auth";

const PUBLIC = [/^\/login/, /^\/api\/auth\//, /^\/api\/cron\//, /^\/api\/jobs\/tick/];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((r) => r.test(pathname))) return NextResponse.next();
  if (process.env.AUTH_DISABLED === "true") return NextResponse.next();

  const secret = process.env.AUTH_SECRET;
  const session = secret ? await verifyToken(req.cookies.get(SESSION_COOKIE)?.value, secret, "session") : null;
  if (session) {
    const headers = new Headers(req.headers);
    headers.set("x-user-email", session.email);
    return NextResponse.next({ request: { headers } });
  }
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|ico|css|js)$).*)"],
};
