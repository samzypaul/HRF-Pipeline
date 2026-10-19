import type { SanityResult } from "./sanity";
import { MATCH_DISTANCE_M, MEDIUM_DISTANCE_M } from "./name-match";

export type Confidence = "high" | "medium" | "low";

export interface CandidatePoint {
  source: "osm_match" | "google_match" | "nominatim" | "maptiler_geocode" | "arcgis_geocode" | "google_geocode" | "village_centroid" | "ward_centroid" | "council_centroid";
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
  /** the HFR point is clearly outside the council polygon (false when there is none to test) */
  hfrOutsideCouncil?: boolean;
  /** best name match near the HFR point (≤ SEARCH_RADIUS_M); weak = the name's distinctive part is under 4 characters */
  nearMatch: { source: "osm" | "google"; score: number; distanceM: number; weak?: boolean } | null;
  /** a matching place elsewhere that could replace a bad / missing HFR point */
  relocation: CandidatePoint | null;
  geocode: CandidatePoint | null;
  /** the centre of the village polygon named in the HFR record */
  villageCentroid?: CandidatePoint | null;
  centroid: CandidatePoint | null;
  /** the centre of the registered council polygon, the coarsest stand-in */
  councilCentroid?: CandidatePoint | null;
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
 *  high   – HFR point inside its ward AND a name match within MATCH_DISTANCE_M, 1 km (or a reviewer confirmed it)
 *  medium – inside its ward with a name match 1–3.5 km away (MEDIUM_DISTANCE_M), OR a replacement point found inside the ward
 *  low    – everything else: no name match within 3.5 km, outside its ward or council, a stand-in centre, or unusable point
 * The HFR coordinates themselves are never modified; `final` is a separate corrected set.
 * `adjustGrade` then applies the village, geocoder and shared-point evidence.
 */
export function grade(i: GradeInput): GradeResult {
  const notes: string[] = [];

  if (i.review && i.review.lat != null && i.review.lng != null) {
    return { confidence: "high", final: { lat: i.review.lat, lng: i.review.lng }, geocodeSource: "review", notes: [`reviewer: ${i.review.decision}`] };
  }

  const closeMatch = i.nearMatch && !i.nearMatch.weak && i.nearMatch.distanceM <= MATCH_DISTANCE_M ? i.nearMatch : null;
  const looseMatch = i.nearMatch && i.nearMatch.distanceM <= MEDIUM_DISTANCE_M ? i.nearMatch : null;

  if (i.sanity.usable && i.hfrPoint) {
    if (i.sanity.fixed) notes.push("latitude/longitude were swapped in HFR");
    if (i.hfrOutsideCouncil) {
      notes.push("HFR point is outside its registered council");
      for (const alt of [i.relocation, i.geocode]) {
        if (alt && alt.inWard !== false) {
          notes.push(`replacement point from ${alt.source} inside the council`);
          return { confidence: "medium", final: { lat: alt.lat, lng: alt.lng }, geocodeSource: alt.source, notes };
        }
      }
      return { confidence: "low", final: i.hfrPoint, geocodeSource: "hfr", notes };
    }
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
        notes.push(`inside ward, no name match within ${MEDIUM_DISTANCE_M / 1000} km`);
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
  if (i.villageCentroid) {
    notes.push("centre of the HFR village used as a stand-in");
    return { confidence: "low", final: { lat: i.villageCentroid.lat, lng: i.villageCentroid.lng }, geocodeSource: "village_centroid", notes };
  }
  if (i.centroid) {
    notes.push("ward centre used as a stand-in");
    return { confidence: "low", final: { lat: i.centroid.lat, lng: i.centroid.lng }, geocodeSource: "ward_centroid", notes };
  }
  if (i.councilCentroid) {
    notes.push("council centre used as a stand-in");
    return { confidence: "low", final: { lat: i.councilCentroid.lat, lng: i.councilCentroid.lng }, geocodeSource: "council_centroid", notes };
  }
  return { confidence: "low", final: null, geocodeSource: null, notes };
}

export interface GradeEvidence {
  /** village polygon under the final point: its name agrees with the HFR village, and whether its ward differs from the HFR ward */
  village: { check: "agrees" | "differs" | "unknown"; wardDiffers: boolean } | null;
  /** the reverse geocoder places the final point in a different ward/council than the HFR record */
  geocoderWardDiffers: boolean;
  /** another facility has exactly the same HFR coordinates */
  sharedPoint: boolean;
  /** the final point is not inside the ward (null when unknown) */
  inWard: boolean | null;
}

const ORDER: Confidence[] = ["low", "medium", "high"];
const shift = (c: Confidence, by: number): Confidence => ORDER[Math.max(0, Math.min(2, ORDER.indexOf(c) + by))];

/**
 * Apply the evidence that is only known once the point is chosen. Stand-in centres and reviewer decisions are left alone.
 *  - village and ward both agree with the HFR record → one grade up (a second, independent source)
 *  - village in another ward, or geocoder in another ward → one grade down; both → low
 *  - another facility has the same HFR coordinates → one grade down, until a reviewer confirms the point
 */
export function adjustGrade(r: GradeResult, e: GradeEvidence): GradeResult {
  if (r.geocodeSource === "review" || !r.final || r.geocodeSource === "ward_centroid" || r.geocodeSource === "village_centroid" || r.geocodeSource === "council_centroid") return r;
  const notes = [...r.notes];
  let confidence = r.confidence;
  const villageDiffers = !!e.village?.wardDiffers;

  if (villageDiffers && e.geocoderWardDiffers) {
    confidence = "low";
    notes.push("both the village polygon and the geocoder place this point in another ward");
  } else if (villageDiffers || e.geocoderWardDiffers) {
    confidence = shift(confidence, -1);
    notes.push(villageDiffers ? "the village polygon under the point belongs to another ward" : "the geocoder places this point in another ward");
  } else if (e.village?.check === "agrees" && e.inWard !== false && r.geocodeSource === "hfr" && !r.notes.some((n) => n.startsWith("HFR point is outside"))) {
    confidence = shift(confidence, 1);
    notes.push("the village polygon under the point matches the HFR village and ward");
  }
  if (e.sharedPoint && r.geocodeSource === "hfr") {
    confidence = shift(confidence, -1);
    notes.push("another facility has exactly the same coordinates");
  }
  return confidence === r.confidence && notes.length === r.notes.length ? r : { ...r, confidence, notes };
}
