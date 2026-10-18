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
