import { describe, expect, it } from "vitest";
import { DIMENSIONS, isDimension } from "@/lib/quality-distribution";
import { readFilters } from "@/lib/data";

describe("quality distribution", () => {
  it("accepts only the fixed dimensions (nothing from the URL reaches the SQL)", () => {
    for (const k of Object.keys(DIMENSIONS)) expect(isDimension(k)).toBe(true);
    for (const bad of [undefined, "", "toString", "constructor", "f.name; drop table facilities", "__proto__"]) expect(isDimension(bad)).toBe(false);
  });

  it("reads the ward filter from the URL", () => {
    expect(readFilters(new URLSearchParams("ward=TZ.ET.DS.IL.2.1")).ward).toBe("TZ.ET.DS.IL.2.1");
    expect(readFilters(new URLSearchParams("ward=")).ward).toBeUndefined();
  });
});
