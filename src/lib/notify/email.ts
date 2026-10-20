import { Resend } from "resend";
import { marked } from "marked";
import { env } from "../env";
import { getSettings } from "../settings";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Markdown → HTML with any raw HTML in the source escaped. */
export function renderMarkdown(md: string): string {
  return marked.parse(escapeHtml(md), { async: false }) as string;
}

async function send(to: string[], subject: string, html: string): Promise<boolean> {
  if (!env.resendKey || to.length === 0) return false;
  const resend = new Resend(env.resendKey);
  const { error } = await resend.emails.send({ from: env.reportFrom, to, subject, html });
  if (error) throw new Error(`Email failed: ${error.message}`);
  return true;
}

export async function sendReportEmail(r: {
  id: number;
  title: string;
  summaryMd: string;
  recommendations?: { title: string; detail: string; priority?: string }[];
}): Promise<boolean> {
  const link = `${env.publicUrl}/reports/${r.id}`;
  const recs = r.recommendations?.length
    ? `<h3 style="margin:16px 0 4px">Recommendations</h3><ol>${r.recommendations
        .map((x) => `<li><strong>${escapeHtml(x.title)}</strong>${x.priority ? ` (${escapeHtml(x.priority)})` : ""}: ${escapeHtml(x.detail)}</li>`)
        .join("")}</ol>`
    : "";
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:640px">
      <h2 style="margin:0 0 12px">${escapeHtml(r.title)}</h2>
      ${renderMarkdown(r.summaryMd)}
      ${recs}
      ${link ? `<p><a href="${link}">Open the full report</a></p>` : ""}
    </div>`;
  const { reports } = await getSettings();
  return send(reports.recipients.length ? reports.recipients : env.reportRecipients, r.title, html);
}

export async function sendLoginEmail(to: string, link: string): Promise<boolean> {
  const html = `<div style="font-family:system-ui,sans-serif">
    <p>Sign in to the HFR Pipeline dashboard:</p>
    <p><a href="${link}">Sign in</a></p>
    <p style="color:#666">This link expires in 15 minutes. If you didn't ask for it, ignore this email.</p></div>`;
  return send([to], "Your HFR Pipeline sign-in link", html);
}

/** Tell a newly added address it can sign in; the sign-in page then emails it a one-time link. */
export async function sendAccessEmail(to: string): Promise<boolean> {
  const link = `${env.publicUrl}/login`;
  const html = `<div style="font-family:system-ui,sans-serif">
    <p>You have been given access to the HFR Pipeline dashboard.</p>
    ${link ? `<p><a href="${link}">Open the sign-in page</a>, enter this email address and we will send you a one-time sign-in link (valid for 15 minutes).</p>` : "<p>Open the dashboard, enter this email address on the sign-in page and we will send you a one-time sign-in link.</p>"}
    <p style="color:#666">If you were not expecting this, ignore this email.</p></div>`;
  return send([to], "You can now sign in to the HFR Pipeline", html);
}

export async function sendMail(to: string[], subject: string, html: string): Promise<boolean> {
  return send(to, subject, html);
}

export async function sendStatusEmail(subject: string, html: string): Promise<boolean> {
  return send(env.reportRecipients, subject, html);
}
