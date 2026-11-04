-- Tiers 1 and 2 now hold only the services the team named (7 direct, 6 maternal). The other 35 former tier 1 and 2 services are removed
-- from the climate catalogue and from every facility link. Codes of the kept services do not change. The catalogue itself is rewritten
-- from src/lib/climate/catalogue.ts by `npx tsx scripts/classify-climate.ts`; this migration makes the database correct on its own.
DELETE FROM "facility_climate_services"
WHERE "tier" IN (1, 2)
  AND "service_code" NOT IN ('CS006', 'CS007', 'CS013', 'CS014', 'CS016', 'CS019', 'CS021', 'CS042', 'CS043', 'CS044', 'CS046', 'CS047', 'CS048');--> statement-breakpoint
DELETE FROM "climate_services"
WHERE "tier" IN (1, 2)
  AND "code" NOT IN ('CS006', 'CS007', 'CS013', 'CS014', 'CS016', 'CS019', 'CS021', 'CS042', 'CS043', 'CS044', 'CS046', 'CS047', 'CS048');
