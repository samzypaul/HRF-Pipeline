import { describe, expect, it } from "vitest";
import { MAX_LIMIT, facilityView, parseFacilityQuery, parseLang, serviceView } from "@/lib/climate/api";
import { rateLimit } from "@/lib/climate/http";
import { openApiSpec } from "@/lib/climate/openapi";
import { climateServiceFor } from "@/lib/climate/catalogue";

const MRDT = climateServiceFor("Malaria Diagnosis and Treatment", "mRDT - Rapid Diagnostic Tests")!.code;
const ANC = climateServiceFor("Reproductive and Child Health Care Services", "Antenatal Care")!.code;

const parse = (qs: string) => parseFacilityQuery(new URLSearchParams(qs));

describe("public API: facility query", () => {
  it("uses sensible defaults", () => {
    const r = parse("");
    expect(r).toMatchObject({ ok: true, value: { lang: "en", services: [], tiers: [], limit: 50, offset: 0 } });
  });
  it("reads services, tiers, region, text and language", () => {
    const r = parse(`service=${MRDT.toLowerCase()},${ANC.toLowerCase()}&tier=1,2&region=tz.cl.do&q= dispensary &lang=sw&limit=10&offset=20`);
    expect(r).toMatchObject({ ok: true, value: { services: [MRDT, ANC], tiers: [1, 2], region: "TZ.CL.DO", q: "dispensary", lang: "sw", limit: 10, offset: 20 } });
  });
  it("needs lat and lng together and keeps the radius within bounds", () => {
    expect(parse("lat=-6.8&lng=39.28")).toMatchObject({ ok: true, value: { near: { lat: -6.8, lng: 39.28, radiusKm: 25 } } });
    expect(parse("lat=-6.8")).toMatchObject({ ok: false });
    expect(parse("lat=abc&lng=39")).toMatchObject({ ok: false });
    expect(parse("lat=95&lng=39")).toMatchObject({ ok: false });
    expect(parse("lat=-6&lng=39&radius_km=0")).toMatchObject({ ok: false });
    expect(parse("lat=-6&lng=39&radius_km=1000")).toMatchObject({ ok: false });
  });
  it("rejects what it cannot understand instead of passing it on", () => {
    expect(parse("service=NOPE")).toMatchObject({ ok: false });
    expect(parse("tier=9")).toMatchObject({ ok: false });
    expect(parse("tier=one")).toMatchObject({ ok: false });
    expect(parse("region=Dar es Salaam")).toMatchObject({ ok: false });
    expect(parse("region=TZ.CL.DO;DROP")).toMatchObject({ ok: false });
    expect(parse("lang=fr")).toMatchObject({ ok: false });
    expect(parse("min_confidence=low")).toMatchObject({ ok: false });
    expect(parse(`limit=${MAX_LIMIT + 1}`)).toMatchObject({ ok: false });
    expect(parse("limit=0")).toMatchObject({ ok: false });
    expect(parse("offset=-1")).toMatchObject({ ok: false });
    expect(parse(`q=${"a".repeat(81)}`)).toMatchObject({ ok: false });
  });
  it("parses the language alone", () => {
    expect(parseLang(new URLSearchParams("lang=sw"))).toEqual({ ok: true, value: "sw" });
    expect(parseLang(new URLSearchParams(""))).toEqual({ ok: true, value: "en" });
  });
});

describe("public API: what is shown", () => {
  const row = {
    facility_code: "121333-9",
    name: "A TO Z",
    facility_type: "Dispensary",
    ownership_category: "Private",
    region_code: "TZ.NT.AS",
    region_name: "Arusha Region",
    district_name: "Arusha District",
    council_code: "TZ.NT.AS.AS.3",
    council_name: "Arusha CC",
    ward_name: "Olmoti",
    village_name: "Ngaramtoni",
    lat: -3.38,
    lng: 36.59,
    confidence: "high",
    source: "hfr",
    phone: "+255784755558",
    distance_km: null,
    total: 1,
  };
  it("gives the phone number and the services in the chosen language, never internal fields", () => {
    const en = facilityView(row, [ANC, MRDT], "en");
    expect(en.phone).toBe("+255784755558");
    expect(en.services.map((s) => s.code)).toEqual([MRDT, ANC]); // tier 1 before tier 2
    expect(en.services[0].name).toBe("mRDT - Rapid Diagnostic Tests"); // the portal's own text
    expect(en.services[0].category).toBe("Malaria Diagnosis and Treatment");
    expect(facilityView(row, [ANC], "sw").services[0].name).toBe("Huduma za Kliniki ya Wajawazito");
    for (const hidden of ["confidence_score", "notes", "sanity_flags", "review_decision", "hfr_lat", "geocode_source", "region_code", "council_code"]) {
      expect(JSON.stringify(en)).not.toContain(`"${hidden}"`);
    }
  });
  it("marks a stand-in or unconfirmed point as approximate", () => {
    expect(facilityView(row, [], "en").location.approximate).toBe(false);
    expect(facilityView({ ...row, confidence: "low" }, [], "en").location.approximate).toBe(true);
    expect(facilityView({ ...row, source: "village_centroid", confidence: "high" }, [], "en").location.approximate).toBe(true);
    expect(facilityView({ ...row, confidence: null }, [], "en").location).toMatchObject({ approximate: true, confidence: "unchecked" });
  });
  it("adds the distance only when one was computed", () => {
    expect(facilityView(row, [], "en")).not.toHaveProperty("distance_km");
    expect(facilityView({ ...row, distance_km: 1.234 }, [], "en")).toMatchObject({ distance_km: 1.2 });
  });
  it("ignores a service code it does not know", () => {
    expect(serviceView("NOPE", "en")).toBeNull();
  });
});

describe("public API: rate limit", () => {
  it("allows a burst up to the limit, then asks the client to wait, then resets", () => {
    const ip = "203.0.113.7";
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(rateLimit(ip, t0 + i, 5, 60_000).ok).toBe(true);
    const blocked = rateLimit(ip, t0 + 10, 5, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(rateLimit(ip, t0 + 61_000, 5, 60_000).ok).toBe(true);
  });
  it("counts each address separately", () => {
    const t0 = 5_000_000;
    for (let i = 0; i < 3; i++) rateLimit("198.51.100.1", t0, 3, 60_000);
    expect(rateLimit("198.51.100.1", t0, 3, 60_000).ok).toBe(false);
    expect(rateLimit("198.51.100.2", t0, 3, 60_000).ok).toBe(true);
  });
});

describe("public API: OpenAPI description", () => {
  it("lists every endpoint and the service codes", () => {
    const spec = openApiSpec("https://example.org");
    expect(Object.keys(spec.paths)).toEqual([
      "/api/v1/climate/facilities",
      "/api/v1/climate/facilities/{code}",
      "/api/v1/climate/services",
      "/api/v1/climate/regions",
    ]);
    expect(JSON.stringify(spec)).toContain("CS001");
    expect(spec.servers[0].url).toBe("https://example.org");
  });
});
