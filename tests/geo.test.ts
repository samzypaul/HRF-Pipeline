import { describe, expect, it } from "vitest";
import { nameScore, normalizeName, tokenSetRatio } from "@/lib/geo/name-match";
import { checkPoint } from "@/lib/geo/sanity";
import { grade, type GradeInput } from "@/lib/geo/grade";
import { normAdmin } from "@/lib/geo/wards";

describe("name matching", () => {
  it("ignores facility-type words in English and Swahili", () => {
    expect(normalizeName("Zahanati ya Bahi")).toBe("bahi");
    expect(normalizeName("BAHI Dispensary")).toBe("bahi");
    expect(nameScore("Zahanati ya Bahi", "Bahi Dispensary")).toBe(100);
    expect(nameScore("Kituo cha Afya Mlowo", "Mlowo Health Centre")).toBe(100);
  });
  it("tolerates small spelling differences", () => {
    expect(nameScore("Nyamirembe Dispensary", "Nyamiremba Dispensary")).toBeGreaterThanOrEqual(85);
  });
  it("does not match different places", () => {
    expect(nameScore("Bahi Health Centre", "Chibelela Dispensary")).toBeLessThan(60);
  });
  it("token set ratio is order-insensitive", () => {
    expect(tokenSetRatio("aga khan masaki", "masaki aga khan")).toBe(100);
  });
});

describe("sanity checks", () => {
  it("accepts a normal Tanzanian point", () => {
    expect(checkPoint(-2.53297, 31.69503)).toEqual({ flags: [], usable: true });
  });
  it("flags missing, zero and the portal default", () => {
    expect(checkPoint(null, null).flags).toEqual(["missing"]);
    expect(checkPoint(0, 0).usable).toBe(false);
    expect(checkPoint(-6.17964, 35.7436).flags).toEqual(["portal_default"]);
  });
  it("fixes swapped coordinates", () => {
    const r = checkPoint(31.69503, -2.53297);
    expect(r.flags).toContain("swapped_lat_lng");
    expect(r.fixed).toEqual({ lat: -2.53297, lng: 31.69503 });
  });
  it("rejects points outside Tanzania", () => {
    const r = checkPoint(51.5012, -0.1245);
    expect(r.usable).toBe(false);
    expect(r.flags).toContain("outside_tanzania");
  });
});

const base: GradeInput = {
  sanity: { flags: [], usable: true },
  hfrPoint: { lat: -6.5, lng: 35.1 },
  hasBoundary: true,
  inWard: true,
  nearMatch: null,
  relocation: null,
  geocode: null,
  centroid: { source: "ward_centroid", lat: -6.51, lng: 35.11, inWard: true },
  review: null,
};

describe("grade", () => {
  it("high: in ward + close name match", () => {
    expect(grade({ ...base, nearMatch: { source: "osm", score: 92, distanceM: 120 } }).confidence).toBe("high");
  });
  it("medium: in ward, match too far away", () => {
    expect(grade({ ...base, nearMatch: { source: "osm", score: 92, distanceM: 1500 } }).confidence).toBe("medium");
  });
  it("low: outside ward, keeps the HFR point", () => {
    const r = grade({ ...base, inWard: false });
    expect(r.confidence).toBe("low");
    expect(r.final).toEqual(base.hfrPoint);
  });
  it("medium: outside ward but a matching place inside the ward replaces it", () => {
    const r = grade({ ...base, inWard: false, relocation: { source: "osm_match", lat: -6.52, lng: 35.12, inWard: true } });
    expect(r).toMatchObject({ confidence: "medium", geocodeSource: "osm_match", final: { lat: -6.52, lng: 35.12 } });
  });
  it("low with ward centre when there is no usable point", () => {
    const r = grade({ ...base, sanity: { flags: ["missing"], usable: false }, hfrPoint: null, inWard: null });
    expect(r).toMatchObject({ confidence: "low", geocodeSource: "ward_centroid" });
  });
  it("medium when a missing point is geocoded inside the ward", () => {
    const r = grade({
      ...base,
      sanity: { flags: ["missing"], usable: false },
      hfrPoint: null,
      inWard: null,
      geocode: { source: "nominatim", lat: -6.505, lng: 35.105, inWard: true },
    });
    expect(r).toMatchObject({ confidence: "medium", geocodeSource: "nominatim" });
  });
  it("reviewer decision always wins", () => {
    const r = grade({ ...base, inWard: false, review: { decision: "manual", lat: -6.6, lng: 35.2 } });
    expect(r).toMatchObject({ confidence: "high", geocodeSource: "review", final: { lat: -6.6, lng: 35.2 } });
  });
});

describe("admin name normalisation", () => {
  it("strips unit words", () => {
    expect(normAdmin("Kinondoni MC")).toBe("kinondoni");
    expect(normAdmin("Dar es Salaam Region")).toBe("dar es salaam");
  });
});
