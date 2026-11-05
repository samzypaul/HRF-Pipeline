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

describe("all providers at once", () => {
  it("all uses every provider that has a key, in priority order", async () => {
    const { resolveProviders } = await import("@/lib/geo/provider");
    const saved = { m: process.env.MAPTILER_API_KEY, g: process.env.GOOGLE_MAPS_API_KEY, a: process.env.ARCGIS_API_KEY };
    try {
      process.env.MAPTILER_API_KEY = "m";
      process.env.GOOGLE_MAPS_API_KEY = "g";
      process.env.ARCGIS_API_KEY = "a";
      expect(resolveProviders("all")).toEqual(["maptiler", "arcgis", "google"]);
      delete process.env.MAPTILER_API_KEY;
      expect(resolveProviders("all")).toEqual(["arcgis", "google"]);
      expect(resolveProviders("arcgis")).toEqual(["arcgis"]);
      expect(resolveProviders("maptiler")).toEqual([]);
    } finally {
      for (const [k, v] of [["MAPTILER_API_KEY", saved.m], ["GOOGLE_MAPS_API_KEY", saved.g], ["ARCGIS_API_KEY", saved.a]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
  it("one provider failing or being unavailable does not hide the others", async () => {
    const { acrossProviders } = await import("@/lib/geo/provider");
    const { ArcgisUnavailable } = await import("@/lib/geo/arcgis");
    const r = await acrossProviders(["google", "arcgis", "maptiler"], async (p) => {
      if (p === "arcgis") throw new ArcgisUnavailable("cap");
      if (p === "google") throw new Error("timeout");
      return [p];
    });
    expect(r.answers).toEqual([{ provider: "maptiler", value: ["maptiler"] }]);
    expect(r.unavailable).toEqual(["arcgis"]);
    expect(r.errors.map((e) => e.provider)).toEqual(["google"]);
  });
  it("combines ward checks: one agreement settles it", async () => {
    const { combineWardChecks } = await import("@/lib/geo/maptiler");
    expect(combineWardChecks(["differs", "agrees"])).toBe("agrees");
    expect(combineWardChecks(["differs", "unknown"])).toBe("differs");
    expect(combineWardChecks(["unknown"])).toBe("unknown");
    expect(combineWardChecks([])).toBe("unknown");
  });
});

describe("ranking geocoder candidates by their own score", () => {
  it("puts the highest score first and keeps the answering order for ties", async () => {
    const { byScoreDesc } = await import("@/lib/geo/provider");
    const out = byScoreDesc([{ id: "a", score: 72 }, { id: "b", score: 95 }, { id: "c", score: 72 }, { id: "d", score: 88 }]);
    expect(out.map((p) => p.id)).toEqual(["b", "d", "a", "c"]);
  });
  it("leaves a provider without scores in the order it answered, and ranks unscored results last", async () => {
    const { byScoreDesc } = await import("@/lib/geo/provider");
    type P = { id: string; score?: number };
    const plain: P[] = [{ id: "x" }, { id: "y" }, { id: "z" }];
    expect(byScoreDesc(plain).map((p) => p.id)).toEqual(["x", "y", "z"]);
    const mixed: P[] = [{ id: "x" }, { id: "y", score: 0 }];
    expect(byScoreDesc(mixed).map((p) => p.id)).toEqual(["y", "x"]);
  });
  it("does not change its input", async () => {
    const { byScoreDesc } = await import("@/lib/geo/provider");
    const input = [{ score: 1 }, { score: 2 }];
    byScoreDesc(input);
    expect(input).toEqual([{ score: 1 }, { score: 2 }]);
  });
  it("ranks Google's location types from exact to approximate", async () => {
    const { LOCATION_TYPE_SCORE } = await import("@/lib/geo/google");
    expect(LOCATION_TYPE_SCORE.ROOFTOP).toBeGreaterThan(LOCATION_TYPE_SCORE.RANGE_INTERPOLATED);
    expect(LOCATION_TYPE_SCORE.RANGE_INTERPOLATED).toBeGreaterThan(LOCATION_TYPE_SCORE.GEOMETRIC_CENTER);
    expect(LOCATION_TYPE_SCORE.GEOMETRIC_CENTER).toBeGreaterThan(LOCATION_TYPE_SCORE.APPROXIMATE);
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
