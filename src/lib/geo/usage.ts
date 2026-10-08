import { sql } from "drizzle-orm";
import { q } from "../db/client";
import { monthKey } from "../util";

/** Atomically count one API call for this month; returns the new total. */
export async function countCall(provider: string, n = 1): Promise<number> {
  const rows = await q<{ calls: number }>(sql`
    INSERT INTO api_usage (provider, month, calls) VALUES (${provider}, ${monthKey()}, ${n})
    ON CONFLICT (provider, month) DO UPDATE SET calls = api_usage.calls + ${n}
    RETURNING calls`);
  return Number(rows[0]?.calls ?? 0);
}

export async function callsThisMonth(provider: string): Promise<number> {
  const rows = await q<{ calls: number }>(
    sql`SELECT calls FROM api_usage WHERE provider = ${provider} AND month = ${monthKey()}`,
  );
  return Number(rows[0]?.calls ?? 0);
}

/**
 * Reserve one call under a monthly cap. Returns false (and reserves nothing)
 * when the cap is reached, so Google usage stays inside the free tier.
 */
export async function reserveCall(provider: string, cap: number): Promise<boolean> {
  const rows = await q<{ calls: number }>(sql`
    INSERT INTO api_usage (provider, month, calls) VALUES (${provider}, ${monthKey()}, 1)
    ON CONFLICT (provider, month) DO UPDATE SET calls = api_usage.calls + 1
      WHERE api_usage.calls < ${cap}
    RETURNING calls`);
  return rows.length > 0;
}
