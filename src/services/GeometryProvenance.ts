/**
 * Geometry provenance.
 *
 * WHY THIS EXISTS
 * ---------------
 * `FarmController.create()` used to turn any lat/lng-only submission into a
 * synthetic Polygon: a ±0.001° axis-aligned square (≈222 m per side, ≈4.9 ha)
 * built around the single point. That had two bad consequences:
 *
 *   1. Downstream code could not tell it apart from a real field survey, so it
 *      was drawn as a surveyed boundary and could be submitted to Whisp as the
 *      farm's actual parcel.
 *   2. A farmer's real parcel is almost never a 222 m square, so the satellite
 *      verdict described a shape that does not exist on the ground.
 *
 * The fix preserves what was actually captured instead of inventing geometry:
 * a single recorded coordinate is stored as a GeoJSON **Point**, and its
 * provenance is recorded explicitly. Anything that needs a polygon must then
 * say so, rather than silently receiving a fabricated one.
 *
 * CURRENT POLICY (unchanged, pending LACRA's decision): a point-only farm has
 * no boundary, so `GeometryValidationService` reports it as MISSING and
 * assessment is blocked. That is deliberate — this module does not weaken it.
 */

export const GeometrySource = {
    /** A real boundary polygon captured in the field. */
    SURVEYED: "surveyed",
    /** A single recorded GPS coordinate. A location, NOT a boundary. */
    RECORDED_POINT: "recorded_point",
    /** A machine-generated square around a point. NOT survey evidence. */
    GENERATED_BUFFER: "generated_buffer",
} as const;

export type GeometrySourceValue = typeof GeometrySource[keyof typeof GeometrySource];

/** Half-width (degrees) of the legacy synthetic square. */
const LEGACY_SQUARE_HALF_DEG = 0.001;
/** Full span, i.e. 2 x half-width. */
const LEGACY_SQUARE_SPAN_DEG = LEGACY_SQUARE_HALF_DEG * 2;

const SPAN_TOLERANCE_DEG = 1e-9;

type GeoJsonGeometry = { type?: string; coordinates?: any } | null | undefined;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Detects the exact synthetic square that FarmController used to generate.
 *
 * Deliberately strict: a genuine surveyed field plot could coincidentally be a
 * near-square rectangle, so we only claim "generated" when the shape matches the
 * machine signature precisely — exactly 5 positions (a closed 4-corner ring),
 * axis-aligned, with a span of exactly 0.002° in both axes. A real survey never
 * lands on those exact numbers.
 */
export function isLegacyGeneratedSquare(geometry: GeoJsonGeometry): boolean {
    if (!geometry || geometry.type !== "Polygon") return false;
    const rings = geometry.coordinates;
    if (!Array.isArray(rings) || rings.length !== 1) return false;
    const ring = rings[0];
    if (!Array.isArray(ring) || ring.length !== 5) return false;

    const pts = ring as number[][];
    for (const p of pts) {
        if (!Array.isArray(p) || p.length < 2 || !isNum(p[0]) || !isNum(p[1])) return false;
    }

    // Ring must be closed (first === last).
    const first = pts[0];
    const last = pts[4];
    if (Math.abs(first[0] - last[0]) > SPAN_TOLERANCE_DEG) return false;
    if (Math.abs(first[1] - last[1]) > SPAN_TOLERANCE_DEG) return false;

    // Work from the four distinct corners, not from ring order. A client may
    // have emitted the square starting at any corner and in either winding
    // direction; the machine signature is the SHAPE, not the vertex order.
    const c = pts.slice(0, 4);
    const lngs = c.map((p) => p[0]);
    const lats = c.map((p) => p[1]);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);

    // Span must be exactly the legacy square's span in both axes. Tolerance is
    // 1e-6 (not 1e-9) only to absorb binary-float representation; it is still
    // ~100x tighter than the nearest plausible real plot (0.0021 => rejected).
    const spanLng = maxLng - minLng;
    const spanLat = maxLat - minLat;
    if (Math.abs(spanLng - LEGACY_SQUARE_SPAN_DEG) > SPAN_TOLERANCE_DEG) return false;
    if (Math.abs(spanLat - LEGACY_SQUARE_SPAN_DEG) > SPAN_TOLERANCE_DEG) return false;

    // Every corner must coincide with one of the four bounding-box corners, and
    // every bounding-box corner must be used. Together with the non-zero span
    // above, this proves the ring is an axis-aligned rectangle — not a rotated
    // diamond or an irregular field that merely has the same bounding box.
    const corners: Array<[number, number]> = [
        [minLng, minLat],
        [maxLng, minLat],
        [maxLng, maxLat],
        [minLng, maxLat],
    ];
    const used = new Set<number>();
    for (const [lng, lat] of c) {
        let matched = -1;
        for (let i = 0; i < corners.length; i++) {
            if (Math.abs(lng - corners[i][0]) <= SPAN_TOLERANCE_DEG
                && Math.abs(lat - corners[i][1]) <= SPAN_TOLERANCE_DEG) {
                matched = i;
                break;
            }
        }
        if (matched === -1) return false; // a vertex is not a bbox corner
        if (used.has(matched)) return false; // duplicate corner => not a rectangle
        used.add(matched);
    }
    if (used.size !== 4) return false;

    return true;
}

/**
 * Classifies a geometry that was SUBMITTED by a client (not yet stored).
 * Used on the creation path so provenance is recorded at the moment of capture.
 */
export function classifySubmittedGeometry(geometry: GeoJsonGeometry): GeometrySourceValue | null {
    if (!geometry || !geometry.type) return null;
    // A submitted polygon that matches the synthetic signature is almost
    // certainly a client replaying the old behaviour; do not call it surveyed.
    if (isLegacyGeneratedSquare(geometry)) return GeometrySource.GENERATED_BUFFER;
    if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") return GeometrySource.SURVEYED;
    if (geometry.type === "Point") return GeometrySource.RECORDED_POINT;
    return null;
}

/**
 * Resolves the effective provenance of a STORED farm geometry.
 *
 * `geometrySource` wins when set. For legacy rows (NULL) we infer from the
 * geometry itself, so pre-existing generated squares are still recognised even
 * before the 2034 backfill has run.
 */
export function resolveGeometrySource(
    geometry: GeoJsonGeometry,
    storedSource?: string | null
): GeometrySourceValue | null {
    if (storedSource === GeometrySource.SURVEYED
        || storedSource === GeometrySource.RECORDED_POINT
        || storedSource === GeometrySource.GENERATED_BUFFER) {
        return storedSource;
    }
    if (!geometry || !geometry.type) return null;
    if (isLegacyGeneratedSquare(geometry)) return GeometrySource.GENERATED_BUFFER;
    if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") return GeometrySource.SURVEYED;
    if (geometry.type === "Point") return GeometrySource.RECORDED_POINT;
    return null;
}

/**
 * TRUE when this geometry must NOT be treated as survey evidence — i.e. it must
 * not be submitted to Whisp as the farm's real parcel, and must not be described
 * to staff or the public as a surveyed boundary.
 *
 * A recorded GPS point is included: it is a legitimate LOCATION, but it is not a
 * boundary, and current policy blocks point-only assessment.
 */
export function isNonSurveyGeometry(geometry: GeoJsonGeometry, storedSource?: string | null): boolean {
    const source = resolveGeometrySource(geometry, storedSource);
    return source === GeometrySource.GENERATED_BUFFER || source === GeometrySource.RECORDED_POINT;
}

/** Human-readable provenance label for UI/API display. */
export function geometrySourceLabel(source: string | null | undefined): string {
    switch (source) {
        case GeometrySource.SURVEYED: return "Surveyed boundary";
        case GeometrySource.RECORDED_POINT: return "Recorded GPS point (no surveyed boundary)";
        case GeometrySource.GENERATED_BUFFER: return "Automatically generated square (not a survey)";
        default: return "Boundary provenance unknown";
    }
}

/** Minimal shape this module needs — avoids importing the Farm entity. */
type ProvenanceTarget = {
    location?: any;
    geometrySource?: string | null;
    boundaryReviewFlag?: boolean;
    boundaryReviewReason?: string | null;
};

/**
 * Records provenance for a geometry that has JUST been assigned to `farm`.
 *
 * Single entry point for every write path (live create, boundary evidence,
 * bulk/offline, registration, offline-queue replay, bowtie repair) so the rules
 * cannot drift between controllers.
 *
 * Never mutates `location` — the geometry that was actually captured stays
 * exactly as captured. This only annotates it.
 *
 * Returns the resolved source so callers can branch if they need to.
 */
export function annotateGeometryProvenance(
    farm: ProvenanceTarget,
    options: { reason?: string; flag?: boolean } = {}
): GeometrySourceValue | null {
    const source = classifySubmittedGeometry(farm.location);
    farm.geometrySource = source;
    if (!source) return null;

    // Point-only and generated shapes are not survey evidence: put them in the
    // human review queue. A real polygon needs no flag.
    const needsReview = source === GeometrySource.RECORDED_POINT
        || source === GeometrySource.GENERATED_BUFFER;

    if (options.flag === true || needsReview) {
        farm.boundaryReviewFlag = true;
        farm.boundaryReviewReason = options.reason
            ?? (source === GeometrySource.RECORDED_POINT
                ? "Recorded GPS point only — no surveyed boundary. A boundary must be surveyed before this farm can be assessed."
                : "Boundary matches the legacy auto-generated square. It is not survey evidence; re-map the real parcel before assessing.");
    }
    return source;
}
