/**
 * Checks that every number the AI wrote exists in the data it was given.
 * Years, small ordinals and percentages that can be derived are handled
 * explicitly; anything else that is not in the digest fails verification.
 */

export interface Verification {
  ok: boolean;
  checked: number;
  unknown: string[];
}

function collectNumbers(value: unknown, out: Set<number>) {
  if (typeof value === "number" && Number.isFinite(value)) out.add(round(value));
  else if (typeof value === "string") {
    for (const n of extractNumbers(value)) out.add(n);
  } else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectNumbers(v, out));
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Numbers written in text: "1,234", "12.5", "45%". Skips facility codes like 120284-5 and dates. */
export function extractNumbers(text: string): number[] {
  const cleaned = text
    .replace(/\b\d{6}-\d\b/g, " ") // facility codes
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ") // ISO dates
    .replace(/\b(TZ(\.[A-Z0-9]+)+)\b/g, " "); // admin codes
  const out: number[] = [];
  for (const m of cleaned.matchAll(/(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![\w])/g)) {
    out.push(round(Number(m[1].replace(/,/g, "") + (m[2] ? `.${m[2]}` : ""))));
  }
  return out;
}

export function verifyNumbers(texts: string[], digest: unknown): Verification {
  const known = new Set<number>();
  collectNumbers(digest, known);
  const nums = [...known];
  const derived = new Set<number>(known);
  // Allow simple shares (a/b as %) and differences between known numbers.
  for (const a of nums) {
    for (const b of nums) {
      if (b > 0 && a <= b) derived.add(round((a / b) * 100));
      if (a > b) derived.add(round(a - b));
    }
  }
  const unknown: string[] = [];
  let checked = 0;
  for (const t of texts) {
    for (const n of extractNumbers(t)) {
      checked++;
      if (n <= 10) continue; // small counts / list numbering
      if (n >= 1990 && n <= 2100 && Number.isInteger(n)) continue; // years
      const ok = derived.has(n) || derived.has(Math.round(n)) || [...derived].some((d) => Math.abs(d - n) <= 0.5);
      if (!ok) unknown.push(String(n));
    }
  }
  return { ok: unknown.length === 0, checked, unknown: [...new Set(unknown)] };
}
