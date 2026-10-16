import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, describeSchedule, eatDay, normalizeSettings, runDueToday } from "@/lib/settings";

describe("schedule", () => {
  it("uses East Africa Time for the day", () => {
    // Sunday 23:00 UTC is already Monday 02:00 in Tanzania.
    expect(eatDay(new Date("2026-10-11T23:00:00Z"))).toEqual({ date: "2026-10-12", weekday: 1 });
  });
  it("runs weekly only on the chosen weekday", () => {
    const monday = new Date("2026-10-11T23:00:00Z");
    expect(runDueToday({ cadence: "weekly", weekday: 1 }, monday)).toBe(true);
    expect(runDueToday({ cadence: "weekly", weekday: 3 }, monday)).toBe(false);
  });
  it("runs daily every day and never when off", () => {
    const d = new Date("2026-10-14T23:00:00Z");
    expect(runDueToday({ cadence: "daily", weekday: 1 }, d)).toBe(true);
    expect(runDueToday({ cadence: "off", weekday: 1 }, d)).toBe(false);
  });
  it("describes the schedule", () => {
    expect(describeSchedule({ cadence: "weekly", weekday: 5 })).toBe("every Friday");
  });
});

describe("settings", () => {
  it("falls back to defaults for missing or malformed values", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    const s = normalizeSettings({ schedule: { cadence: "hourly", weekday: 9 }, geoLayers: { osm: "yes", google: false } });
    expect(s.schedule).toEqual(DEFAULT_SETTINGS.schedule);
    expect(s.geoLayers.osm).toBe(true);
    expect(s.geoLayers.google).toBe(false);
  });
});

describe("approval recipients", () => {
  it("keeps only valid, unique, lower-case addresses", async () => {
    const { parseEmails } = await import("@/lib/settings");
    expect(parseEmails("A@x.org, b@y.org; not-an-email  a@x.org")).toEqual(["a@x.org", "b@y.org"]);
    expect(parseEmails("")).toEqual([]);
  });
  it("defaults to emailing the report recipients", () => {
    expect(normalizeSettings(null).reports).toEqual({ recipients: [] });
    expect(normalizeSettings({ reports: { recipients: ["A@x.org", "bad", "a@x.org", "b@y.org"] } }).reports.recipients).toEqual(["a@x.org", "b@y.org"]);
    expect(normalizeSettings(null).approvals).toEqual({ emailEnabled: true, recipients: [] });
  });
});
