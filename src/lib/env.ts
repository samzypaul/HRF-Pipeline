/**
 * Central access to environment variables.
 * Values are read lazily so that build steps (and unit tests) don't fail
 * when a secret is not set.
 */

import { availableParallelism } from "node:os";

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
  get hfrTimeoutMs() {
    return num("HFR_TIMEOUT_MS", 90_000);
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
  get maptilerKey() {
    return read("MAPTILER_API_KEY");
  },
  get maptilerMonthlyCap() {
    return num("MAPTILER_MONTHLY_CAP", 90_000);
  },
  get arcgisKey() {
    return read("ARCGIS_API_KEY");
  },
  get arcgisMonthlyCap() {
    return num("ARCGIS_MONTHLY_CAP", 18_000);
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

  // Parallelism. Defaults follow the machine's CPU count; every value can be overridden.
  get cpuCount() {
    return Math.max(1, availableParallelism());
  },
  /** Lanes that fetch from the HFR portal. The portal itself is still limited to one request per HFR_RATE_MS in total. */
  get scrapeLanes() {
    return Math.max(1, Math.floor(num("SCRAPE_LANES", 2)));
  },
  /** Lanes that validate facilities (spatial queries, geocoders) while scraping continues. */
  get computeLanes() {
    return Math.max(1, Math.floor(num("COMPUTE_LANES", clamp(availableParallelism() - 1, 2, 6))));
  },
  /** Facilities validated at the same time inside one validate_batch task. */
  get geoConcurrency() {
    return Math.max(1, Math.floor(num("GEO_CONCURRENCY", 4)));
  },
  /** Paid/limited geocoder and Places calls in flight at once, across all lanes. */
  get geoApiConcurrency() {
    return Math.max(1, Math.floor(num("GEO_API_CONCURRENCY", 8)));
  },
  /** Database connections: enough for every lane plus the dashboard. */
  get dbPoolMax() {
    return Math.max(2, Math.floor(num("DB_POOL_MAX", clamp(availableParallelism() * 2, 6, 16))));
  },
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
