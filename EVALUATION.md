# Evaluation log

Test each piece in the order data flows through it. Record the date, the result and any fix.

| # | Piece | How to test | Pass criteria | Date | Result | Notes / fix |
|---|---|---|---|---|---|---|
| 1 | Parsers | `npm test` | All tests green | 2026-10-08 | Pass | 40/40 tests in the build environment |
| 2 | HFR client from Vercel | Admin → Check HFR portal (deployed app) | Rows returned, no 403/429 | | | |
| 3 | Queue and runner | Pilot run spanning several ticks | No lost or duplicated tasks; survives a forced timeout | 2026-10-08 | Pass (local) | Validate run chained itself over HTTP across 3 ticks (after() + self-call); 0 failed tasks. Repeat on Vercel |
| 4 | Pilot scrape | Admin → Pilot (one region) | Facility count = portal's count for that region | 2026-10-08 | Pass (local) | Katavi: portal 200, stored 200, 195 assigned to a ward, 200 details fetched, 0 failed tasks |
| 5 | Full national load | Admin → Full national load | ≥ 99 % of listed facilities stored with an internal ID; gaps explained | | | |
| 6 | Ward matching | Admin → Ward boundaries | ≥ 95 % of HFR wards linked; rest linked by hand | | | 2018 HDX file linked 41/54 Katavi wards: newer wards need manual links or a newer file |
| 7 | Ward check + sanity | Data quality → Outside its ward; hand-check 25 | Flag correct in ≥ 90 % | | | Local Katavi run surfaced e.g. EREDITA (124533-1) placed 580 km from its ward. Added a 150 m edge tolerance after seeing points 2–112 m outside simplified 2018 polygons |
| 8 | OSM + Google matching | Hand-check 50 random graded facilities | Agree with grade in ≥ 90 %; Google under cap | | | |
| 9 | Geocoding missing points | Data quality → Missing coordinates | Every accepted point inside its ward; others flagged low | | | |
| 10 | Weekly diff | Two weekly runs ≥ 1 day apart | 10 sampled changes all confirmed on the portal | | | Local weekly run 1 h after the pilot: 0 changes (expected), 50 stale details refreshed. Found and fixed a phase bug (numeric cast) |
| 11 | AI summary | Weekly reports → latest | Number check passes; nothing claimed that isn't in the data | | | Plain summary (no API key) generated and verified locally; Gemini path needs GEMINI_API_KEY |
| 12 | Email + cron | Wait for Monday's run (or trigger the cron route) | Email arrives; run starts within its hour | | | |
| 13 | Dashboard | Walk through every page | Pages load < 3 s; review decisions survive re-validation | | | |
| 14 | Climate catalogue | `npm test` (tests/climate.test.ts, tests/climate-api.test.ts) | 69 unique services in the portal's exact category and name text, Kiswahili for each, all five tiers used | 2026-10-21 | Pass | 151/151 tests; `tsc` and `eslint` clean. 8 services are marked `added` (not in the brainstorm) for the team to review |
| 15 | Migration 0010 | `npm run db:migrate`, then `npx drizzle-kit generate` | Old climate rows cleared, `category_key` dropped, `service_translations` created; generate reports no changes | 2026-10-21 | Pass | Applied to the live Neon database. Deploys do not run migrations, so any other database needs `db:migrate` and then `classify-climate` by hand |
| 16 | Climate rebuild | `npx tsx scripts/classify-climate.ts` | Every catalogue service matches a portal row; every portal service has a Kiswahili name | 2026-10-21 | Pass | 69 of 446 portal (category, service) pairs matched; 12,878 facilities; 119,272 facility-service links. First run left 10 pairs untranslated: a Windows text-encoding slip turned curly apostrophes and en-dashes into junk in the generated keys. Fixed and re-run: 0 untranslated |
| 17 | Kiswahili translations | Native-speaker health professional reviews the flagged names | Flagged names confirmed or corrected | | | 342 service names and 44 categories drafted; 97 of 446 pairs flagged `needs_review` (mostly laboratory terms), none of the 69 climate services. Review outstanding |
| 18 | Climate dataset sheets | Build every sheet and the summary against the database | Sheets non-empty; Facility_Services rows = facility-service links; every exclusion has a reason | 2026-10-21 | Pass (local) | 12,878 facilities in; 1,519 left out, all for no climate-sensitive service (1,002 have no services recorded). One facility has six services misfiled under Growth Monitoring that are not counted |
| 19 | Public API (live) | `curl` `/services`, `/facilities` (with `tier`, `service`, `lat`+`lng`, `lang=sw`) and an unknown code | 69 services with CS codes, total 12,878, tier 5 = 1,617, Kiswahili names, 400 for an unknown code | 2026-10-21 | Pass | First check failed: pushes to `main` deploy as Preview only. Production follows `boundaries-arcgis-runner-fixes`, which was fast-forwarded to `92281e0`. The API cache keeps old answers up to 30 minutes, so test with a `?cb=` parameter |
| 20 | Dashboard export (Excel and CSV) | Export → Climate-sensitive facility dataset (deployed app) | Workbook and each CSV sheet have rows | | | Needs a signed-in session, so not tested from here. Run locally the same code builds 119,272 facility-service rows |
| 21 | API docs | Run each documented example against the live API | Every example and count matches | 2026-10-21 | Pass | Guide checked against production; Python example run live |

## Notes: climate-sensitive services (2026-10-21)

- **Decision.** The climate data is the normal registry data filtered, not a renamed copy. Each climate service is a portal service exactly as filed (category and name unchanged, wrong categories and spelling kept and noted); only Kiswahili, the five tiers and a short description are added. Codes `CS001` to `CS069` are catalogue ids because the portal gives services none.
- **Matching** is by the portal's exact (category, service name) pair, so every climate row traces to a `facility_services` row. The same service filed under several categories has one code per category.
- **Breaking change.** The public API now returns `CS` codes and portal names. Anything built on the old codes (for example `MAL-MRDT`) must be updated.
- **Correction.** Growth monitoring does exist in the portal (maternity and nursing homes, under 40 facilities) and is included in tier 4.
- **Open items.** Native-speaker review of the Kiswahili; whether toilets, wash slab, incinerator and waste services join tier 4; how the app treats the 44 % of facilities with low-confidence locations; the one facility with misfiled services; whether to hide phone numbers in the open API.
- **Reference:** `docs/Climate-Dataset-Summary-Report` and `docs/Climate-API-Guide` (Markdown, Word and PDF, kept local because `docs/` is gitignored).
