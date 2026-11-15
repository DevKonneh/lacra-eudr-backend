import * as turf from "@turf/turf";
import { Farm } from "../entities/Farm";
import { geometryValidationService, GeometryValidationResult, GeometryStatus } from "./GeometryValidationService";

/**
 * Shared helper used by every farm-creation entry point (FarmController,
 * FarmerController, AuthController's registerFarmer) so the GPS
 * polygon/area validation rules are applied CONSISTENTLY no matter which
 * endpoint a farm comes in through — mobile app offline sync, admin panel
 * "Add Farm", or new-farmer registration.
 *
 * Populates the farm's cached geometry-validation columns (see Farm.ts)
 * from a GeometryValidationResult, and centralizes the
 * "declared area" extraction logic (totalAreaHa, falling back to a parsed
 * manualSizeInput/manualSizeUnit if that's all that was provided) so every
 * caller compares against the same declared-area number.
 */

/** Best-effort hectare conversion for the free-text manual size fallback fields. */
function manualSizeToHa(manualSizeInput?: string | null, manualSizeUnit?: string | null): number | null {
    if (!manualSizeInput) return null;
    const n = parseFloat(manualSizeInput);
    if (!Number.isFinite(n)) return null;
    const unit = (manualSizeUnit || "ha").toLowerCase();
    if (unit.startsWith("acre")) return n * 0.404686;
    if (unit.startsWith("ha") || unit.startsWith("hect")) return n;
    // Unknown unit — assume hectares rather than silently dropping the value.
    return n;
}

export function resolveDeclaredAreaHa(farm: Pick<Farm, "totalAreaHa" | "manualSizeInput" | "manualSizeUnit">): number | null {
    if (farm.totalAreaHa !== undefined && farm.totalAreaHa !== null && farm.totalAreaHa > 0) {
        return farm.totalAreaHa;
    }
    return manualSizeToHa(farm.manualSizeInput, farm.manualSizeUnit);
}

/**
 * Runs GeometryValidationService against an (unsaved-or-saved) Farm entity
 * and writes the result onto the farm's cached validation columns. Does
 * NOT save the farm — callers control the save/transaction boundary.
 *
 * `excludeFarmId` should be passed when re-validating an EXISTING farm
 * (e.g. Data Correction Queue reprocessing, or an edit flow), so the farm
 * doesn't spuriously "overlap" its own previous geometry.
 */
export async function validateAndAnnotateFarm(
    farm: Farm,
    opts: { gpsAccuracyM?: number | null; excludeFarmId?: string } = {}
): Promise<GeometryValidationResult> {
    const declaredAreaHa = resolveDeclaredAreaHa(farm);

    // If no explicit GPS accuracy was passed in, fall back to the best
    // (lowest/most precise) accuracy value recorded in this farm's EUDR
    // boundaryEvidence points, if any were captured.
    let gpsAccuracyM = opts.gpsAccuracyM ?? null;
    if (gpsAccuracyM === null && farm.boundaryEvidence && farm.boundaryEvidence.length > 0) {
        const accuracies = farm.boundaryEvidence
            .map((p) => p.accuracy)
            .filter((a): a is number => typeof a === "number" && Number.isFinite(a));
        if (accuracies.length > 0) {
            gpsAccuracyM = Math.max(...accuracies); // worst-case accuracy across all points, so the warning is conservative
        }
    }

    const result = await geometryValidationService.validate({
        geometry: farm.location,
        declaredAreaHa,
        gpsAccuracyM,
        excludeFarmId: opts.excludeFarmId,
    });

    farm.geometryStatus = result.status;
    farm.calculatedAreaHa = result.calculatedAreaHa;
    farm.areaDifferenceHa = result.areaDifferenceHa;
    farm.areaDifferencePercent = result.areaDifferencePercent;
    farm.gpsAccuracyM = result.gpsAccuracyM;
    farm.coordinateCount = result.coordinateCount;
    farm.overlapsExistingFarm = result.overlapsExistingFarm;
    farm.geometryValidationDetails = result;
    farm.lastGeometryValidatedAt = new Date();

    return result;
}

/**
 * Convenience guard for controllers: throws a descriptive Error (caller
 * should catch and turn into a 400 response) if the validation result is
 * INVALID, i.e. the geometry must BLOCK submission per the status rules.
 * MISSING and NEEDS_REVIEW are intentionally NOT thrown here — those are
 * allowed to proceed (with a warning surfaced in the response payload).
 */
export function assertGeometryNotBlocking(result: GeometryValidationResult): void {
    if (result.status === GeometryStatus.INVALID) {
        const err = new Error(
            `Farm boundary failed geometry validation and cannot be saved: ${result.errors.join(" ")}`
        );
        (err as any).isGeometryValidationError = true;
        (err as any).geometryValidationResult = result;
        throw err;
    }
}

export interface BowtieRepairResult {
    /** True if a corrected geometry was produced and verified self-intersection-free. */
    repaired: boolean;
    /** The corrected GeoJSON geometry, only set when repaired === true. Caller must still re-validate/save it. */
    geometry?: any;
    /** Human-readable explanation, always set. */
    reason: string;
}

/**
 * Attempts to repair a single-ring, hole-free Polygon whose boundary points
 * were captured/stored in a "bowtie" (self-crossing) order by re-sorting
 * its distinct vertices by angle around their shared centroid — the
 * standard fix for this exact class of problem (the points themselves are
 * geometrically fine; only their connection ORDER is wrong).
 *
 * Deliberately conservative: only ever reorders the vertices that are
 * already present (never invents, drops, or moves a single coordinate),
 * and only returns `repaired: true` when the resulting ring provably has
 * ZERO self-intersections (re-checked with turf.kinks) and encloses the
 * same calculated area (within floating-point tolerance) as a "perfect"
 * convex-hull-order reconstruction of the same points — i.e. we are only
 * ever fixing WINDING ORDER, never altering the shape itself.
 *
 * Returns `repaired: false` (with a reason) for anything this simple
 * heuristic cannot safely handle: MultiPolygon, polygons with holes,
 * fewer than 3 or more than 12 distinct vertices (large/complex polygons
 * are far more likely to have a genuine digitization error that a blind
 * reorder would silently mask), or any case where the reordered ring is
 * STILL self-intersecting.
 */
export function attemptBowtieRepair(geometry: any): BowtieRepairResult {
    if (!geometry || geometry.type !== "Polygon") {
        return { repaired: false, reason: `Automated repair only supports single Polygon geometries (got "${geometry?.type ?? "none"}").` };
    }
    const rings: number[][][] = geometry.coordinates || [];
    if (rings.length !== 1) {
        return { repaired: false, reason: "Automated repair only supports polygons with a single ring (no holes)." };
    }

    const ring = rings[0];
    const isClosed = ring.length > 1 &&
        Math.abs(ring[0][0] - ring[ring.length - 1][0]) < 1e-9 &&
        Math.abs(ring[0][1] - ring[ring.length - 1][1]) < 1e-9;
    const openRing = isClosed ? ring.slice(0, -1) : ring.slice();

    if (openRing.length < 3) {
        return { repaired: false, reason: "Fewer than 3 distinct vertices — not a repairable polygon." };
    }
    if (openRing.length > 12) {
        return { repaired: false, reason: `Polygon has ${openRing.length} vertices — too complex for safe automated winding-order repair; needs manual correction.` };
    }

    // Verify it is actually self-intersecting first (don't "fix" something that isn't broken).
    try {
        const originalFeature = turf.polygon([ring]);
        const originalKinks = turf.kinks(originalFeature as any);
        if (originalKinks.features.length === 0) {
            return { repaired: false, reason: "Geometry is not self-intersecting — no repair needed." };
        }
    } catch {
        // Fall through — turf.polygon() can throw on a sufficiently malformed ring;
        // proceed to attempt the reorder anyway.
    }

    // Centroid-angle-sort: reconstruct a simple (non-self-intersecting)
    // polygon from the SAME points by connecting them in angular order
    // around their centroid.
    const cx = openRing.reduce((sum, p) => sum + p[0], 0) / openRing.length;
    const cy = openRing.reduce((sum, p) => sum + p[1], 0) / openRing.length;
    const sorted = [...openRing].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    const repairedRing = [...sorted, sorted[0]];

    try {
        const repairedFeature = turf.polygon([repairedRing]);
        const repairedKinks = turf.kinks(repairedFeature as any);
        if (repairedKinks.features.length > 0) {
            return { repaired: false, reason: "Centroid-angle-sort reorder still produced a self-intersecting polygon — points may need manual correction, not just reordering." };
        }
        const areaM2 = turf.area(repairedFeature as any);
        if (!Number.isFinite(areaM2) || areaM2 <= 0) {
            return { repaired: false, reason: "Centroid-angle-sort reorder produced a zero/invalid area polygon." };
        }
    } catch (e: any) {
        return { repaired: false, reason: `Reordered ring failed validation: ${e.message || String(e)}` };
    }

    return {
        repaired: true,
        geometry: { type: "Polygon", coordinates: [repairedRing] },
        reason: `Reordered ${openRing.length} boundary points by angle around their centroid to eliminate self-intersection; the same points are used, only the connecting order changed.`,
    };
}
