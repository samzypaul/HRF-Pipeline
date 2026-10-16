import { describe, expect, it } from "vitest";
import { addDays, buildWeeklyDigest, weekOf, type DailyRow } from "../src/lib/ai/weekly";
import type { Digest } from "../src/lib/ai/report";

describe("weekOf", () => {
  it("runs Monday to Sunday", () => {
    expect(weekOf("2026-10-14")).toEqual({ start: "2026-10-12", end: "2026-10-18" }); // Wednesday
    expect(weekOf("2026-10-12").start).toBe("2026-10-12"); // Monday
    expect(weekOf("2026-10-18").start).toBe("2026-10-12"); // Sunday belongs to the week that ends on it
  });
  it("crosses month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(weekOf("2027-01-01")).toEqual({ start: "2026-12-28", end: "2027-01-03" });
  });
});

describe("buildWeeklyDigest", () => {
  const day = (id: number, date: string, changes: Record<string, number>, region: string): DailyRow => ({
    id,
    run_id: id,
    period_start: date,
    verified: true,
    summary_md: "ok",
    anomalies: [{ title: "Dup", detail: "x" }],
    recommendations: [{ title: "Check", detail: "y" }],
    digest: { changes, new_by_region: [{ region, n: changes.new ?? 0 }], new_by_type: [], closed_by_region: [], changed_fields: [], totals: { active_facilities: id }, confidence: {} } as unknown as Digest,
  });

  it("sums daily counts and keeps the latest totals", () => {
    const d = buildWeeklyDigest("2026-10-12", "2026-10-18", [
      day(1, "2026-10-12", { new: 2, updated: 1 }, "Dodoma"),
      day(2, "2026-10-13", { new: 3 }, "Dodoma"),
    ]);
    expect(d.changes_total).toEqual({ new: 5, updated: 1 });
    expect(d.new_by_region).toEqual([{ region: "Dodoma", n: 5 }]);
    expect(d.days_covered).toBe(2);
    expect(d.latest_totals?.active_facilities).toBe(2);
    expect(d.daily_anomalies).toHaveLength(2);
  });
});
