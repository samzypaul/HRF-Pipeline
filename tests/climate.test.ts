import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { SERVICES, SERVICE_BY_CODE, TIERS, UNMATCHED, climateServiceFor, type Tier } from "@/lib/climate/catalogue";
import { classifyService } from "@/lib/climate/classify";
import { CATEGORY_SW, NEEDS_REVIEW, SERVICE_SW } from "@/lib/climate/translations";
import { climatePredicate, readFilters } from "@/lib/data";
import { chosenServices, paramsFrom } from "@/lib/climate/dataset";

const code = (category: string, description: string) => classifyService(category, description)?.code;

describe("climate service catalogue", () => {
  it("has unique codes and a complete English and Kiswahili entry for every service", () => {
    expect(new Set(SERVICES.map((s) => s.code)).size).toBe(SERVICES.length);
    expect(new Set(SERVICES.map((s) => `${s.category}|${s.name}`)).size).toBe(SERVICES.length);
    for (const s of SERVICES) {
      expect(s.name, s.code).not.toBe("");
      expect(s.category, s.code).not.toBe("");
      expect(s.nameSw, s.code).not.toBe("");
      expect(s.categorySw, s.code).not.toBe("");
      expect(s.descEn, s.code).not.toBe("");
      expect(s.descSw, s.code).not.toBe("");
      expect(s.rationale, s.code).not.toBe("");
      expect(s.code, s.code).toMatch(/^CS\d{3}$/);
    }
  });
  it("keeps the portal's own category and service text, and the Kiswahili agrees with the translation tables", () => {
    for (const s of SERVICES) {
      expect(CATEGORY_SW[s.category], s.code).toBe(s.categorySw);
      expect(SERVICE_SW[s.name], s.code).toBe(s.nameSw);
    }
    // not renamed: the portal's spelling mistakes and odd categories stay as they are
    expect(code("Growth Monitoring / Nutrition Surveillance", "IMM-BASIC - Basic Immunization")).toBeDefined();
    expect(code("Mental Health and Substance Abuse Services", "Pyscho-Social care and support")).toBeDefined();
    expect(code("Oral Health Service (Dental Services)", "Surgical Intervetion")).toBeDefined();
  });
  it("names the five tiers in both languages and uses every one", () => {
    for (const t of [1, 2, 3, 4, 5] as Tier[]) {
      expect(TIERS[t].en).not.toBe("");
      expect(TIERS[t].sw).not.toBe("");
      expect(SERVICES.some((s) => s.tier === t), `tier ${t}`).toBe(true);
    }
  });
  it("marks which services came from the draft and which were added", () => {
    expect(classifyService("Malaria Diagnosis and Treatment", "mRDT - Rapid Diagnostic Tests")?.source).toBe("draft");
    expect(classifyService("Laboratory Service-Serology", "Dengue Haemorrhagic fever")?.source).toBe("added");
    expect(SERVICES.filter((s) => s.source === "added").length).toBeGreaterThan(0);
    expect(UNMATCHED.length).toBeGreaterThan(0);
  });
  it("flags translations that need a reviewer", () => {
    expect(NEEDS_REVIEW.has("s:Kato-Katz Technique")).toBe(false); // a clear name
    expect(SERVICES.filter((s) => s.confidence === "review").every((s) => NEEDS_REVIEW.has(`s:${s.name}`) || NEEDS_REVIEW.has(`c:${s.category}`))).toBe(true);
  });
});

describe("translations cover every portal service", () => {
  it("has a non-empty Kiswahili name for every service and category", () => {
    expect(Object.keys(SERVICE_SW)).toHaveLength(342);
    expect(Object.keys(CATEGORY_SW)).toHaveLength(44);
    for (const [k, v] of Object.entries({ ...SERVICE_SW, ...CATEGORY_SW })) expect(v.trim(), k).not.toBe("");
  });
  it("translates a few well-known terms the Ministry's way", () => {
    expect(SERVICE_SW["Antenatal Care"]).toBe("Huduma za Kliniki ya Wajawazito");
    expect(SERVICE_SW["Family Planning"]).toBe("Uzazi wa Mpango");
    expect(CATEGORY_SW["Vaccination"]).toBe("Chanjo");
    expect(SERVICE_SW["Mental Health Services"]).toBe("Huduma za Afya ya Akili");
  });
});

describe("classifyService (real portal rows)", () => {
  it("matches the draft's direct services by their exact portal text", () => {
    expect(code("Health Promotion and Disease Prevention", "Epidemiological Surveillance and Response")).toBeDefined();
    expect(code("Disease Surveillance", "Perform laboratory tests for presumptive diagnosis")).toBeDefined();
    expect(code("Emergency Preparedness", "Basic Emergency Preparedness")).toBeDefined();
    expect(code("Emergency Preparedness", "Comprehensive Emergency Preparedness")).toBeDefined();
    expect(code("Malaria Diagnosis and Treatment", "Slide Microscopy")).toBeDefined();
    expect(code("Malaria Diagnosis and Treatment", "First Line Treatment")).toBeDefined();
    expect(code("Malaria Diagnosis and Treatment", "Treatment of Complicated Malaria")).toBeDefined();
    expect(code("General Clinical Services", "Mental Health Services")).toBeDefined();
  });
  it("keeps a service filed under the wrong portal category exactly as filed", () => {
    expect(classifyService("Vaccination", "Nutritional Counseling")?.category).toBe("Vaccination");
    expect(classifyService("General Clinical Services", "Nutritional Counseling")?.category).toBe("General Clinical Services");
    expect(classifyService("Growth Monitoring / Nutrition Surveillance", "Vaccination")?.mappingNote).toMatch(/Growth Monitoring/);
  });
  it("is exact: the same name in another category, or a near miss, is not a match", () => {
    expect(code("TB Diagnosis, Care and Treatment", "First Line Treatment")).toBeUndefined();
    expect(code("Malaria Diagnosis and Treatment", "first line treatment")).toBeUndefined();
    expect(climateServiceFor(" Malaria Diagnosis and Treatment ", " Slide Microscopy ")).toBeDefined(); // only surrounding spaces are ignored
  });
  it("includes the added services, marked as added", () => {
    for (const [c, n] of [
      ["Emergency Preparedness", "Emergency Care and Trauma"],
      ["Laboratory Service-Serology", "Dengue Haemorrhagic fever"],
      ["Reproductive and Child Health Care Services", "BEmOC - Basic Emergency Obstetric Care"],
      ["Reproductive and Child Health Care Services", "CEmOC - Comprehensive Emergency Obstetric Care"],
      ["Reproductive and Child Health Care Services", "Maternal and Newborn Care"],
      ["General Clinical Services", "Dialysis Services"],
    ]) expect(classifyService(c, n)?.source, n).toBe("added");
  });
  it("includes growth monitoring (tier 4) and the ICU service", () => {
    expect(classifyService("Maternity home", "Growth monitoring")?.tier).toBe(4);
    expect(classifyService("General Clinical Services", "ICU - Intensive Care Services")?.tier).toBe(4);
  });
  it("does not match ordinary services", () => {
    expect(code("General Clinical Services", "OPD - Outpatient Services")).toBeUndefined();
    expect(code("Therapeutics", "Pharmacy")).toBeUndefined();
    expect(code("Optometry Services", "Refraction")).toBeUndefined();
    expect(code("Mental Health and Substance Abuse Services", "Physiotherapy")).toBeUndefined();
    expect(code("Administration and Support Services", "Toilets for female patients")).toBeUndefined();
  });
});

describe("climate dataset parameters", () => {
  it("keeps the operating and located checks on for a plain link", () => {
    const p = paramsFrom(new URL("http://x/api/export/climate?sheet=facilities"));
    expect(p.operatingOnly).toBe(true);
    expect(p.locatedOnly).toBe(true);
  });
  it("turns a check off only when the form posted a hidden 0 without a ticked 1", () => {
    expect(paramsFrom(new URL("http://x/?operating=0")).operatingOnly).toBe(false);
    expect(paramsFrom(new URL("http://x/?operating=0&operating=1")).operatingOnly).toBe(true);
    expect(paramsFrom(new URL("http://x/?located=0")).locatedOnly).toBe(false);
  });
  it("narrows the services to the chosen tier or codes, else uses all", () => {
    const a = SERVICES[0].code;
    const b = SERVICES[1].code;
    expect(chosenServices(undefined).codes).toHaveLength(SERVICES.length);
    expect(chosenServices(`svc:${a},${b}`).codes).toEqual([a, b]);
    expect(chosenServices("tier:5").codes).toEqual(SERVICES.filter((s) => s.tier === 5).map((s) => s.code));
    expect(chosenServices("svc:NOPE").codes).toHaveLength(SERVICES.length);
  });
  it("finds every code by lookup", () => {
    for (const s of SERVICES) expect(SERVICE_BY_CODE.get(s.code)).toBe(s);
  });
});

describe("climate filter", () => {
  const compile = (value: string) => new PgDialect().sqlToQuery(climatePredicate(value));
  it("reads the filter from the URL", () => {
    expect(readFilters({ climate: "tier:1,2" }).climate).toBe("tier:1,2");
  });
  it("any / none / tier / service produce the right test", () => {
    expect(compile("any").sql).toContain("EXISTS");
    expect(compile("none").sql).toContain("NOT");
    expect(compile("tier:1,2").params).toEqual([[1, 2]]);
    expect(compile("svc:CS001,CS002").params).toEqual([["CS001", "CS002"]]);
  });
  it("ignores invalid tiers and service codes instead of passing them to the database", () => {
    expect(compile("tier:9,x").params).toEqual([]);
    expect(compile("svc:CS001;DROP TABLE x,CS002").params).toEqual([["CS002"]]);
  });
});
