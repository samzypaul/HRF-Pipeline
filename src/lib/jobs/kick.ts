import { env } from "../env";
import { errorMessage } from "../util";

/**
 * Start the next tick in a fresh function invocation. The tick route answers
 * immediately (the work happens in `after()`), so this call returns quickly.
 */
export async function kickTick(reason: string): Promise<boolean> {
  const base = env.appUrl;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) {
    console.warn(`[kick] APP_URL/CRON_SECRET not set; cannot chain ticks (${reason})`);
    return false;
  }
  try {
    const res = await fetch(`${base}/api/jobs/tick?reason=${encodeURIComponent(reason)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    return res.ok;
  } catch (e) {
    console.warn(`[kick] failed: ${errorMessage(e)}`);
    return false;
  }
}
