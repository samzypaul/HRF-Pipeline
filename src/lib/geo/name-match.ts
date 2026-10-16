/**
 * Fuzzy matching of facility names across HFR, OpenStreetMap and Google.
 * Normalises Swahili/English facility-type words so "Zahanati ya Bahi" and
 * "Bahi Dispensary" compare on the distinctive part ("bahi").
 */

const GENERIC_WORDS = [
  "dispensary",
  "zahanati",
  "health centre",
  "health center",
  "kituo cha afya",
  "hospital",
  "hospitali",
  "district hospital",
  "regional referral hospital",
  "referral",
  "clinic",
  "kliniki",
  "polyclinic",
  "medical centre",
  "medical center",
  "laboratory",
  "lab",
  "maabara",
  "pharmacy",
  "duka la dawa",
  "maternity home",
  "nursing home",
  "rc",
  "r c",
  "lutheran",
  "elct",
  "fdh",
  "dc",
  "mc",
  "tc",
  "cc",
  "ya",
  "cha",
  "la",
  "wa",
  "the",
  "and",
  "of",
];

const STRIP = new RegExp(
  `\\b(${GENERIC_WORDS.sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/\s+/g, "\\s+"))
    .join("|")})\\b`,
  "g",
);

export function normalizeName(name: string, opts: { keepGeneric?: boolean } = {}): string {
  let s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ");
  if (!opts.keepGeneric) s = s.replace(STRIP, " ");
  return s.replace(/\s+/g, " ").trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 0–100 similarity of two strings. */
export function ratio(a: string, b: string): number {
  if (!a && !b) return 100;
  const len = a.length + b.length;
  return len === 0 ? 0 : Math.round((1 - levenshtein(a, b) / Math.max(a.length, b.length)) * 100);
}

/** Token-set ratio (as in fuzzywuzzy): robust to word order and extra words. */
export function tokenSetRatio(a: string, b: string): number {
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  const inter = [...ta].filter((t) => tb.has(t)).sort();
  const diffA = [...ta].filter((t) => !tb.has(t)).sort();
  const diffB = [...tb].filter((t) => !ta.has(t)).sort();
  const sInter = inter.join(" ");
  const sA = [sInter, ...diffA].join(" ").trim();
  const sB = [sInter, ...diffB].join(" ").trim();
  if (inter.length > 0 && (diffA.length === 0 || diffB.length === 0)) return 100;
  return Math.max(ratio(sInter, sA), ratio(sInter, sB), ratio(sA, sB));
}

/** Score two facility names 0–100. */
export function nameScore(hfrName: string, otherName: string): number {
  const a = normalizeName(hfrName);
  const b = normalizeName(otherName);
  if (!a || !b) {
    // Names made only of generic words: compare them in full.
    return tokenSetRatio(normalizeName(hfrName, { keepGeneric: true }), normalizeName(otherName, { keepGeneric: true }));
  }
  return tokenSetRatio(a, b);
}

export const MATCH_SCORE = 85;
/** Name match this close to the HFR point = high confidence; up to MEDIUM_DISTANCE_M = medium; further = low. */
export const MATCH_DISTANCE_M = 500;
export const MEDIUM_DISTANCE_M = 1500;
export const SEARCH_RADIUS_M = 2000;
