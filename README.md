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
| High | HFR point inside its registered ward **and** an OSM/Google place with the same name within 500 m, or confirmed by a reviewer |
| Medium | Inside its ward without a name match, **or** a replacement point found inside the ward |
| Low | Outside its ward, ward centre used as a stand-in, no boundary to check against, or unusable point |

HFR's own coordinates are never changed; the corrected point is stored separately (`geo_validation.final_lat/lng`).

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
2. Add the environment variables (Production). Set `APP_URL` to the production URL.
3. Deploy. `vercel.json` registers two daily cron jobs: the scheduler (23:00 UTC = 02:00 EAT), which starts an automatic run
   when **Admin → Automation settings** says today is a run day (weekly on the chosen weekday, or every day), and a
   watchdog (07:00 EAT) that restarts a stalled run and sends the optional daily status email.
4. Open **Admin** → *Check HFR portal*. If it fails from Vercel, run the scraper from your computer with
   `npm run worker` (same database); the dashboard stays on Vercel.
5. Start a **pilot** for one region, check the numbers, then start the **full national load**.

> Vercel Hobby limits functions to 300 s and cron to once a day. The app works within that: long jobs run as a
> chain of ~180-second ticks. If a chain ever breaks, the daily watchdog (or **Admin → Nudge runner**) restarts it.

## Testing

```bash
npm test          # parsers (against saved HFR pages), client, name matching, grading, diff, AI number check, tokens
npm run typecheck
npm run build
```

`EVALUATION.md` is the piece-by-piece evaluation checklist; record results there.

## Being polite to the HFR portal

- One request at a time, at least `HFR_RATE_MS` (default 1000 ms) apart, with a contact email in the User-Agent.
- On 403 or repeated 429/5xx the run **pauses** instead of retrying; resume it from the Admin page.
- The Ministry also provides the master facility list on request (*Download Operating Facilities* on the portal),
  a good backup source.

## Data notes

- Google results: only the place ID and our own match score are stored (Google's terms).
- Fixture files in `tests/fixtures/hfr` have personal names, phones and emails replaced with placeholders.
