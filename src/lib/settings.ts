import { sql } from "drizzle-orm";
import { q } from "./db/client";
import { env } from "./env";
import type { GeoProvider } from "./geo/provider";

export type Cadence = "off" | "weekly" | "daily";

export interface Settings {
  /** Automatic runs: off, once a week on `weekday` (0 = Sunday … 6 = Saturday, East Africa Time), or every day. */
  schedule: { cadence: Cadence; weekday: number };
  /** Morning status email to REPORT_RECIPIENTS. */
  dailyEmail: { enabled: boolean };
  /** Geocoders behind the "extra geocoder" layer: all with a key at once ("all"), one of them, or the first with a key ("auto"). */
  geoProvider: GeoProvider;
  /** Email a list of corrected points awaiting approval after each run. Empty recipients = REPORT_RECIPIENTS. */
  approvals: { emailEnabled: boolean; recipients: string[] };
  /** Who receives the daily and weekly AI reports. Empty = REPORT_RECIPIENTS. */
  reports: { recipients: string[] };
  /** Extra addresses allowed to sign in (added on the Admin page), on top of the ALLOWED_EMAILS environment variable. */
  access: { emails: string[] };
  /** Optional location-check layers. Sanity checks and the ward-boundary check always run. */
  geoLayers: { osm: boolean; google: boolean; nominatim: boolean; extraGeocoder: boolean; googleGeocode: boolean; wardCentroid: boolean };
}

export const DEFAULT_SETTINGS: Settings = {
  schedule: { cadence: "weekly", weekday: 1 },
  dailyEmail: { enabled: false },
  geoProvider: "all",
  approvals: { emailEnabled: true, recipients: [] },
  reports: { recipients: [] },
  access: { emails: [] },
  geoLayers: { osm: true, google: true, nominatim: true, extraGeocoder: true, googleGeocode: true, wardCentroid: true },
};

/** "a@x.org, b@y.org" (or a list) → valid, lower-cased, unique addresses. */
export function parseEmails(v: unknown): string[] {
  const parts = Array.isArray(v) ? v : String(v ?? "").split(/[,;\s]+/);
  const ok = parts.map((s) => String(s).trim().toLowerCase()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
  return [...new Set(ok)];
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const GEO_LAYER_INFO: { key: keyof Settings["geoLayers"]; label: string; hint: string }[] = [
  { key: "osm", label: "OpenStreetMap name match", hint: "Free. Confirms a point by finding a same-named place nearby." },
  { key: "google", label: "Google Places name match", hint: "Fallback when OSM finds nothing. Counts against the monthly cap." },
  { key: "nominatim", label: "Nominatim geocoding", hint: "Finds a point for facilities with no usable coordinates." },
  {
    key: "extraGeocoder",
    label: "Extra geocoder and ward-name check",
    hint: "Reverse-geocodes each point to check its ward name, suggests ward links, and (MapTiler only) finds points for facilities with no coordinates. Provider chosen below.",
  },
  { key: "googleGeocode", label: "Google geocoding", hint: "Second geocoder, used after Nominatim. Counts against the monthly cap." },
  { key: "wardCentroid", label: "Ward centre stand-in", hint: "Last resort: low-confidence point at the middle of the ward (or of the council when there is no ward)." },
];

/** Scheduler bookkeeping, kept apart from user settings so saving the form never resets it. */
export interface SchedulerState {
  lastRunDate?: string;
  lastEmailDate?: string;
}

const EAT_OFFSET_MS = 3 * 3_600_000;

/** Calendar date (YYYY-MM-DD) and weekday in East Africa Time. */
export function eatDay(now = new Date()): { date: string; weekday: number } {
  const shifted = new Date(now.getTime() + EAT_OFFSET_MS);
  return { date: shifted.toISOString().slice(0, 10), weekday: shifted.getUTCDay() };
}

/** Should the scheduler start a run on this day? */
export function runDueToday(schedule: Settings["schedule"], now = new Date()): boolean {
  if (schedule.cadence === "daily") return true;
  if (schedule.cadence === "weekly") return eatDay(now).weekday === schedule.weekday;
  return false;
}

export function describeSchedule(s: Settings["schedule"]): string {
  if (s.cadence === "daily") return "every day";
  if (s.cadence === "weekly") return `every ${WEEKDAYS[s.weekday] ?? "Monday"}`;
  return "off";
}

/** Merge stored JSON over the defaults, ignoring anything malformed. */
export function normalizeSettings(raw: Partial<Record<keyof Settings, unknown>> | null | undefined): Settings {
  const d = DEFAULT_SETTINGS;
  const sched = (raw?.schedule ?? {}) as Partial<Settings["schedule"]>;
  const email = (raw?.dailyEmail ?? {}) as Partial<Settings["dailyEmail"]>;
  const layers = (raw?.geoLayers ?? {}) as Partial<Settings["geoLayers"]>;
  const weekday = Number(sched.weekday);
  const provider = raw?.geoProvider;
  const approvals = (raw?.approvals ?? {}) as Partial<Settings["approvals"]>;
  const reports = (raw?.reports ?? {}) as Partial<Settings["reports"]>;
  const access = (raw?.access ?? {}) as Partial<Settings["access"]>;
  return {
    access: { emails: parseEmails(access.emails) },
    reports: { recipients: parseEmails(reports.recipients) },
    approvals: {
      emailEnabled: typeof approvals.emailEnabled === "boolean" ? approvals.emailEnabled : d.approvals.emailEnabled,
      recipients: parseEmails(approvals.recipients),
    },
    geoProvider: provider === "maptiler" || provider === "google" || provider === "arcgis" || provider === "auto" || provider === "all" ? provider : d.geoProvider,
    schedule: {
      cadence: sched.cadence === "off" || sched.cadence === "daily" || sched.cadence === "weekly" ? sched.cadence : d.schedule.cadence,
      weekday: Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? weekday : d.schedule.weekday,
    },
    dailyEmail: { enabled: typeof email.enabled === "boolean" ? email.enabled : d.dailyEmail.enabled },
    geoLayers: {
      osm: typeof layers.osm === "boolean" ? layers.osm : d.geoLayers.osm,
      google: typeof layers.google === "boolean" ? layers.google : d.geoLayers.google,
      nominatim: typeof layers.nominatim === "boolean" ? layers.nominatim : d.geoLayers.nominatim,
      extraGeocoder: typeof layers.extraGeocoder === "boolean" ? layers.extraGeocoder : d.geoLayers.extraGeocoder,
      googleGeocode: typeof layers.googleGeocode === "boolean" ? layers.googleGeocode : d.geoLayers.googleGeocode,
      wardCentroid: typeof layers.wardCentroid === "boolean" ? layers.wardCentroid : d.geoLayers.wardCentroid,
    },
  };
}

export async function getSettings(): Promise<Settings> {
  const [r] = await q<{ value: Partial<Record<keyof Settings, unknown>> }>(sql`SELECT value FROM app_settings WHERE key = 'settings'`);
  return normalizeSettings(r?.value);
}

/** Everyone who may sign in: the ALLOWED_EMAILS variable plus the addresses added on the Admin page. */
export async function allowedLoginEmails(): Promise<string[]> {
  const fromEnv = env.allowedEmails;
  try {
    return [...new Set([...fromEnv, ...(await getSettings()).access.emails])];
  } catch {
    return fromEnv; // the database being down must not lock the owners out
  }
}

/** Only the owners (ALLOWED_EMAILS) change who can sign in; with none configured (local dev) anyone may. */
export function canManageAccess(email: string | null | undefined): boolean {
  const owners = env.allowedEmails;
  return env.authDisabled || owners.length === 0 || (!!email && owners.includes(email.toLowerCase()));
}

export async function saveSettings(s: Settings): Promise<void> {
  await q(sql`
    INSERT INTO app_settings (key, value, updated_at) VALUES ('settings', ${JSON.stringify(s)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
}

export async function getSchedulerState(): Promise<SchedulerState> {
  const [r] = await q<{ value: SchedulerState }>(sql`SELECT value FROM app_settings WHERE key = 'scheduler_state'`);
  return r?.value ?? {};
}

/** Merge fields into the scheduler state. */
export async function setSchedulerState(patch: SchedulerState): Promise<void> {
  await q(sql`
    INSERT INTO app_settings (key, value, updated_at) VALUES ('scheduler_state', ${JSON.stringify(patch)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = app_settings.value || EXCLUDED.value, updated_at = now()`);
}
