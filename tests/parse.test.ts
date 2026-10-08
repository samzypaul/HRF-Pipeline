import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAddress, parseAdminJson, parseCoords, parseDetail, parseListPage, parseRegions, parseServices } from "@/lib/hfr/parse";

const fx = (name: string) => readFileSync(path.join(__dirname, "fixtures/hfr", name), "utf8");

describe("parseListPage", () => {
  it("reads rows, internal IDs and the total from the first page", () => {
    const p = parseListPage(fx("list-page1.html"));
    expect(p.total).toBeGreaterThan(14000);
    expect(p.from).toBe(1);
    expect(p.rows).toHaveLength(20);
    expect(p.rows[0]).toMatchObject({
      hfrId: 183,
      facilityCode: "122023-5",
      name: "BAHEBE HEALTH LABORATORY",
      regionName: "Geita Region",
      councilName: "Chato DC",
      operatingStatus: "Operating",
    });
    for (const r of p.rows) expect(r.facilityCode).toMatch(/^\d{6}-\d$/);
  });

  it("reads the last page with 50 rows per page", () => {
    const p = parseListPage(fx("list-last.html"));
    expect(p.to).toBe(p.total);
    expect(p.rows.length).toBe(p.total - (p.from ?? 0) + 1);
  });

  it("reads a ward-filtered list", () => {
    const p = parseListPage(fx("list-ward.html"));
    expect(p.total).toBe(5);
    expect(p.rows.map((r) => r.facilityCode)).toContain("113978-1");
  });

  it("returns no rows for an empty result", () => {
    const p = parseListPage('<div class="summary"></div><table class="kv-grid-table"><tbody><tr><td colspan="12"><div class="empty">No results found.</div></td></tr></tbody></table>');
    expect(p.rows).toHaveLength(0);
    expect(p.total).toBe(0);
  });
});

describe("parseDetail", () => {
  it("reads all labelled fields and the internal ID", () => {
    const d = parseDetail(fx("detail-agakhan.html"));
    expect(d).toMatchObject({
      hfrId: 607,
      facilityCode: "120284-5",
      name: "AGA KHAN MASAKI",
      commonName: "Aga Khan Outreach Health Centre, Masaki",
      operatingStatus: "Operating",
      dateOpened: "2026-07-06",
      facilityType: "Specialized Polyclinic",
      website: "agakhanhospitals.org",
      nearestFacility: "101813-4 - IST PolyClinic",
      ctcId: null,
    });
    expect(d.address).toEqual({
      zone: "Eastern Zone",
      regionName: "Dar es Salaam Region",
      districtName: "Kinondoni District",
      councilName: "Kinondoni MC",
      wardName: "Msasani",
      villageName: "Masaki",
    });
  });

  it("handles a second facility", () => {
    const d = parseDetail(fx("detail-bahebe.html"));
    expect(d.hfrId).toBe(183);
    expect(d.address.wardName).toBe("Nyamirembe");
  });
});

describe("parseAddress", () => {
  it("handles missing parts", () => {
    expect(parseAddress(null).regionName).toBeNull();
    expect(parseAddress("Lake Zone-Geita Region - Chato District").districtName).toBe("Chato District");
  });
});

describe("parseCoords", () => {
  it("reads lat/lng and ward", () => {
    expect(parseCoords(fx("coords-found.json"))).toMatchObject({ hfrId: 183, lat: -2.53297, lng: 31.69503, wardName: "Nyamirembe" });
  });
  it("returns null when the facility has no map record", () => {
    expect(parseCoords(fx("coords-empty.json"))).toBeNull();
    expect(parseCoords("not json")).toBeNull();
  });
});

describe("parseServices / admin / regions", () => {
  it("reads the services table", () => {
    const s = parseServices(fx("services.html"));
    expect(s.length).toBeGreaterThan(40);
    expect(s[0]).toEqual({ category: "General Clinical Services", description: "OPD - Outpatient Services" });
  });
  it("reads depdrop JSON", () => {
    const w = parseAdminJson(fx("admin-wards.json"));
    expect(w.find((x) => x.code === "TZ.CL.DO.BA.6.7")?.name).toBe("Bahi");
    expect(parseAdminJson("oops")).toEqual([]);
  });
  it("reads the region list", () => {
    const r = parseRegions(fx("advanced-search-regions.html"));
    expect(r).toHaveLength(26);
    expect(r[0]).toEqual({ code: "TZ.CL.DO", name: "Dodoma Region" });
  });
});
