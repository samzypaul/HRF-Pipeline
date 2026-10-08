import { Resend } from "resend";
import { marked } from "marked";
import { env } from "../env";

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

export async function sendReportEmail(runId: number, summaryMd: string): Promise<boolean> {
  const link = env.appUrl ? `${env.appUrl}/reports/${runId}` : null;
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:640px">
      <h2 style="margin:0 0 12px">HFR weekly report — run #${runId}</h2>
      ${renderMarkdown(summaryMd)}
      ${link ? `<p><a href="${link}">Open the full report and review queue</a></p>` : ""}
    </div>`;
  return send(env.reportRecipients, `HFR weekly report — run #${runId}`, html);
}

export async function sendLoginEmail(to: string, link: string): Promise<boolean> {
  const html = `<div style="font-family:system-ui,sans-serif">
    <p>Sign in to the HFR Pipeline dashboard:</p>
    <p><a href="${link}">Sign in</a></p>
    <p style="color:#666">This link expires in 15 minutes. If you didn't ask for it, ignore this email.</p></div>`;
  return send([to], "Your HFR Pipeline sign-in link", html);
}
