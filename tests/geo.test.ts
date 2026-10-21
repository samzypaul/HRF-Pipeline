import { describe, expect, it } from "vitest";
import { nameScore, nameIsWeak, normalizeName, tokenSetRatio, MATCH_SCORE } from "@/lib/geo/name-match";
import { checkPoint } from "@/lib/geo/sanity";
import { adjustGrade, grade, type GradeInput } from "@/lib/geo/grade";
import { pickVillage, pickVillageInCouncil } from "@/lib/geo/village";
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
  it("high up to 1 km, medium to 3.5 km, low beyond", () => {
    const at = (distanceM: number) => grade({ ...base, nearMatch: { source: "osm", score: 92, distanceM } }).confidence;
    expect(at(1000)).toBe("high");
    expect(at(1001)).toBe("medium");
    expect(at(3500)).toBe("medium");
    expect(at(3501)).toBe("low");
  });
  it("low: in ward but no name match", () => {
    expect(grade({ ...base, nearMatch: null }).confidence).toBe("low");
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

describe("name matching: distinctive words", () => {
  it("does not match on generic words alone", () => {
    expect(nameScore("Mission Dispensary", "Mission Hospital")).toBeLessThan(MATCH_SCORE);
    expect(nameScore("Kati Zahanati", "Kati Clinic")).toBeLessThan(MATCH_SCORE);
  });
  it("needs a shared distinctive word", () => {
    expect(nameScore("Nyakato Mission Dispensary", "Bukoba Mission Dispensary")).toBeLessThan(MATCH_SCORE);
    expect(nameScore("Nyakato Mission Dispensary", "Nyakato Dispensary")).toBeGreaterThanOrEqual(MATCH_SCORE);
  });
  it("flags names whose distinctive part is very short", () => {
    expect(nameIsWeak("Ido Dispensary")).toBe(true);
    expect(nameIsWeak("Mission Dispensary")).toBe(true);
    expect(nameIsWeak("Bahi Dispensary")).toBe(false);
  });
});

describe("grade: council, weak names, stand-ins", () => {
  it("a weak name match cannot reach high", () => {
    const r = grade({ ...base, nearMatch: { source: "osm", score: 100, distanceM: 100, weak: true } });
    expect(r.confidence).toBe("medium");
  });
  it("low when the HFR point is outside its council", () => {
    const r = grade({ ...base, hfrOutsideCouncil: true, nearMatch: { source: "osm", score: 92, distanceM: 100 } });
    expect(r.confidence).toBe("low");
    expect(r.final).toEqual(base.hfrPoint);
  });
  it("a geocoded point inside the council replaces a point outside it", () => {
    const r = grade({ ...base, hfrOutsideCouncil: true, geocode: { source: "nominatim", lat: -6.5, lng: 35.2, inWard: true } });
    expect(r).toMatchObject({ confidence: "medium", geocodeSource: "nominatim" });
  });
  it("grades the village centre medium: the right village, even if not the building", () => {
    const r = grade({
      ...base,
      sanity: { flags: ["missing"], usable: false },
      hfrPoint: null,
      inWard: null,
      villageCentroid: { source: "village_centroid", lat: -6.52, lng: 35.13, inWard: true },
    });
    expect(r).toMatchObject({ confidence: "medium", geocodeSource: "village_centroid", final: { lat: -6.52, lng: 35.13 } });
    expect(r.notes.join(" ")).toContain("centre of the HFR village");
  });
  it("still grades a ward or council centre low", () => {
    const none = { ...base, sanity: { flags: ["missing" as const], usable: false }, hfrPoint: null, inWard: null };
    expect(grade({ ...none, centroid: { source: "ward_centroid", lat: -6.5, lng: 35.1, inWard: true } })).toMatchObject({ confidence: "low", geocodeSource: "ward_centroid" });
    expect(grade({ ...none, centroid: null, councilCentroid: { source: "council_centroid", lat: -6.5, lng: 35.1, inWard: null } })).toMatchObject({ confidence: "low", geocodeSource: "council_centroid" });
  });
  it("moves a point outside its village to a geocoded point inside the village", () => {
    const r = grade({ ...base, hfrOutsideVillage: true, geocode: { source: "nominatim", lat: -6.52, lng: 35.12, inWard: true, inVillage: true } });
    expect(r).toMatchObject({ confidence: "medium", geocodeSource: "nominatim", final: { lat: -6.52, lng: 35.12 } });
  });
  it("keeps a point outside its village when a close name match confirms it", () => {
    const r = grade({
      ...base,
      hfrOutsideVillage: true,
      nearMatch: { source: "osm", score: 95, distanceM: 200 },
      geocode: { source: "nominatim", lat: -6.52, lng: 35.12, inWard: true, inVillage: true },
    });
    expect(r).toMatchObject({ geocodeSource: "hfr", final: base.hfrPoint });
  });
  it("keeps a point outside its village when the geocoded point is not inside the village either", () => {
    const r = grade({ ...base, hfrOutsideVillage: true, geocode: { source: "nominatim", lat: -6.52, lng: 35.12, inWard: true, inVillage: false } });
    expect(r).toMatchObject({ geocodeSource: "hfr", final: base.hfrPoint });
    expect(r.notes.join(" ")).toContain("outside its registered village");
  });
  it("uses the village centre when the only geocoded point is outside the village", () => {
    const r = grade({
      ...base,
      sanity: { flags: ["missing"], usable: false },
      hfrPoint: null,
      inWard: null,
      geocode: { source: "nominatim", lat: -6.6, lng: 35.2, inWard: true, inVillage: false },
      villageCentroid: { source: "village_centroid", lat: -6.52, lng: 35.13, inWard: true, inVillage: true },
    });
    expect(r).toMatchObject({ geocodeSource: "village_centroid", final: { lat: -6.52, lng: 35.13 } });
  });
  it("uses a geocoded point inside the village before the village centre", () => {
    const r = grade({
      ...base,
      sanity: { flags: ["missing"], usable: false },
      hfrPoint: null,
      inWard: null,
      geocode: { source: "arcgis_geocode", lat: -6.53, lng: 35.14, inWard: true, inVillage: true },
      villageCentroid: { source: "village_centroid", lat: -6.52, lng: 35.13, inWard: true, inVillage: true },
    });
    expect(r).toMatchObject({ geocodeSource: "arcgis_geocode", final: { lat: -6.53, lng: 35.14 } });
  });
  it("grades a same-named place inside the village as high when there is no HFR point", () => {
    const r = grade({
      ...base,
      sanity: { flags: ["missing"], usable: false },
      hfrPoint: null,
      inWard: null,
      relocation: { source: "osm_match", lat: -6.53, lng: 35.14, inWard: true, inVillage: true, confirmed: true, score: 95 },
    });
    expect(r).toMatchObject({ confidence: "high", geocodeSource: "osm_match" });
  });
  it("keeps a name-matched place outside the village at medium", () => {
    const r = grade({
      ...base,
      sanity: { flags: ["missing"], usable: false },
      hfrPoint: null,
      inWard: null,
      relocation: { source: "osm_match", lat: -6.53, lng: 35.14, inWard: true, inVillage: null, confirmed: true, score: 95 },
    });
    expect(r.confidence).toBe("medium");
  });
  it("falls back to the council centre when there is no village or ward centre", () => {
    const r = grade({
      ...base,
      sanity: { flags: ["missing"], usable: false },
      hfrPoint: null,
      inWard: null,
      hasBoundary: false,
      centroid: null,
      councilCentroid: { source: "council_centroid", lat: -6.8, lng: 35.4, inWard: null },
    });
    expect(r).toMatchObject({ confidence: "low", geocodeSource: "council_centroid", final: { lat: -6.8, lng: 35.4 } });
  });
});

describe("adjustGrade", () => {
  const medium = { confidence: "medium" as const, final: { lat: -6.5, lng: 35.1 }, geocodeSource: "hfr", notes: [] as string[] };
  const none = { village: null, geocoderWardDiffers: false, sharedPoint: false, inWard: true };
  it("lifts a geocoded point inside its village to high when the reverse geocoder confirms the ward", () => {
    const geocoded = { ...medium, geocodeSource: "arcgis_geocode" };
    expect(adjustGrade(geocoded, { ...none, inVillage: true, geocoderWardAgrees: true }).confidence).toBe("high");
    expect(adjustGrade(geocoded, { ...none, inVillage: true, geocoderWardAgrees: false }).confidence).toBe("medium");
    expect(adjustGrade(geocoded, { ...none, inVillage: null, geocoderWardAgrees: true }).confidence).toBe("medium");
  });
  it("village and ward agreeing raises the grade one step", () => {
    expect(adjustGrade(medium, { ...none, village: { check: "agrees", wardDiffers: false } }).confidence).toBe("high");
    expect(adjustGrade({ ...medium, confidence: "low" }, { ...none, village: { check: "agrees", wardDiffers: false } }).confidence).toBe("medium");
  });
  it("does not raise a point outside its ward", () => {
    expect(adjustGrade(medium, { ...none, inWard: false, village: { check: "agrees", wardDiffers: false } }).confidence).toBe("medium");
  });
  it("a village in another ward lowers the grade; with the geocoder disagreeing too it is low", () => {
    expect(adjustGrade({ ...medium, confidence: "high" }, { ...none, village: { check: "differs", wardDiffers: true } }).confidence).toBe("medium");
    expect(adjustGrade({ ...medium, confidence: "high" }, { ...none, village: { check: "differs", wardDiffers: true }, geocoderWardDiffers: true }).confidence).toBe("low");
  });
  it("a shared point is lowered one step", () => {
    expect(adjustGrade({ ...medium, confidence: "high" }, { ...none, sharedPoint: true }).confidence).toBe("medium");
  });
  it("leaves reviewer decisions and stand-in centres alone", () => {
    const review = { ...medium, confidence: "high" as const, geocodeSource: "review" };
    expect(adjustGrade(review, { ...none, sharedPoint: true, geocoderWardDiffers: true })).toBe(review);
    const stand = { ...medium, confidence: "low" as const, geocodeSource: "village_centroid" };
    expect(adjustGrade(stand, { ...none, village: { check: "agrees", wardDiffers: false } })).toBe(stand);
  });
});

describe("pickVillage", () => {
  const v = (id: number, name: string, ward: string, district = "Moshi", region = "Kilimanjaro") =>
    ({ id, name, ward_name: ward, district_name: district, region_name: region, lat: -3.3, lng: 37.3 });
  it("finds the village in the same ward and region", () => {
    const rows = [v(1, "Mwika Kati", "Mwika"), v(2, "Kifuni", "Mwika"), v(3, "Kifuni", "Other")];
    expect(pickVillage(rows, "Kifuni", "Mwika Ward", "Moshi DC", "Kilimanjaro Region")?.id).toBe(2);
  });
  it("returns null when the name does not match or the ward is unknown", () => {
    expect(pickVillage([v(1, "Kifuni", "Mwika")], "Marangu", "Mwika", "Moshi DC", "Kilimanjaro Region")).toBeNull();
    expect(pickVillage([v(1, "Kifuni", "Mwika")], "Kifuni", null, "Moshi DC", "Kilimanjaro Region")).toBeNull();
  });
  it("uses the council to break a tie, and gives up when it cannot", () => {
    const rows = [v(1, "Kifuni", "Mwika", "Moshi"), v(2, "Kifuni", "Mwika", "Hai")];
    expect(pickVillage(rows, "Kifuni", "Mwika", "Hai DC", "Kilimanjaro Region")?.id).toBe(2);
    expect(pickVillage([v(1, "Kifuni", "Mwika", "Moshi"), v(2, "Kifuni", "Mwika", "Moshi")], "Kifuni", "Mwika", "Moshi DC", "Kilimanjaro Region")).toBeNull();
  });
});

describe("pickVillageInCouncil (ward renamed since the village file)", () => {
  const v = (id: number, name: string, district: string, ward = "Old Ward", region = "Morogoro") =>
    ({ id, name, ward_name: ward, district_name: district, region_name: region, lat: -6.8, lng: 37.6 });
  it("finds the one village with the same name in the council, whatever its ward", () => {
    const rows = [v(1, "Genda", "Morogoro"), v(2, "Genda", "Kilosa"), v(3, "Mji Mpya", "Morogoro")];
    expect(pickVillageInCouncil(rows, "Genda", "Morogoro MC", "Morogoro Region")?.id).toBe(1);
  });
  it("gives up on two villages of that name in one council, a different name, or a missing council", () => {
    expect(pickVillageInCouncil([v(1, "Genda", "Morogoro"), v(2, "Genda", "Morogoro")], "Genda", "Morogoro MC", "Morogoro Region")).toBeNull();
    expect(pickVillageInCouncil([v(1, "Genda", "Morogoro")], "Gendaa", "Morogoro MC", "Morogoro Region")).toBeNull();
    expect(pickVillageInCouncil([v(1, "Genda", "Morogoro")], "Genda", null, "Morogoro Region")).toBeNull();
  });
  it("does not use a village from another region", () => {
    expect(pickVillageInCouncil([v(1, "Genda", "Morogoro", "W", "Tanga")], "Genda", "Morogoro MC", "Morogoro Region")).toBeNull();
  });
});

describe("admin name normalisation", () => {
  it("strips unit words", () => {
    expect(normAdmin("Kinondoni MC")).toBe("kinondoni");
    expect(normAdmin("Dar es Salaam Region")).toBe("dar es salaam");
  });
});
