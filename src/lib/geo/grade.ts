import type { SanityResult } from "./sanity";
import { MATCH_DISTANCE_M, MEDIUM_DISTANCE_M } from "./name-match";

export type Confidence = "high" | "medium" | "low";

export interface CandidatePoint {
  source: "osm_match" | "google_match" | "nominatim" | "maptiler_geocode" | "arcgis_geocode" | "google_geocode" | "ward_centroid";
  lat: number;
  lng: number;
  /** inside the registered ward (null when there is no boundary to test) */
  inWard: boolean | null;
  score?: number;
  distanceM?: number;
}

export interface GradeInput {
  sanity: SanityResult;
  hfrPoint: { lat: number; lng: number } | null; // after swap fix
  hasBoundary: boolean;
  inWard: boolean | null; // HFR point inside its ward
  /** best name match near the HFR point (≤ SEARCH_RADIUS_M) */
  nearMatch: { source: "osm" | "google"; score: number; distanceM: number } | null;
  /** a matching place elsewhere that could replace a bad / missing HFR point */
  relocation: CandidatePoint | null;
  geocode: CandidatePoint | null;
  centroid: CandidatePoint | null;
  review: { lat: number | null; lng: number | null; decision: string } | null;
}

export interface GradeResult {
  confidence: Confidence;
  final: { lat: number; lng: number } | null;
  geocodeSource: string | null;
  notes: string[];
}

/**
 * Decide the confidence grade and the best location for one facility.
 *  high   – HFR point inside its ward AND a name match within 500 m (or a reviewer confirmed it)
 *  medium – inside its ward with a name match 500 m–1.5 km away, OR a replacement point found inside the ward
 *  low    – everything else: no name match within 1.5 km, outside its ward, ward centre used, or unusable point
 * The HFR coordinates themselves are never modified; `final` is a separate corrected set.
 */
export function grade(i: GradeInput): GradeResult {
  const notes: string[] = [];

  if (i.review && i.review.lat != null && i.review.lng != null) {
    return { confidence: "high", final: { lat: i.review.lat, lng: i.review.lng }, geocodeSource: "review", notes: [`reviewer: ${i.review.decision}`] };
  }

  const closeMatch = i.nearMatch && i.nearMatch.distanceM <= MATCH_DISTANCE_M ? i.nearMatch : null;
  const looseMatch = i.nearMatch && i.nearMatch.distanceM <= MEDIUM_DISTANCE_M ? i.nearMatch : null;

  if (i.sanity.usable && i.hfrPoint) {
    if (i.sanity.fixed) notes.push("latitude/longitude were swapped in HFR");
    if (i.hasBoundary) {
      if (i.inWard) {
        if (closeMatch) {
          notes.push(`${closeMatch.source} name match ${Math.round(closeMatch.distanceM)} m away (score ${closeMatch.score})`);
          return { confidence: "high", final: i.hfrPoint, geocodeSource: "hfr", notes };
        }
        if (looseMatch) {
          notes.push(`inside ward, ${looseMatch.source} name match ${Math.round(looseMatch.distanceM)} m away (score ${looseMatch.score})`);
          return { confidence: "medium", final: i.hfrPoint, geocodeSource: "hfr", notes };
        }
        notes.push("inside ward, no name match within 1.5 km");
        return { confidence: "low", final: i.hfrPoint, geocodeSource: "hfr", notes };
      }
      notes.push("HFR point is outside its registered ward");
      for (const alt of [i.relocation, i.geocode]) {
        if (alt && alt.inWard) {
          notes.push(`replacement point from ${alt.source} inside the ward`);
          return { confidence: "medium", final: { lat: alt.lat, lng: alt.lng }, geocodeSource: alt.source, notes };
        }
      }
      return { confidence: "low", final: i.hfrPoint, geocodeSource: "hfr", notes };
    }
    notes.push("no ward boundary to check against");
    if (looseMatch) {
      notes.push(`${looseMatch.source} name match ${Math.round(looseMatch.distanceM)} m away (score ${looseMatch.score})`);
      return { confidence: "medium", final: i.hfrPoint, geocodeSource: "hfr", notes };
    }
    return { confidence: "low", final: i.hfrPoint, geocodeSource: "hfr", notes };
  }

  notes.push(`HFR point unusable (${i.sanity.flags.join(", ") || "missing"})`);
  for (const alt of [i.relocation, i.geocode]) {
    if (alt && (alt.inWard === true || (alt.inWard === null && !i.hasBoundary))) {
      const conf: Confidence = alt.inWard ? "medium" : "low";
      notes.push(`location from ${alt.source}${alt.inWard ? " inside the ward" : " (no boundary to confirm)"}`);
      return { confidence: conf, final: { lat: alt.lat, lng: alt.lng }, geocodeSource: alt.source, notes };
    }
  }
  if (i.centroid) {
    notes.push("ward centre used as a stand-in");
    return { confidence: "low", final: { lat: i.centroid.lat, lng: i.centroid.lng }, geocodeSource: "ward_centroid", notes };
  }
  return { confidence: "low", final: null, geocodeSource: null, notes };
}
