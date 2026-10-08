import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { SESSION_COOKIE, SESSION_DAYS, sessionExpiry, signToken, verifyToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const payload = await verifyToken(url.searchParams.get("token"), env.authSecret, "link");
  const next = url.searchParams.get("next") ?? "/";
  if (!payload || !env.allowedEmails.includes(payload.email)) {
    return NextResponse.redirect(new URL("/login?error=Link%20expired%20or%20invalid", req.url), 303);
  }
  const session = await signToken({ email: payload.email, purpose: "session", exp: sessionExpiry() }, env.authSecret);
  const res = NextResponse.redirect(new URL(next.startsWith("/") ? next : "/", req.url), 303);
  res.cookies.set(SESSION_COOKIE, session, {
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
  return res;
}
