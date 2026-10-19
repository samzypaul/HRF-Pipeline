/**
 * Fill facilities.phone_e164 from the raw phone text. New scrapes set it themselves; run this once after the migration.
 *
 *   npx tsx scripts/backfill-phones.ts [--dry-run]
 */
import "./_env";
import { sql } from "drizzle-orm";
import { closeDb, q } from "../src/lib/db/client";
import { normalizePhone } from "../src/lib/phone";

async function main() {
  const rows = await q<{ facility_code: string; phone: string }>(sql`SELECT facility_code, phone FROM facilities WHERE phone IS NOT NULL`);
  const updates: { code: string; e164: string }[] = [];
  const unreadable: string[] = [];
  for (const r of rows) {
    const e164 = normalizePhone(r.phone);
    if (e164) updates.push({ code: r.facility_code, e164 });
    else unreadable.push(r.phone);
  }
  console.log(`${rows.length} with a phone: ${updates.length} normalised, ${unreadable.length} unreadable`);
  console.log("Unreadable samples:", [...new Set(unreadable)].slice(0, 25));
  if (process.argv.includes("--dry-run")) return;

  for (let i = 0; i < updates.length; i += 1000) {
    const chunk = updates.slice(i, i + 1000);
    await q(sql`
      UPDATE facilities f SET phone_e164 = v.e164
      FROM (VALUES ${sql.join(chunk.map((u) => sql`(${u.code}, ${u.e164})`), sql`, `)}) AS v(code, e164)
      WHERE f.facility_code = v.code`);
  }
  console.log("Done.");
}

main().finally(closeDb);
