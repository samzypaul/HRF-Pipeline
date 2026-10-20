import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { CATEGORIES, SERVICES, SERVICE_BY_CODE, TIERS, UNMATCHED, type Tier } from "@/lib/climate/catalogue";
import { classifyService } from "@/lib/climate/classify";
import { climatePredicate, readFilters } from "@/lib/data";

const codes = (category: string, description: string) =>
  classifyService(category, description)
    .map((s) => s.code)
    .sort();

describe("climate service catalogue", () => {
  it("has unique codes and a complete English and Kiswahili entry for every service", () => {
    expect(new Set(SERVICES.map((s) => s.code)).size).toBe(SERVICES.length);
    for (const s of SERVICES) {
      expect(s.nameEn, s.code).not.toBe("");
      expect(s.nameSw, s.code).not.toBe("");
      expect(s.descEn, s.code).not.toBe("");
      expect(s.descSw, s.code).not.toBe("");
      expect(s.rationale, s.code).not.toBe("");
      expect(s.match.length, s.code).toBeGreaterThan(0);
      expect(s.code, s.code).toMatch(/^[A-Z0-9-]{2,20}$/);
      expect(CATEGORIES[s.category], s.code).toBeDefined();
    }
  });
  it("names the five tiers in both languages and uses every one", () => {
    for (const t of [1, 2, 3, 4, 5] as Tier[]) {
      expect(TIERS[t].en).not.toBe("");
      expect(TIERS[t].sw).not.toBe("");
      expect(SERVICES.some((s) => s.tier === t), `tier ${t}`).toBe(true);
    }
  });
  it("marks which services came from the draft and which were added", () => {
    expect(SERVICE_BY_CODE.get("MAL-MRDT")?.source).toBe("draft");
    expect(SERVICE_BY_CODE.get("DENGUE")?.source).toBe("added");
    expect(UNMATCHED.length).toBeGreaterThan(0);
  });
});

describe("classifyService (real portal service names)", () => {
  it("matches the draft's direct services", () => {
    expect(codes("Health Promotion and Disease Prevention", "Epidemiological Surveillance and Response")).toEqual(["SURV"]);
    expect(codes("Disease Surveillance", "Perform laboratory tests for presumptive diagnosis")).toEqual(["SURV"]);
    expect(codes("Growth Monitoring / Nutrition Surveillance", "IMM-BASIC - Basic Immunization")).toEqual(["IMM-BASIC"]);
    expect(codes("Growth Monitoring / Nutrition Surveillance", "IMM-ADD - With Addition Vaccine")).toEqual(["IMM-ADD"]);
    expect(codes("Growth Monitoring / Nutrition Surveillance", "PORT - Port Immunization Services")).toEqual(["PORT-IMM"]);
    expect(codes("Emergency Preparedness", "Basic Emergency Preparedness")).toEqual(["EPREP-BASIC"]);
    expect(codes("Emergency Preparedness", "Comprehensive Emergency Preparedness")).toEqual(["EPREP-COMP"]);
    expect(codes("Malaria Diagnosis and Treatment", "mRDT - Rapid Diagnostic Tests")).toEqual(["MAL-MRDT"]);
    expect(codes("Malaria Diagnosis and Treatment", "Slide Microscopy")).toEqual(["MAL-SLIDE"]);
    expect(codes("Malaria Diagnosis and Treatment", "First Line Treatment")).toEqual(["MAL-TX1"]);
    expect(codes("Malaria Diagnosis and Treatment", "Treatment of Complicated Malaria")).toEqual(["MAL-SEVERE"]);
    expect(codes("General Clinical Services", "Mental Health Services")).toEqual(["MENTAL"]);
  });
  it("matches on the service name when the portal category is wrong", () => {
    expect(codes("Vaccination", "Nutritional Counseling")).toEqual(["NUT-COUNSEL"]);
    expect(codes("Vaccination", "Nutritional Rehabilitation")).toEqual(["NUT-REHAB"]);
    expect(codes("Growth Monitoring / Nutrition Surveillance", "Vaccination")).toEqual(["VACC"]);
  });
  it("tells a TB first-line treatment from a malaria one by its category", () => {
    expect(codes("TB Diagnosis, Care and Treatment", "First Line Treatment")).toEqual(["TB-CARE"]);
  });
  it("matches maternal and child health services", () => {
    expect(codes("Reproductive and Child Health Care Services", "Antenatal Care")).toEqual(["ANC"]);
    expect(codes("Maternity home", "Focus ant- natal care")).toEqual(["ANC"]);
    expect(codes("Reproductive and Child Health Care Services", "Postnatal Care")).toEqual(["PNC"]);
    expect(codes("Maternity home", "Post natal care")).toEqual(["PNC"]);
    expect(codes("Reproductive and Child Health Care Services", "Family Planning")).toEqual(["FP"]);
    expect(codes("Reproductive and Child Health Care Services", "FP-INV – Invasive Method")).toEqual(["FP"]);
    expect(codes("Reproductive and Child Health Care Services", "Management of Hypertensive Pregnancies (Pre-eclampsia)")).toEqual(["PREECL"]);
    expect(codes("Reproductive and Child Health Care Services", "BEmOC - Basic Emergency Obstetric Care")).toEqual(["BEMOC"]);
    expect(codes("General Clinical Services", "IMCI - Integrated Management of Childhood Illness")).toEqual(["IMCI"]);
  });
  it("counts a laboratory test as laboratory and as the specific service it is", () => {
    expect(codes("Laboratory Service-Haematology and Blood Transfusion", "Full Blood Picture")).toEqual(["LAB"]);
    expect(codes("Laboratory Service-Parasitology", "Malaria Rapid Diagnostic Test (mRDT)")).toEqual(["LAB", "MAL-MRDT"]);
    expect(codes("Laboratory Service-Parasitology", "Stool Analysis")).toEqual(["LAB", "STOOL"]);
    expect(codes("Laboratory Service-Serology", "Dengue Haemorrhagic fever")).toEqual(["DENGUE", "LAB"]);
    expect(codes("Diagnostic Services", "Laboratory")).toEqual(["LAB"]);
    expect(codes("Diagnostic Services", "Radiology Services")).toEqual(["RADIO"]);
  });
  it("treats the mental-health category as mental health except for mis-filed entries", () => {
    expect(codes("Mental Health and Substance Abuse Services", "Psychosis, Epilepsy and Depression")).toEqual(["MENTAL"]);
    expect(codes("Mental Health and Substance Abuse Services", "Physiotherapy")).toEqual([]);
    expect(codes("Mental Health and Substance Abuse Services", "IPD - Inpatient Services")).toEqual([]);
  });
  it("finds toilets and waste disposal only under administration and support", () => {
    expect(codes("Administration and Support Services", "Toilets for female patients")).toEqual(["WASH"]);
    expect(codes("Administration and Support Services", "Wash Slab")).toEqual(["WASH"]);
    expect(codes("Administration and Support Services", "Incinerator")).toEqual(["WASTE"]);
    expect(codes("Administration and Support Services", "Store room")).toEqual([]);
  });
  it("does not match ordinary services", () => {
    expect(codes("General Clinical Services", "OPD - Outpatient Services")).toEqual([]);
    expect(codes("Therapeutics", "Pharmacy")).toEqual([]);
    expect(codes("Optometry Services", "Refraction")).toEqual([]);
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
    expect(compile("svc:MAL-MRDT,ANC").params).toEqual([["MAL-MRDT", "ANC"]]);
  });
  it("ignores invalid tiers and service codes instead of passing them to the database", () => {
    expect(compile("tier:9,x").params).toEqual([]);
    expect(compile("svc:ANC;DROP TABLE x,ANC").params).toEqual([["ANC"]]);
  });
});
