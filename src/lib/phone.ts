/**
 * Normalise the free-text "Official Phone" value to E.164. HFR holds Tanzanian numbers in many shapes
 * (`0778008577`, `778008577`, `+255 778 008 577`, `022-2123456`, `+255(0)778008577`, `0712345678/0754123456`).
 * Returns the first valid number, or null when none can be read (e.g. a 7-digit number with no area code).
 * The raw value stays in `facilities.phone`.
 */
const TZ = "255";

function normalizeOne(segment: string): string | null {
  const s = segment.replace(/\(\s*0\s*\)/g, ""); // "+255 (0) 7xx" – the trunk zero is not dialled abroad
  const plus = /^\s*\+/.test(s);
  let d = s.replace(/\D/g, "");
  if (d.startsWith("00")) return normalizeOne(`+${d.slice(2)}`);
  if (plus) {
    if (d.startsWith(TZ)) {
      d = d.slice(TZ.length);
      if (d.length === 10 && d.startsWith("0")) d = d.slice(1); // "+2550713…": trunk zero kept by mistake
    } else return d.length >= 8 && d.length <= 15 && !d.startsWith("0") ? `+${d}` : null;
  } else if (d.length === 12 && d.startsWith(TZ)) {
    d = d.slice(TZ.length);
  } else if (d.length === 10 && d.startsWith("0")) {
    d = d.slice(1);
  }
  // Tanzanian national numbers: 9 digits; 2 = landline, 6/7 = mobile, 8 = toll-free / premium.
  return /^[2678]\d{8}$/.test(d) ? `+${TZ}${d}` : null;
}

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  for (const segment of raw.split(/[/,;|]|\s+(?:or|na|and)\s+/i)) {
    const n = normalizeOne(segment);
    if (n) return n;
  }
  return null;
}
