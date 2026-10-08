/**
 * Central access to environment variables.
 * Values are read lazily so that build steps (and unit tests) don't fail
 * when a secret is not set.
 */

function read(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

export function required(name: string): string {
  const v = read(name);
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = read(name);
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function list(name: string): string[] {
  return (read(name) ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const env = {
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get cronSecret() {
    return required("CRON_SECRET");
  },
  get appUrl(): string | undefined {
    const explicit = read("APP_URL");
    if (explicit) return explicit.replace(/\/$/, "");
    const prod = read("VERCEL_PROJECT_PRODUCTION_URL");
    if (prod) return `https://${prod}`;
    const url = read("VERCEL_URL");
    return url ? `https://${url}` : undefined;
  },

  // HFR portal
  get hfrBaseUrl() {
    return read("HFR_BASE_URL") ?? "https://hfrportal.moh.go.tz/web/index.php";
  },
  get hfrContactEmail() {
    return read("HFR_CONTACT_EMAIL") ?? "not-set@example.com";
  },
  get hfrRateMs() {
    return num("HFR_RATE_MS", 1000);
  },
  get hfrFetchServices() {
    return read("HFR_FETCH_SERVICES") !== "false";
  },

  // Map services
  get googleKey() {
    return read("GOOGLE_MAPS_API_KEY");
  },
  get googlePlacesMonthlyCap() {
    return num("GOOGLE_MONTHLY_CAP", 4500);
  },
  get googleGeocodeMonthlyCap() {
    return num("GOOGLE_GEOCODE_MONTHLY_CAP", 9000);
  },
  get nominatimEmail() {
    return read("NOMINATIM_EMAIL") ?? read("HFR_CONTACT_EMAIL") ?? "not-set@example.com";
  },
  get nominatimUrl() {
    return read("NOMINATIM_URL") ?? "https://nominatim.openstreetmap.org";
  },
  /** Overpass endpoints, tried in order until one answers. */
  get overpassUrls(): string[] {
    const v = read("OVERPASS_URLS") ?? read("OVERPASS_URL");
    if (v) return v.split(",").map((s) => s.trim()).filter(Boolean);
    return [
      "https://overpass-api.de/api/interpreter",
      "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
    ];
  },

  // AI + email
  get geminiKey() {
    return read("GEMINI_API_KEY");
  },
  get geminiModel() {
    return read("GEMINI_MODEL") ?? "gemini-3.8-flash";
  },
  get resendKey() {
    return read("RESEND_API_KEY");
  },
  get reportFrom() {
    return read("REPORT_FROM") ?? "HFR Pipeline <onboarding@resend.dev>";
  },
  get reportRecipients() {
    return list("REPORT_RECIPIENTS");
  },

  // Auth
  get authSecret() {
    return required("AUTH_SECRET");
  },
  get allowedEmails() {
    return list("ALLOWED_EMAILS");
  },
  get authDisabled() {
    return read("AUTH_DISABLED") === "true";
  },

  // Job runner
  get tickBudgetMs() {
    return num("TICK_BUDGET_MS", 180_000);
  },
};
