import { describe, expect, it } from "vitest";
import { MAX_LISTED, groupShared, pointKey, sharingStatus } from "@/lib/geo/shared";
import { groupRows } from "@/lib/notify/shared";

const f = (code: string, name: string, lat: number | null, lng: number | null) => ({ code, name, lat, lng });

describe("facilities that share a point", () => {
  it("marks facilities on the same point and lists the others by name and code", () => {
    const out = groupShared([f("1-1", "Bahi Dispensary", -6.1, 35.2), f("2-2", "Chipanga Dispensary", -6.1, 35.2), f("3-3", "Nzali Dispensary", -6.2, 35.3)]);
    expect(out.get("1-1")).toEqual({ count: 1, with: "Chipanga Dispensary (2-2)" });
    expect(out.get("2-2")).toEqual({ count: 1, with: "Bahi Dispensary (1-1)" });
    expect(out.get("3-3")).toEqual({ count: 0, with: null });
  });
  it("never lists a facility with itself, and orders the others by name", () => {
    const out = groupShared([f("a", "Zeta", 1, 1), f("b", "Alpha", 1, 1), f("c", "Mid", 1, 1)]);
    expect(out.get("a")?.with).toBe("Alpha (b); Mid (c)");
    expect(out.get("b")?.with).toBe("Mid (c); Zeta (a)");
    expect(out.get("a")?.count).toBe(2);
  });
  it("treats points that differ only below about 0.1 m as the same, and further apart as different", () => {
    expect(pointKey(-6.1234561, 35.2)).toBe(pointKey(-6.1234564, 35.2));
    const out = groupShared([f("a", "A", -6.123456, 35.2), f("b", "B", -6.123458, 35.2)]);
    expect(out.get("a")?.count).toBe(0);
  });
  it("ignores facilities without a point", () => {
    const out = groupShared([f("a", "A", null, null), f("b", "B", null, null), f("c", "C", 1, 1)]);
    expect(out.get("a")).toEqual({ count: 0, with: null });
    expect(out.get("c")).toEqual({ count: 0, with: null });
  });
  it("cuts a long list and says how many more", () => {
    const many = Array.from({ length: MAX_LISTED + 5 }, (_, i) => f(`c${String(i).padStart(2, "0")}`, `Name ${String(i).padStart(2, "0")}`, 1, 1));
    const out = groupShared(many);
    const first = out.get("c00")!;
    expect(first.count).toBe(MAX_LISTED + 4);
    expect(first.with!.split("; ")).toHaveLength(MAX_LISTED + 1);
    expect(first.with).toMatch(/; and 4 more$/);
  });
  it("gives the status a data table shows", () => {
    expect(sharingStatus(true, 2)).toBe("shared");
    expect(sharingStatus(true, 0)).toBe("not shared");
    expect(sharingStatus(true, null)).toBe("not shared");
    expect(sharingStatus(false, 3)).toBe("no location");
  });
});

describe("the email to the team", () => {
  const row = (code: string, lat: number, lng: number) => ({ facility_code: code, name: code, council_name: null, ward_name: null, lat, lng, geocode_source: "hfr" });
  it("groups facilities by point, biggest group first", () => {
    const groups = groupRows([row("a", 1, 1), row("b", 2, 2), row("c", 2, 2), row("d", 2, 2), row("e", 1, 1)]);
    expect(groups.map((g) => g.members.length)).toEqual([3, 2]);
    expect(groups[0].members.map((m) => m.facility_code)).toEqual(["b", "c", "d"]);
  });
});
