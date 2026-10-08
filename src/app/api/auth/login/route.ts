import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { linkExpiry, signToken } from "@/lib/auth";
import { sendLoginEmail } from "@/lib/notify/email";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const form = await req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const next = String(form.get("next") ?? "/");
  const back = new URL("/login", req.url);
  back.searchParams.set("sent", "1");

  // Same response whether or not the address is allowed, so the list can't be probed.
  if (email && env.allowedEmails.includes(email)) {
    const token = await signToken({ email, purpose: "link", exp: linkExpiry() }, env.authSecret);
    const base = env.appUrl ?? new URL(req.url).origin;
    const link = `${base}/api/auth/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next.startsWith("/") ? next : "/")}`;
    const sent = await sendLoginEmail(email, link).catch(() => false);
    if (!sent) {
      back.searchParams.set("sent", "0");
      back.searchParams.set("error", "Email could not be sent. Check RESEND_API_KEY and REPORT_FROM.");
    }
  }
  return NextResponse.redirect(back, 303);
}
