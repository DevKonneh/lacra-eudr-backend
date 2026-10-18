import * as turf from "@turf/turf";
import { AppDataSource } from "../data-source";
import { Farm } from "../entities/Farm";
import { GEO_VALIDATION_CONFIG as CFG } from "../config/geoValidation.config";

/**
 * GPS polygon / farm-area validation.
 *
 * WHY THIS EXISTS: prior to this service, a farm's `riskLevel` (and
 * therefore its "compliant" status on the Reports dashboard) was
 * completely disconnected from whether its GPS polygon was even
 * geometrically valid — a farm with a declared area of thousands of
 * hectares but a calculated polygon area of 0.00 ha (e.g. because the
 * boundary was a single repeated point, or a self-intersecting shape)
 * could still show "GPS/Polygon: 100%" and be counted as fully
 * compliant. This service is the single source of truth for "is this
 * farm's boundary geometrically trustworthy enough to run compliance
 * analysis on", and MUST be run (and pass, or at least not be blocking)
 * before RiskService.analyzeFarm() is allowed to proceed.
 *
 * STATUS MODEL (see GeometryStatus below):
 *   - "missing"      : no polygon at all (legacy point-only farm, or no
 *                        location submitted yet). Farm creation is still
 *                        ALLOWED (does not block saving the record — we
 *                        never want to lose a farmer's other data just
 *                        because a polygon hasn't been drawn yet), but
 *                        compliance/risk analysis is blocked until a
 *                        real polygon is supplied.
 *   - "invalid"      : the polygon fails basic geometric soundness
 *                        (self-intersecting, not closed, <3 distinct
 *                        non-collinear points, duplicate points that
 *                        prevent area calculation, zero/near-zero area,
 *                        or coordinates outside Liberia's bounding box).
 *                        BLOCKS submission entirely.
 *   - "needs_review" : the polygon is geometrically valid, but something
 *                        about it is suspicious (declared-vs-calculated
 *                        area mismatch beyond tolerance, unusual/
 *                        irregular shape, low GPS accuracy, or overlap
 *                        with another registered farm). Submission is
 *                        ALLOWED but flagged for manual review, and this
 *                        status alone should not be treated as
 *                        "compliant" on dashboards.
 *   - "valid"        : passed every check cleanly.
 */

export enum GeometryStatus {
    VALID = "Valid",
    NEEDS_REVIEW = "Needs Review",
    INVALID = "Invalid",
    MISSING = "Missing",
}

export interface OverlappingFarmInfo {
    farmId: string;
    farmName: string;
    overlapAreaHa: number;
}

export interface GeometryValidationResult {
    /** Overall status — see GeometryStatus doc above. */
    status: GeometryStatus;
    /** True only for INVALID — caller MUST reject/block the submission. */
    blockSubmission: boolean;
    /** True for NEEDS_REVIEW — caller should allow save but flag it. */
    needsReview: boolean;
    /** True only when status === MISSING — no polygon was supplied at all. */
    isPolygonMissing: boolean;

    /** Hard validation failures. Non-empty only when status === INVALID. */
    errors: string[];
    /** Non-blocking concerns. Populated for NEEDS_REVIEW (and sometimes VALID/info-only). */
    warnings: string[];

    // --- Display fields (per the DISPLAY requirement) ---
    calculatedAreaHa: number | null;
    declaredAreaHa: number | null;
    areaDifferenceHa: number | null;
    areaDifferencePercent: number | null;
    materialAreaDifference: boolean;
    gpsAccuracyM: number | null;
    gpsAccuracyWithinTolerance: boolean | null;
    coordinateCount: number;
    isClosed: boolean | null;
    isSelfIntersecting: boolean;
    hasDuplicatePoints: boolean;
    hasCollinearPoints: boolean;
    withinLiberiaBounds: boolean | null;
    isUnusualShape: boolean;
    overlapsExistingFarm: boolean;
    overlappingFarms: OverlappingFarmInfo[];

    /** Config values actually applied for this validation run (for transparency/reporting). */
    toleranceConfig: typeof CFG;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle-ish planar distance approximation good enough for tiny epsilon/duplicate checks. */
function coordsRoughlyEqual(a: number[], b: number[], epsilonDeg: number): boolean {
    return Math.abs(a[0] - b[0]) < epsilonDeg && Math.abs(a[1] - b[1]) < epsilonDeg;
}

/** Signed area (shoelace, in degree^2 units — only used for a relative collinearity test, not real area). */
function triangleArea2(a: number[], b: number[], c: number[]): number {
    return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
}

/** Extracts every outer+inner ring's coordinate array from a Polygon or MultiPolygon geometry. */
function extractRings(geometry: any): number[][][] {
    if (!geometry) return [];
    if (geometry.type === "Polygon") return geometry.coordinates || [];
    if (geometry.type === "MultiPolygon") return (geometry.coordinates || []).flat();
    return [];
}

/** Extracts just the OUTER ring of every polygon part (ignores holes) — used for shape-quality checks. */
function extractOuterRings(geometry: any): number[][][] {
    if (!geometry) return [];
    if (geometry.type === "Polygon") return geometry.coordinates?.[0] ? [geometry.coordinates[0]] : [];
    if (geometry.type === "MultiPolygon") {
        return (geometry.coordinates || []).map((poly: number[][][]) => poly[0]).filter(Boolean);
    }
    return [];
}

export interface ValidateGeometryInput {
    /** GeoJSON geometry (Polygon, MultiPolygon, or Point/legacy). */
    geometry: any;
    /** Farmer/inspector-declared area in hectares, if any (e.g. manualSizeInput converted, or totalAreaHa field). */
    declaredAreaHa?: number | null;
    /** GPS accuracy in meters captured during boundary collection, if available. */
    gpsAccuracyM?: number | null;
    /** When re-validating an EXISTING farm, its own id — excluded from the overlap check. */
    excludeFarmId?: string;
    /** Skip the farm-to-farm overlap DB query (e.g. for pure unit tests with no DB). */
    skipOverlapCheck?: boolean;
}

export class GeometryValidationService {
    private farmRepo = AppDataSource.getRepository(Farm);

    async validate(input: ValidateGeometryInput): Promise<GeometryValidationResult> {
        const { geometry, declaredAreaHa = null, gpsAccuracyM = null } = input;

        const base: GeometryValidationResult = {
            status: GeometryStatus.VALID,
            blockSubmission: false,
            needsReview: false,
            isPolygonMissing: false,
            errors: [],
            warnings: [],
            calculatedAreaHa: null,
            declaredAreaHa,
            areaDifferenceHa: null,
            areaDifferencePercent: null,
            materialAreaDifference: false,
            gpsAccuracyM,
            gpsAccuracyWithinTolerance: null,
            coordinateCount: 0,
            isClosed: null,
            isSelfIntersecting: false,
            hasDuplicatePoints: false,
            hasCollinearPoints: false,
            withinLiberiaBounds: null,
            isUnusualShape: false,
            overlapsExistingFarm: false,
            overlappingFarms: [],
            toleranceConfig: CFG,
        };

        // --- 0. No polygon at all (missing / point-only legacy geometry) ---
        if (!geometry || geometry.type === "Point" || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) {
            base.status = GeometryStatus.MISSING;
            base.isPolygonMissing = true;
            base.warnings.push(
                "No boundary polygon has been mapped for this farm (only a single point, or nothing, was provided). " +
                "A polygon is required before compliance analysis can run."
            );
            return base;
        }

        const outerRings = extractOuterRings(geometry);
        const allRings = extractRings(geometry);

        if (outerRings.length === 0) {
            base.status = GeometryStatus.INVALID;
            base.blockSubmission = true;
            base.errors.push("Polygon geometry has no coordinate rings.");
            return base;
        }

        // --- 1. Closed ring check (every ring, but report on the outer ring primarily) ---
        let allClosed = true;
        for (const ring of allRings) {
            if (ring.length < 2) { allClosed = false; continue; }
            const first = ring[0];
            const last = ring[ring.length - 1];
            if (!coordsRoughlyEqual(first, last, 1e-9)) {
                allClosed = false;
            }
        }
        base.isClosed = allClosed;
        if (!allClosed) {
            base.errors.push("Polygon is not closed (the first and last coordinates of the boundary must match).");
        }

        // --- 2. Distinct-vertex / duplicate-point / collinearity checks (per outer ring) ---
        let totalCoordCount = 0;
        let anyDuplicates = false;
        let anyCollinearDegenerate = false;
        let anyTooFewDistinctVertices = false;

        for (const ring of outerRings) {
            // Drop the closing point (last === first) before de-duplicating/counting distinct vertices.
            const openRing = ring.length > 1 && coordsRoughlyEqual(ring[0], ring[ring.length - 1], 1e-9)
                ? ring.slice(0, -1)
                : ring.slice();

            totalCoordCount += openRing.length;

            // Duplicate-point detection: any two vertices (not counting the
            // closing point already removed above) within DUPLICATE_POINT_EPSILON_DEG
            // of each other are true accidental duplicates, not distinct corners.
            const distinctVertices: number[][] = [];
            for (const pt of openRing) {
                const isDup = distinctVertices.some((v) => coordsRoughlyEqual(v, pt, CFG.DUPLICATE_POINT_EPSILON_DEG));
                if (isDup) {
                    anyDuplicates = true;
                } else {
                    distinctVertices.push(pt);
                }
            }

            if (distinctVertices.length < CFG.MIN_DISTINCT_VERTICES) {
                anyTooFewDistinctVertices = true;
            }

            // Collinearity: if EVERY triplet of consecutive distinct vertices is
            // (near-)collinear, the "polygon" is actually a degenerate line/spike
            // with no real enclosed area, even if it nominally has >=3 vertices.
            if (distinctVertices.length >= 3) {
                // Scale tolerance relative to the ring's bounding-box diagonal^2
                // so this works equally for a 0.1 ha garden and a 500 ha estate.
                const lons = distinctVertices.map((p) => p[0]);
                const lats = distinctVertices.map((p) => p[1]);
                const bboxDiag2 =
                    Math.pow(Math.max(...lons) - Math.min(...lons), 2) +
                    Math.pow(Math.max(...lats) - Math.min(...lats), 2);
                const relTol = Math.max(bboxDiag2 * CFG.COLLINEARITY_RELATIVE_TOLERANCE, 1e-18);

                let allCollinear = true;
                for (let i = 0; i < distinctVertices.length - 2; i++) {
                    const area2 = triangleArea2(distinctVertices[i], distinctVertices[i + 1], distinctVertices[i + 2]);
                    if (area2 > relTol) {
                        allCollinear = false;
                        break;
                    }
                }
                if (allCollinear) anyCollinearDegenerate = true;
            } else {
                // Fewer than 3 distinct vertices is inherently degenerate/collinear.
                anyCollinearDegenerate = true;
            }
        }

        base.coordinateCount = totalCoordCount;
        base.hasDuplicatePoints = anyDuplicates;
        base.hasCollinearPoints = anyCollinearDegenerate;

        if (anyTooFewDistinctVertices) {
            base.errors.push(
                `Polygon must contain at least ${CFG.MIN_DISTINCT_VERTICES} distinct, non-collinear coordinates ` +
                `(after removing duplicate/repeated points).`
            );
        }
        if (anyDuplicates) {
            base.errors.push("Duplicate coordinate points detected that prevent a valid area calculation.");
        }
        if (anyCollinearDegenerate && !anyTooFewDistinctVertices) {
            base.errors.push("All boundary points are collinear (a straight line), which does not form a valid enclosed area.");
        }

        // --- 3. Self-intersection check (turf.kinks) ---
        try {
            const feature = geometry.type === "Polygon" ? turf.polygon(geometry.coordinates) : turf.multiPolygon(geometry.coordinates);
            const kinks = turf.kinks(feature as any);
            if (kinks.features.length > 0) {
                base.isSelfIntersecting = true;
                base.errors.push(
                    `Polygon boundary is self-intersecting (crosses itself at ${kinks.features.length} point(s)).`
                );
            }
        } catch (e: any) {
            // turf.kinks/turf.polygon can throw on already-degenerate rings (e.g.
            // rings with <4 positions) — that case is already caught above by the
            // distinct-vertex/closed-ring checks, so just note it without crashing.
            base.errors.push(`Unable to evaluate self-intersection: ${e.message || "invalid ring structure"}.`);
        }

        // --- 4. Liberia bounding-box check (every coordinate, every ring) ---
        const { south, north, west, east } = CFG.LIBERIA_BOUNDS;
        let allWithinBounds = true;
        for (const ring of allRings) {
            for (const [lng, lat] of ring) {
                if (lat < south || lat > north || lng < west || lng > east) {
                    allWithinBounds = false;
                }
            }
        }
        base.withinLiberiaBounds = allWithinBounds;
        if (!allWithinBounds) {
            base.errors.push(
                `One or more coordinates fall outside Liberia's valid geographic boundary ` +
                `(lat ${south}\u2013${north}, lng ${west}\u2013${east}).`
            );
        }

        // --- 5. Calculated area (only meaningful once structure is sound enough to compute it) ---
        let calculatedAreaHa: number | null = null;
        try {
            const areaM2 = turf.area(geometry);
            calculatedAreaHa = areaM2 / 10000;
        } catch (e) {
            calculatedAreaHa = null;
        }
        base.calculatedAreaHa = calculatedAreaHa !== null ? parseFloat(calculatedAreaHa.toFixed(4)) : null;

        const hasStructuralErrorsSoFar = base.errors.length > 0;

        if (calculatedAreaHa === null) {
            base.errors.push("Calculated polygon area could not be determined (invalid geometry structure).");
        } else if (calculatedAreaHa < CFG.MIN_VALID_AREA_HA) {
            // This is the exact bug from the report: NEVER silently show 0.00 ha —
            // always attach an explanation of *why* the area computed to zero.
            const reason = hasStructuralErrorsSoFar
                ? "due to the geometry problem(s) listed above"
                : "for an undetermined reason (degenerate polygon)";
            base.errors.push(
                `Calculated polygon area is ${base.calculatedAreaHa?.toFixed(4) ?? "0.0000"} ha (effectively zero) ${reason}. ` +
                `A valid farm boundary must enclose a real, positive area.`
            );
        }

        // --- Decide BLOCKING status now, before running the non-blocking checks below ---
        if (base.errors.length > 0) {
            base.status = GeometryStatus.INVALID;
            base.blockSubmission = true;
            // Non-blocking checks are still computed below for full transparency in
            // the response, but they cannot upgrade an INVALID result.
        }

        // --- 6. Declared vs calculated area comparison (configurable tolerance) ---
        if (calculatedAreaHa !== null && declaredAreaHa !== null && declaredAreaHa !== undefined && declaredAreaHa > 0) {
            const diffHa = Math.abs(declaredAreaHa - calculatedAreaHa);
            const diffPercent = (diffHa / declaredAreaHa) * 100;
            base.areaDifferenceHa = parseFloat(diffHa.toFixed(4));
            base.areaDifferencePercent = parseFloat(diffPercent.toFixed(2));
            if (
                diffPercent > CFG.AREA_DIFFERENCE_PERCENT_TOLERANCE &&
                diffHa > CFG.AREA_DIFFERENCE_ABSOLUTE_HA_FLOOR
            ) {
                base.materialAreaDifference = true;
                base.warnings.push(
                    `Declared area (${declaredAreaHa.toFixed(2)} ha) differs from the calculated polygon area ` +
                    `(${calculatedAreaHa.toFixed(2)} ha) by ${diffPercent.toFixed(1)}% (${diffHa.toFixed(2)} ha), ` +
                    `exceeding the configured tolerance of ${CFG.AREA_DIFFERENCE_PERCENT_TOLERANCE}%.`
                );
            }
        }

        // --- 7. GPS accuracy tolerance warning ---
        if (gpsAccuracyM !== null && gpsAccuracyM !== undefined) {
            base.gpsAccuracyWithinTolerance = gpsAccuracyM <= CFG.GPS_ACCURACY_WARNING_THRESHOLD_M;
            if (!base.gpsAccuracyWithinTolerance) {
                base.warnings.push(
                    `GPS accuracy at time of mapping (${gpsAccuracyM.toFixed(1)} m) is outside the approved tolerance ` +
                    `of ${CFG.GPS_ACCURACY_WARNING_THRESHOLD_M} m.`
                );
            }
        }

        // --- 8. Unusual shape detection (convexity ratio + compactness ratio) ---
        if (!hasStructuralErrorsSoFar && calculatedAreaHa !== null && calculatedAreaHa > 0) {
            try {
                const unusual = this.detectUnusualShape(geometry, calculatedAreaHa);
                if (unusual) {
                    base.isUnusualShape = true;
                    base.warnings.push(
                        "Polygon shape is unusually irregular for a farm boundary (very elongated, spiky, or non-convex) — recommend manual review."
                    );
                }
            } catch {
                // Non-fatal — shape-quality heuristics are best-effort only.
            }
        }

        // --- 9. Farm-to-farm overlap detection ---
        if (!input.skipOverlapCheck && !hasStructuralErrorsSoFar) {
            try {
                const overlaps = await this.findOverlappingFarms(geometry, input.excludeFarmId);
                if (overlaps.length > 0) {
                    base.overlapsExistingFarm = true;
                    base.overlappingFarms = overlaps;
                    const names = overlaps.map((o) => `"${o.farmName}" (${o.overlapAreaHa.toFixed(3)} ha)`).join(", ");
                    base.warnings.push(`Polygon overlaps with existing registered farm(s): ${names}.`);
                }
            } catch (e: any) {
                console.error("Farm overlap check failed:", e);
                // Fail-open on infra errors (don't block a legitimate submission
                // just because the overlap query itself errored), but surface it.
                base.warnings.push("Farm-to-farm overlap check could not be completed (spatial query error).");
            }
        }

        // --- Final status resolution ---
        if (base.status !== GeometryStatus.INVALID) {
            if (base.warnings.length > 0) {
                base.status = GeometryStatus.NEEDS_REVIEW;
                base.needsReview = true;
            } else {
                base.status = GeometryStatus.VALID;
            }
        }

        return base;
    }

    /**
     * Convexity + compactness heuristic for "unusual polygon shape" detection.
     * Returns true if the shape looks abnormally irregular for a real farm
     * boundary (very concave relative to its convex hull, OR an extremely
     * elongated/thin perimeter-to-area ratio).
     */
    private detectUnusualShape(geometry: any, areaHa: number): boolean {
        const outerRings = extractOuterRings(geometry);
        if (outerRings.length === 0) return false;

        // Use the largest sub-polygon (by point count) as representative for MultiPolygon.
        const ring = outerRings.reduce((a, b) => (b.length > a.length ? b : a));
        if (ring.length < 4) return false;

        // Convexity ratio: actual area / convex-hull area.
        try {
            const pts = turf.points(ring);
            const hull = turf.convex(pts);
            if (hull) {
                const hullAreaM2 = turf.area(hull);
                const actualAreaM2 = areaHa * 10000;
                if (hullAreaM2 > 0) {
                    const ratio = actualAreaM2 / hullAreaM2;
                    if (ratio < CFG.MIN_CONVEXITY_RATIO) return true;
                }
            }
        } catch {
            /* ignore — fall through to compactness check */
        }

        // Compactness ratio: perimeter_m / sqrt(area_m2). ~3.5-4 for round/square
        // shapes; much higher for long thin slivers.
        try {
            const line = turf.lineString(ring);
            const perimeterM = turf.length(line, { units: "meters" });
            const areaM2 = areaHa * 10000;
            if (areaM2 > 0) {
                const compactness = perimeterM / Math.sqrt(areaM2);
                if (compactness > CFG.MAX_COMPACTNESS_RATIO) return true;
            }
        } catch {
            /* ignore */
        }

        return false;
    }

    /**
     * Finds other registered farms whose polygon geometrically overlaps the
     * given geometry by more than the configured minimum intersection area
     * (guards against false positives from two farms merely sharing a
     * boundary edge). Excludes `excludeFarmId` (the farm being validated,
     * when re-validating an existing record).
     */
    async findOverlappingFarms(geometry: any, excludeFarmId?: string): Promise<OverlappingFarmInfo[]> {
        const geomJson = JSON.stringify(geometry);
        const qb = this.farmRepo
            .createQueryBuilder("farm")
            .select("farm.id", "id")
            .addSelect("farm.name", "name")
            .addSelect(
                "ST_Area(ST_Intersection(farm.location, ST_SetSRID(ST_GeomFromGeoJSON(:geomJson), 4326))::geography)",
                "overlapAreaM2"
            )
            .where("ST_GeometryType(farm.location) IN ('ST_Polygon', 'ST_MultiPolygon')")
            .andWhere("ST_Intersects(farm.location, ST_SetSRID(ST_GeomFromGeoJSON(:geomJson), 4326))")
            .setParameter("geomJson", geomJson);

        if (excludeFarmId) {
            qb.andWhere("farm.id != :excludeFarmId", { excludeFarmId });
        }

        const rows = await qb.getRawMany();
        return rows
            .map((r) => ({
                farmId: r.id,
                farmName: r.name,
                overlapAreaHa: parseFloat(r.overlapAreaM2 || "0") / 10000,
            }))
            .filter((r) => r.overlapAreaHa * 10000 > CFG.OVERLAP_MIN_INTERSECTION_M2);
    }
}

export const geometryValidationService = new GeometryValidationService();
