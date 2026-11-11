-- Vaccination, antenatal care, BEmOC, postnatal care and maternal and newborn care now sit in tier 3 (src/lib/climate/catalogue.ts).
-- Earlier moves were left to the next climate refresh; this makes the database match straight away. Safe to run more than once.
UPDATE "facility_climate_services" SET "tier" = 3
WHERE "service_code" IN ('CS013', 'CS042', 'CS043', 'CS047', 'CS048') AND "tier" <> 3;--> statement-breakpoint
UPDATE "climate_services"
SET "tier" = 3,
    "tier_en" = 'Supportive systems and community engagement',
    "tier_sw" = 'Mifumo saidizi na ushirikishwaji wa jamii'
WHERE "code" IN ('CS013', 'CS042', 'CS043', 'CS047', 'CS048') AND "tier" <> 3;
