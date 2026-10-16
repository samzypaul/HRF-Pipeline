import { describe, expect, it } from "vitest";
import { namesFrom, wardNameCheck } from "@/lib/geo/maptiler";

describe("MapTiler ward name check", () => {
  const names = namesFrom([{ text: "Bahi", context: [{ text: "Bahi District" }, { text: "Dodoma" }] }]);
  it("collects the feature and its parents once", () => {
    expect(namesFrom([{ text: "A", context: [{ text: "B" }, { text: "A" }] }])).toEqual(["A", "B"]);
  });
  it("agrees when the ward or council name is returned", () => {
    expect(wardNameCheck(names, "Bahi", null)).toBe("agrees");
    expect(wardNameCheck(["Mpwapwa"], "Chipanga", "Bahi DC")).toBe("differs");
    expect(wardNameCheck(names, "Chipanga", "Bahi DC")).toBe("agrees");
  });
  it("is unknown without names", () => {
    expect(wardNameCheck([], "Bahi", "Bahi DC")).toBe("unknown");
  });
});

describe("Google reverse names", () => {
  it("keeps only area-type components", async () => {
    const { googleNames } = await import("@/lib/geo/google");
    expect(
      googleNames([
        { address_components: [{ long_name: "Chipanga", types: ["administrative_area_level_3", "political"] }, { long_name: "Tanzania", types: ["country"] }] },
        { address_components: [{ long_name: "Bahi", types: ["administrative_area_level_2"] }, { long_name: "Chipanga", types: ["sublocality_level_1"] }] },
      ]),
    ).toEqual(["Chipanga", "Bahi"]);
  });
});

describe("provider choice", () => {
  it("auto prefers MapTiler, then Google, else none", async () => {
    const { resolveProvider } = await import("@/lib/geo/provider");
    const saved = { m: process.env.MAPTILER_API_KEY, g: process.env.GOOGLE_MAPS_API_KEY };
    try {
      process.env.MAPTILER_API_KEY = "m";
      process.env.GOOGLE_MAPS_API_KEY = "g";
      expect(resolveProvider("auto")).toBe("maptiler");
      expect(resolveProvider("google")).toBe("google");
      delete process.env.MAPTILER_API_KEY;
      expect(resolveProvider("auto")).toBe("google");
      expect(resolveProvider("maptiler")).toBeNull();
      delete process.env.GOOGLE_MAPS_API_KEY;
      expect(resolveProvider("auto")).toBeNull();
    } finally {
      for (const [k, v] of [["MAPTILER_API_KEY", saved.m], ["GOOGLE_MAPS_API_KEY", saved.g]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
