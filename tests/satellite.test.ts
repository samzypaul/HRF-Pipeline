import { describe, expect, it } from "vitest";
import { adjustGrade, type GradeEvidence, type GradeResult } from "@/lib/geo/grade";
import { googleImageUrl, maptilerTileUrl, parseVerdict, satelliteLift, tilePlan } from "@/lib/geo/satellite";

describe("satellite picture address", () => {
  it("builds a Google Static Maps satellite address", () => {
    const u = new URL(googleImageUrl(-6.8, 39.28, 19, "KEY"));
    expect(u.hostname).toBe("maps.googleapis.com");
    expect(u.searchParams.get("maptype")).toBe("satellite");
    expect(u.searchParams.get("center")).toBe("-6.8,39.28");
    expect(u.searchParams.get("zoom")).toBe("19");
    expect(u.searchParams.get("size")).toBe("512x512");
  });
  it("builds a MapTiler satellite tile address", () => {
    expect(maptilerTileUrl(18, 156, 134, "K Y")).toBe("https://api.maptiler.com/tiles/satellite-v2/18/156/134.jpg?key=K%20Y");
  });
  it("plans the tiles that cover a picture centred on the point", () => {
    const p = tilePlan(-6.80097, 39.27964, 19);
    expect(p.z).toBe(18); // 512 px tiles: one zoom below the Google-style zoom
    expect(p.tiles).toHaveLength(p.cols * p.rows);
    expect(p.cols).toBeLessThanOrEqual(2);
    expect(p.rows).toBeLessThanOrEqual(2);
    expect(p.left).toBeGreaterThanOrEqual(0);
    expect(p.top).toBeGreaterThanOrEqual(0);
    expect(p.left + 512).toBeLessThanOrEqual(p.cols * 512);
    expect(p.top + 512).toBeLessThanOrEqual(p.rows * 512);
  });
  it("puts the point at the centre of the picture", () => {
    const p = tilePlan(-6.80097, 39.27964, 19);
    const world = 512 * 2 ** p.z;
    const px = ((39.27964 + 180) / 360) * world;
    expect(p.left + 256).toBeCloseTo(px - p.tiles[0].x * 512, 0);
  });
});

describe("parseVerdict", () => {
  it("reads yes, no and unclear", () => {
    expect(parseVerdict({ building_near_centre: "yes", reason: "A tin roof at the centre." })).toEqual({ status: "building", note: "A tin roof at the centre." });
    expect(parseVerdict({ building_near_centre: "no", reason: "Farmland." }).status).toBe("none");
    expect(parseVerdict({ building_near_centre: "unclear", reason: "Cloud." }).status).toBe("unclear");
  });
  it("never guesses: anything unexpected is unclear", () => {
    expect(parseVerdict(null).status).toBe("unclear");
    expect(parseVerdict({}).status).toBe("unclear");
    expect(parseVerdict({ building_near_centre: "maybe" }).status).toBe("unclear");
    expect(parseVerdict({ building_near_centre: "YES " }).status).toBe("building");
  });
  it("keeps the reason short", () => {
    expect(parseVerdict({ building_near_centre: "no", reason: "x".repeat(900) }).note).toHaveLength(300);
  });
});

describe("satelliteLift", () => {
  const both = { inVillage: true, inWard: true };
  it("lifts low to medium when a building is seen", () => {
    expect(satelliteLift("low", "building", { inVillage: null, inWard: null })).toBe("medium");
  });
  it("lifts medium to high only with the village or ward agreeing and neither disagreeing", () => {
    expect(satelliteLift("medium", "building", both)).toBe("high");
    expect(satelliteLift("medium", "building", { inVillage: true, inWard: null })).toBe("high");
    expect(satelliteLift("medium", "building", { inVillage: null, inWard: null })).toBe("medium");
    expect(satelliteLift("medium", "building", { inVillage: false, inWard: true })).toBe("medium");
  });
  it("never lowers or changes the grade for no building or unclear", () => {
    for (const status of ["none", "unclear", null] as const) for (const c of ["low", "medium", "high"] as const) expect(satelliteLift(c, status, both)).toBe(c);
    expect(satelliteLift("high", "building", both)).toBe("high");
  });
});

describe("adjustGrade with satellite evidence", () => {
  const none: GradeEvidence = { village: null, geocoderWardDiffers: false, sharedPoint: false, inWard: true };
  const low: GradeResult = { confidence: "low", final: { lat: -6.5, lng: 35.1 }, geocodeSource: "hfr", notes: [] };
  it("lifts a low point one step and says why", () => {
    const r = adjustGrade(low, { ...none, satellite: "building" });
    expect(r.confidence).toBe("medium");
    expect(r.notes.join(" ")).toContain("satellite imagery shows a building");
  });
  it("leaves the grade alone for no building or unclear, or when not checked", () => {
    for (const satellite of ["none", "unclear", null, undefined] as const) expect(adjustGrade(low, { ...none, satellite })).toBe(low);
  });
  it("does not lift a village or ward centre or a reviewer's point", () => {
    for (const geocodeSource of ["village_centroid", "ward_centroid", "council_centroid", "review"]) {
      const r = { ...low, geocodeSource };
      expect(adjustGrade(r, { ...none, satellite: "building" })).toBe(r);
    }
  });
});
