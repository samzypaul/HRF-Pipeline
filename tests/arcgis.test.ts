import { describe, expect, it } from "vitest";
import { arcgisNames } from "@/lib/geo/arcgis";
import { compareVillage } from "@/lib/geo/village";

describe("ArcGIS reverse names", () => {
  it("keeps the area parts once, most specific first", () => {
    expect(arcgisNames({ Neighborhood: "Chipanga", District: "Bahi", City: "Bahi", Region: "Dodoma" })).toEqual(["Chipanga", "Bahi", "Dodoma"]);
    expect(arcgisNames(undefined)).toEqual([]);
  });
});

describe("village check", () => {
  it("agrees when the polygon village matches the HFR village", () => {
    const r = compareVillage({ name: "Mtaa wa Kati", ward_name: "Chipanga" }, "Mtaa wa Kati", "Chipanga Ward");
    expect(r).toMatchObject({ check: "agrees", wardDiffers: false });
  });
  it("differs when the village is different but the ward is the same", () => {
    const r = compareVillage({ name: "Nzali", ward_name: "Chipanga" }, "Mtaa wa Kati", "Chipanga");
    expect(r).toMatchObject({ check: "differs", wardDiffers: false });
  });
  it("flags a polygon that belongs to another ward", () => {
    expect(compareVillage({ name: "Nzali", ward_name: "Mpwapwa" }, "Nzali", "Chipanga").wardDiffers).toBe(true);
  });
  it("is unknown without a polygon or an HFR village, and never flags a missing ward name", () => {
    expect(compareVillage(null, "Nzali", "Chipanga")).toMatchObject({ check: "unknown", wardDiffers: false });
    expect(compareVillage({ name: "Nzali", ward_name: null }, null, "Chipanga")).toMatchObject({ check: "unknown", wardDiffers: false });
  });
});

describe("council polygon matching", () => {
  const rows = [
    { id: 1, name: "Arusha CC", district_name: "Arusha", region_name: "Arusha" },
    { id: 2, name: "Arusha DC", district_name: "Arusha", region_name: "Arusha" },
    { id: 3, name: "Kinondoni MC", district_name: "Kinondoni", region_name: "Dar-es-salaam" },
  ];
  it("tells councils with the same base name apart", async () => {
    const { pickCouncil } = await import("@/lib/geo/council");
    expect(pickCouncil(rows, "Arusha CC", "Arusha")).toBe(1);
    expect(pickCouncil(rows, "Arusha DC", "Arusha")).toBe(2);
    expect(pickCouncil(rows, "Kinondoni MC", "Dar es Salaam")).toBe(3);
    expect(pickCouncil(rows, "Nowhere DC", "Arusha")).toBeNull();
  });
});
