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
| 11 | AI summary | Weekly reports → latest | Number check passes; nothing claimed that isn't in the data | | | Plain summary (no API key) generated and verified locally; Claude path needs ANTHROPIC_API_KEY |
| 12 | Email + cron | Wait for Monday's run (or trigger the cron route) | Email arrives; run starts within its hour | | | |
| 13 | Dashboard | Walk through every page | Pages load < 3 s; review decisions survive re-validation | | | |
