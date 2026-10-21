# HFR Pipeline

One Next.js app that copies every facility from Tanzania's **Health Facility Registry** (HFR,
<https://hfrportal.moh.go.tz>) into **Neon Postgres + PostGIS**, checks every location against its ward and
against OpenStreetMap (with Google as a fallback), fills missing coordinates, and writes a **weekly AI report**
of what changed.

Everything (scraper, validator, weekly checker, AI summary and dashboard) lives in this one app on Vercel. The only outside piece
is the database, reached by its connection string.

```
HFR portal ──► scraper ─┐
ward boundaries ────────┤
OpenStreetMap ──────────┼─► geo-validator ─► weekly diff ─► AI summary ─► email
Google (fallback) ──────┘         │
                                  ▼
                     Neon Postgres + PostGIS  ◄── Next.js dashboard
```

## How it works

| Piece | Where | What it does |
|---|---|---|
| HFR client | `src/lib/hfr/client.ts` | One request at a time, ≥ 1 s apart, retries with backoff, stops on 403/429 |
| Parsers | `src/lib/hfr/parse.ts` | List pages (50 rows), detail page, coordinates JSON, services, admin tree |
| Job queue | `src/lib/jobs/*` | Tasks stored in Postgres; a "tick" works ~180 s, then starts the next tick |
| Diff | `src/lib/diff/*` | New / updated / closed / reopened / removed, with field-level changes |
| Geo-validation | `src/lib/geo/*` | Sanity checks → ward test (PostGIS) → OSM name match → Google fallback → geocoding → grade |
| AI report | `src/lib/ai/*` | Digest → Gemini (JSON schema output) → every number checked against the data → email |
| Dashboard | `src/app/(dashboard)/*` | Overview, Map, Data quality review queue, Facility history, Reports, Export, Admin |

### Run phases

`full` / `pilot`: admin tree → national list → ward-by-ward lists → diff → details (detail + coordinates + services) → validate → finalize

`weekly` (Monday 02:00 EAT): the same, but details are fetched only for new/changed facilities plus the oldest 25 %
(so every facility is refreshed about once a month), followed by the AI report.

### Confidence grades

| Grade | Rule |
|---|---|
| High | HFR point inside its registered ward **and** an OSM/Google place with the same name within 1 km, or confirmed by a reviewer |
| Medium | Inside its ward with an OSM/Google name match 1–3.5 km away, **or** a replacement point found inside the ward |
| Low | No name match within 3.5 km, outside its ward or council, a village/ward centre used as a stand-in, or unusable point |

The distances are `MATCH_DISTANCE_M` (1 km), `MEDIUM_DISTANCE_M` (3.5 km) and `SEARCH_RADIUS_M` in `src/lib/geo/name-match.ts`.

HFR's own coordinates are never changed; the corrected point is stored separately (`geo_validation.final_lat/lng`).

### Village rule

Every facility should sit inside the village named in its HFR record (needs the village file from `npm run load-villages`).
During validation, which every run does, the corrected point is chosen like this:

1. A point that is already inside its village stays.
2. A point outside its village is replaced by an OSM, Google or geocoder point that is inside the village, unless a close name
   match confirms the original. If none is found it is kept and flagged **Outside its HFR village** in Data quality.
3. A facility with no usable point gets a geocoded point inside its village. If geocoding finds nothing inside the village,
   the centre of the village polygon is used (low confidence).

Placements made by this rule are flagged **Placed in its village**, and management gets one email per run listing them
(sent to the approval-email recipients). HFR coordinates are never overwritten.

### Climate-sensitive services (El Niño app)

A separate way of reading the same data: which facilities offer services that matter for El Niño rains and flooding. The catalogue
(`src/lib/climate/catalogue.ts`) holds 69 real HFR services in five priority tiers. Each is a service exactly as the portal files it
(its own category and name, unchanged; the portal's misfiled categories and spelling mistakes are kept and noted), with the Kiswahili for
both, a short English and Kiswahili description and a climate-health rationale. The list comes from the team's brainstorm document and
dataset prompt: services the brainstorm names are marked `draft`, services found in the registry that it did not name are marked `added`
for the team to review. `code` (CS001, CS002, ...) is a catalogue id; the portal gives services no codes. All 342 service names and 44
categories the portal uses are translated in `src/lib/climate/translations.ts` (and stored in `service_translations`); the ones a
native-speaker health reviewer should check are listed in `NEEDS_REVIEW`.

- **Identification.** Each distinct registry row (category plus service name) is matched to the catalogue by its exact portal text.
  The result is stored in `facility_climate_services`; the catalogue is stored in `climate_services`; every portal service with its
  Kiswahili name is stored in `service_translations`. Run it from Admin ("Identify climate-sensitive services", no portal calls), with
  `npx tsx scripts/classify-climate.ts`, or automatically at the end of every full or weekly run.
- **Filters.** The "Climate-sensitive services" filter works on Data quality, Map and Export: any, none, a whole tier, or chosen services.
- **Export.** Export has a "Climate-sensitive facility dataset" card. It downloads one Excel workbook (a Summary sheet, then
  Facilities, Facility_Services, Service_Lookup, Exclusions and Data_Quality; no merged cells, one header row each), or any one of the
  five sheets as CSV (UTF-8, snake_case). The same two files carry the filters chosen above the card. Closed or non-operational facilities and facilities without a
  location are listed in exclusions, not silently dropped; the portal's coordinates are never changed.

### Public API for the app

An open, read-only JSON API for the El Niño app lives at `/api/v1/climate`. It needs no sign-in and serves only cleaned data: facilities
that are operating, have a location and offer at least one climate-sensitive service (about 12,900), with their phone numbers and their
services in English or Kiswahili (`lang=en|sw`). Service names and categories are the portal's own. Internal fields (review notes, flags, the portal's raw coordinates) are never returned,
and a stand-in or unconfirmed point is marked `location.approximate`.

| Endpoint | What it returns |
|---|---|
| `GET /api/v1/climate/facilities` | A page of facilities. Filters: `service` (codes such as CS020), `tier` (1 to 5), `region`, `council`, `q` (name), `lat` + `lng` + `radius_km` (nearest first), `min_confidence`, `limit` (up to 200), `offset` |
| `GET /api/v1/climate/facilities/{code}` | One facility |
| `GET /api/v1/climate/services` | The services with names, descriptions, tiers and facility counts |
| `GET /api/v1/climate/regions` | Regions with counts; `?region=CODE` gives that region's councils |
| `GET /api/v1/climate/openapi.json` | The OpenAPI 3 description, for app developers and API tools |

```bash
# Facilities within 10 km of a point that do malaria rapid tests, with Kiswahili names
curl "https://hfr-pipeline.vercel.app/api/v1/climate/facilities?lat=-6.8&lng=39.28&radius_km=10&service=MAL-MRDT&lang=sw"
```

Responses are cached by the CDN for 5 minutes (30 for services and regions), allow any origin (CORS), and are limited to about 120
requests a minute per address (a guard per server instance, not a hard quota). Errors are `{ "error": { "code", "message" } }` with status
400, 404, 429 or 500. Phone numbers are public in this API; remove `phone` from `facilityView` in `src/lib/climate/api.ts` to hide them.

### Who can sign in

`ALLOWED_EMAILS` holds the owners. On the Admin page, owners add more addresses; each new address gets an email saying it has
access and signs in with a one-time link sent to that mailbox. Removing an address signs it out on its next page load.

## Setup

### 1. Install

```bash
npm install
cp .env.example .env.local   # then fill it in (see below)
```

### 2. Database (Neon)

1. Create a Neon project in **AWS Europe Central (Frankfurt)**.
2. In the SQL editor: `CREATE EXTENSION IF NOT EXISTS postgis;`
3. Copy the **pooled** connection string to `DATABASE_URL` and the **direct** one to `DATABASE_URL_UNPOOLED`.
4. Create the tables: `npm run db:migrate`

### 3. Ward boundaries (once, from your computer)

The ward check needs ward polygons. The HDX "Tanzania – Subnational Administrative Boundaries" ADM3 file works
(<https://data.humdata.org/dataset/cod-ab-tza>, wards from 2018: newer wards will show as unlinked).

```bash
# shapefile → GeoJSON (WGS84), simplified to keep it light
npx mapshaper tza_admbnda_adm3_20181019.shp -simplify 15% keep-shapes -o format=geojson wards.geojson
npm run load-wards -- wards.geojson
```

Fields `ADM3_EN / ADM2_EN / ADM1_EN` are detected automatically (or pass `--name= --district= --region=`).
HFR wards are linked to polygons by name after the admin tree is loaded; leftovers are listed on the Admin page,
where you can link them by hand.

**Council boundaries (optional).** The region/district/council file (`data/tanzania_map.json`) lets the pipeline check points and
search areas for councils whose wards are not linked yet (fills `in_council`, narrows OSM and geocoder searches, rejects geocoded points
clearly outside the council):

```bash
npm run load-councils -- data/tanzania_map.json
```

**Village boundaries (optional).** A village/mtaa shapefile (WGS 84, `.shp` + `.dbf` side by side) adds a check of the
village under each corrected point against the facility's HFR village and ward:

```bash
npm run db:migrate
npm run load-villages -- data/villages.shp   # add --replace to reload; --name= --ward= --district= --region= to override fields
```

Afterwards run “Re-validate all locations” on the Admin page. Points whose village polygon belongs to a different ward are
flagged `village_ward_differs`; the village and its agree/differ result show on the facility page and in the exports.

**No ward file?** Build ward polygons from the village layer instead (each village carries its ward) and link them to the HFR wards:

```bash
npm run derive-wards            # add --replace to rebuild; never touches rows from a real ward file
```

**How the grade uses these layers.** Beyond the ward and name-match rules: a point outside its council polygon is low (a geocoded
replacement inside the council makes it medium); a village polygon that matches the HFR village and ward raises the grade one step,
while a village or geocoder placing the point in another ward lowers it one step (both: low); a point shared with another facility
is lowered one step; a name match needs at least one distinctive word in common, and a match on a very short name (`weak_name_match`)
cannot reach high. Facilities with no usable point get the centre of their HFR village (`village_centroid`, low) before the ward centre.

### 4. Environment variables

See `.env.example` for every variable with a comment. The essentials:

| Variable | Needed for |
|---|---|
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | everything |
| `CRON_SECRET`, `APP_URL` | chaining job ticks, Vercel Cron |
| `AUTH_SECRET`, `ALLOWED_EMAILS`, `RESEND_API_KEY`, `REPORT_FROM` | dashboard sign-in (magic link) |
| `HFR_CONTACT_EMAIL`, `NOMINATIM_EMAIL` | polite scraping / OSM usage policy |
| `GOOGLE_MAPS_API_KEY` (optional) | Google fallback; capped by `GOOGLE_MONTHLY_CAP` |
| `MAPTILER_API_KEY` (optional) | Extra geocoder layer: missing coordinates, ward-name check, ward-link suggestions; capped by `MAPTILER_MONTHLY_CAP`. Without it the layer can use `GOOGLE_MAPS_API_KEY` (provider setting on Admin) |
| `GEMINI_API_KEY`, `GEMINI_MODEL` (optional) | AI summary via the Gemini API (without a key a plain summary is written) |
| `REPORT_RECIPIENTS` | weekly email |

Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

### 5. Run locally

```bash
npm run dev            # dashboard on http://localhost:3000 (set AUTH_DISABLED=true locally)
npm run worker -- --start=pilot --region=TZ.SH.KA   # run a pilot from the terminal, no time limits
```

### 6. Deploy to Vercel

1. Push this folder to a GitHub repository and import it in Vercel.
2. Add the environment variables (Production). Set `APP_URL` to the production URL (`https://hfr-pipeline.vercel.app`); keep `http://localhost:3000` in `.env.local` for local development.
3. Deploy. `vercel.json` registers two daily cron jobs: the scheduler (23:00 UTC = 02:00 EAT), which starts an automatic run
   when **Admin → Automation settings** says today is a run day (weekly on the chosen weekday, or every day), and a
   watchdog (07:00 EAT) that restarts a stalled run and sends the optional daily status email.
4. Open **Admin** → *Check HFR portal*. If it fails from Vercel, run the scraper from your computer with
   `npm run worker` (same database); the dashboard stays on Vercel.
5. Start a **pilot** for one region, check the numbers, then start the **full national load**.

> Vercel Hobby limits functions to 300 s and cron to once a day. The app works within that: long jobs run as a
> chain of ~180-second ticks. If a chain ever breaks, the daily watchdog (or **Admin → Nudge runner**) restarts it.

### Running the worker on GitHub Actions

`.github/workflows/worker.yml` runs `scripts/worker.ts` on GitHub's servers, so scraping and validation keep going without your
computer or a Vercel request. The dashboard stays on Vercel; the database is the only shared state.

1. In the repo go to **Settings → Secrets and variables → Actions** and add the same values as your `.env.local` as repository
   secrets (at least `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `CRON_SECRET`, `AUTH_SECRET`, `HFR_CONTACT_EMAIL`; also the
   geocoder keys, `RESEND_API_KEY`, `REPORT_FROM` and `REPORT_RECIPIENTS` you use). Empty secrets are fine.
2. Every hour the workflow first runs the pipeline's scheduled tasks (`--schedule`): it **starts the automatic run** when the
   Admin schedule says it is due (chosen weekday or every day, from the chosen hour, East Africa Time), sends the morning status
   email, and starts the daily "improve" when nothing else is running. Each is done at most once a day, and the daily Vercel cron
   does the same check, so whichever fires first wins and a run is never started twice. It then works through the queue and stops
   at once when there is none. A busy job works up to about 5.5 hours, stops cleanly, and the next job resumes from the database.
   Only one worker runs at a time.
3. **Actions → Pipeline worker → Run workflow** starts a run by hand (full load, weekly, validate, improve, pilot).
4. GitHub only runs schedules from the repository's **default branch**: merge this into `main` and make `main` the default
   (Settings → Branches).

If the HFR portal blocks GitHub's IP addresses (it can block datacentre ranges), the job fails with a "blocked" message; then run
`npx tsx scripts/worker.ts` from your own computer, or use a self-hosted runner.

## Testing

```bash
npm test          # parsers (against saved HFR pages), client, name matching, grading, diff, AI number check, tokens
npm run typecheck
npm run build
```

`EVALUATION.md` is the piece-by-piece evaluation checklist; record results there.

## Being polite to the HFR portal

- One request at a time, at least `HFR_RATE_MS` (default 1000 ms) apart, with a contact email in the User-Agent.
  This limit is shared by every lane, so the extra parallelism below never speeds up requests to the portal.
- Scraping and validation run side by side: a facility is queued for validation as soon as its details are saved
  (grouped by ward), compute lanes validate batches while the scrape lane keeps fetching, and facilities inside a batch are
  validated in parallel. Google / ArcGIS / MapTiler calls share one limiter (`GEO_API_CONCURRENCY`); Nominatim and Overpass
  keep their own spacing. Tune with `SCRAPE_LANES`, `COMPUTE_LANES`, `GEO_CONCURRENCY` and `DB_POOL_MAX` (see `.env.example`).
- On 403 or repeated 429/5xx the run **pauses** instead of retrying; resume it from the Admin page.
- The Ministry also provides the master facility list on request (*Download Operating Facilities* on the portal),
  a good backup source.

## Data notes

- Google results: only the place ID and our own match score are stored (Google's terms).
- Fixture files in `tests/fixtures/hfr` have personal names, phones and emails replaced with placeholders.
