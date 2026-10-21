import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { q } from "@/lib/db/client";
import { ConfidenceBadge, PageHeader, StatusBadge, fmt, fmtDate } from "@/components/ui";
import type { FieldDiff } from "@/lib/diff/fields";

export const dynamic = "force-dynamic";

const LABELS: [string, string][] = [
  ["common_name", "Common name"],
  ["facility_type", "Facility type"],
  ["operating_status", "Operating status"],
  ["registration_status", "Registration status"],
  ["date_opened", "Date opened"],
  ["ownership_category", "Ownership category"],
  ["ownership_authority", "Ownership authority"],
  ["ownership_details", "Owner"],
  ["moh_authority", "MoH authority"],
  ["zone", "Zone"],
  ["region_name", "Region"],
  ["district_name", "District"],
  ["council_name", "Council"],
  ["ward_name", "Ward"],
  ["village_name", "Village / Mtaa"],
  ["ward_code", "Ward code"],
  ["phone", "Phone"],
  ["website", "Website"],
  ["nearest_facility", "Nearest facility"],
  ["ctc_id", "CTC ID"],
  ["msd_id", "MSD ID"],
  ["mtuha_id", "MTUHA ID"],
  ["hfr_id", "HFR internal ID"],
];

export default async function FacilityPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const [f] = await q<Record<string, unknown>>(sql`SELECT * , NULL AS geom FROM facilities WHERE facility_code = ${code}`);
  if (!f) notFound();
  const [g] = await q<Record<string, unknown>>(sql`SELECT * FROM geo_validation WHERE facility_code = ${code}`);
  const [review] = await q<Record<string, unknown>>(sql`SELECT * FROM review_decisions WHERE facility_code = ${code}`);
  const services = await q<{ category: string; description: string }>(sql`
    SELECT category, description FROM facility_services WHERE facility_code = ${code} ORDER BY category, description`);
  const changes = await q<{ run_id: number; change_type: string; field_diffs: FieldDiff[] | null; created_at: string }>(sql`
    SELECT run_id, change_type, field_diffs, created_at FROM facility_changes WHERE facility_code = ${code} ORDER BY id DESC LIMIT 50`);

  const [sat] = await q<{ lat: number; lng: number; status: string; note: string | null; source: string | null; checked_at: string }>(sql`
    SELECT lat, lng, status, note, source, checked_at FROM satellite_checks WHERE facility_code = ${code}`);
  const lat = (g?.final_lat ?? f.hfr_lat) as number | null;
  const lng = (g?.final_lng ?? f.hfr_lng) as number | null;

  return (
    <div className="space-y-4">
      <PageHeader title={`${f.name} (${code})`}>
        {lat != null && (
          <a className="btn" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`}>
            Open in OpenStreetMap
          </a>
        )}
        <Link className="btn" href={`/quality?q=${code}`}>
          Review
        </Link>
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <h2 className="h2 mb-2">Registry record</h2>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {LABELS.map(([k, label]) => (
              <div key={k}>
                <dt className="text-xs text-muted">{label}</dt>
                <dd>{f[k] == null || f[k] === "" ? "—" : String(f[k])}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted">
            First seen {fmtDate(f.first_seen as string)} · last seen {fmtDate(f.last_seen as string)} · detail fetched {fmtDate(f.last_detail_at as string)}
            {f.removed_at ? ` · removed from HFR list ${fmtDate(f.removed_at as string)}` : ""}
          </p>
        </div>

        <div className="card">
          <h2 className="h2 mb-2">Location check</h2>
          {g ? (
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-xs text-muted">Confidence</dt>
                <dd>
                  <ConfidenceBadge value={g.confidence as string} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">HFR coordinates</dt>
                <dd className="tabular-nums">{f.hfr_lat != null ? `${f.hfr_lat}, ${f.hfr_lng}` : "none"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Inside registered ward</dt>
                <dd>{g.in_ward == null ? "not checked (no boundary)" : g.in_ward ? "yes" : `no (${fmt(g.distance_to_ward_m)} m away)`}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Name match</dt>
                <dd>
                  {g.match_source === "none" || !g.match_source
                    ? "none found"
                    : `${g.match_source}${g.matched_name ? ` "${g.matched_name}"` : ""}, score ${g.name_score}${g.match_distance_m != null ? `, ${fmt(g.match_distance_m)} m away` : ""}`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Corrected point</dt>
                <dd className="tabular-nums">
                  {g.final_lat != null ? `${g.final_lat}, ${g.final_lng}` : "none"} <span className="text-muted">({String(g.geocode_source ?? "—")})</span>
                </dd>
              </div>
              {g.boundary_village != null && (
                <div>
                  <dt className="text-xs text-muted">Village polygon at the corrected point</dt>
                  <dd>
                    {String(g.boundary_village)}
                    {g.boundary_village_ward != null && <span className="text-muted"> (ward {String(g.boundary_village_ward)})</span>}
                    {g.village_check != null && <span className="text-muted"> · {String(g.village_check)} with the HFR village</span>}
                  </dd>
                </div>
              )}
              {Array.isArray(g.sanity_flags) && g.sanity_flags.length > 0 && (
                <div>
                  <dt className="text-xs text-muted">Flags</dt>
                  <dd>{(g.sanity_flags as string[]).join(", ")}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-muted">Notes</dt>
                <dd className="text-muted">{String(g.notes ?? "—")}</dd>
              </div>
              {review && (
                <div>
                  <dt className="text-xs text-muted">Reviewer decision</dt>
                  <dd>
                    {String(review.decision)} by {String(review.reviewer)} on {fmtDate(review.decided_at as string)}
                  </dd>
                </div>
              )}
              <p className="text-xs text-muted">Checked {fmtDate(g.checked_at as string)}</p>
            </dl>
          ) : (
            <p className="text-sm text-muted">Not validated yet.</p>
          )}
        </div>
      </div>

      {lat != null && lng != null && (
        <div className="card">
          <h2 className="h2 mb-2">Satellite view</h2>
          <div className="grid gap-4 md:grid-cols-[minmax(0,420px)_1fr]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/satellite?lat=${lat}&lng=${lng}`}
              alt={`Satellite view around ${f.name}`}
              width={420}
              height={420}
              loading="lazy"
              className="aspect-square w-full rounded-lg border border-line bg-canvas object-cover"
            />
            <div className="space-y-2 text-sm">
              <p className="text-muted">The picture is centred on the point above, about 150 m across. Look for a roofed building or compound at the middle.</p>
              {sat && Math.abs(sat.lat - lat) < 0.0003 && Math.abs(sat.lng - lng) < 0.0003 ? (
                <>
                  <p>
                    <span className="font-medium">
                      {sat.status === "building" ? "Building seen at the point" : sat.status === "none" ? "No building seen at the point" : "Could not tell from the picture"}
                    </span>
                    <span className="text-muted"> · checked {fmtDate(sat.checked_at)}</span>
                  </p>
                  {sat.note && <p className="text-muted">{sat.note}</p>}
                  {sat.status !== "building" && <p className="text-xs text-muted">This does not lower the grade. If the picture shows the facility nearby, use Review to move the point.</p>}
                </>
              ) : (
                <p className="text-muted">Not checked by the satellite step yet.</p>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="h2 mb-2">History</h2>
          {changes.length === 0 ? (
            <p className="text-sm text-muted">No recorded changes.</p>
          ) : (
            <ul className="space-y-3 text-sm">
              {changes.map((c, i) => (
                <li key={i}>
                  <div className="flex items-center gap-2">
                    <StatusBadge value={c.change_type} />
                    <span className="text-xs text-muted">
                      run #{c.run_id} · {fmtDate(c.created_at)}
                    </span>
                  </div>
                  {c.field_diffs && (
                    <ul className="mt-1 ml-4 list-disc text-xs text-muted">
                      {c.field_diffs.map((d, j) => (
                        <li key={j}>
                          {d.field}: {String(d.from ?? "—")} → {String(d.to ?? "—")}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h2 className="h2 mb-2">Services ({services.length})</h2>
          {services.length === 0 ? (
            <p className="text-sm text-muted">No services recorded.</p>
          ) : (
            <ul className="max-h-96 space-y-1 overflow-auto text-sm">
              {services.map((s, i) => (
                <li key={i}>
                  <span className="text-muted">{s.category}:</span> {s.description}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
