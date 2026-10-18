import "reflect-metadata";
import { GeometryValidationService, GeometryStatus } from "../GeometryValidationService";

/**
 * Automated tests for GPS polygon / farm-area validation, per the 8
 * required scenarios:
 *   1. Zero-area polygon
 *   2. Collinear points
 *   3. Duplicate coordinates
 *   4. Self-intersecting polygon
 *   5. Polygon outside Liberia
 *   6. Large declared/calculated-area difference
 *   7. Overlapping farms
 *   8. Valid farm polygon
 *
 * All tests instantiate GeometryValidationService directly and pass
 * `skipOverlapCheck: true` (except the dedicated overlap test, which mocks
 * the DB-backed overlap lookup) so this suite runs with NO real database
 * connection required.
 */

// A real, valid ~4.9 ha square near Gbarnga, Bong County, Liberia (well
// inside Liberia's bounding box: lat 4.155-8.552, lng -11.608 to -7.367).
const VALID_SQUARE_LIBERIA = {
    type: "Polygon",
    coordinates: [[
        [-9.501, 6.999],
        [-9.499, 6.999],
        [-9.499, 7.001],
        [-9.501, 7.001],
        [-9.501, 6.999],
    ]],
};
const VALID_SQUARE_AREA_HA = 4.9145; // approx, computed via turf.area

describe("GeometryValidationService", () => {
    let service: GeometryValidationService;

    beforeEach(() => {
        service = new GeometryValidationService();
    });

    // ---------------------------------------------------------------
    // 1. Zero-area polygon
    // ---------------------------------------------------------------
    test("Scenario 1: zero-area polygon (all points identical) is INVALID and blocks submission with an explanation", async () => {
        const zeroAreaGeometry = {
            type: "Polygon",
            coordinates: [[
                [-9.5, 7.0],
                [-9.5, 7.0],
                [-9.5, 7.0],
                [-9.5, 7.0],
            ]],
        };

        const result = await service.validate({
            geometry: zeroAreaGeometry,
            declaredAreaHa: 1000, // the exact reported bug: huge declared area, 0 calculated
            skipOverlapCheck: true,
        });

        expect(result.status).toBe(GeometryStatus.INVALID);
        expect(result.blockSubmission).toBe(true);
        // Must NEVER silently show 0.00 ha without explanation.
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.some((e) => e.toLowerCase().includes("area"))).toBe(true);
    });

    // ---------------------------------------------------------------
    // 2. Collinear points
    // ---------------------------------------------------------------
    test("Scenario 2: collinear points (a straight line, not an enclosed shape) is INVALID", async () => {
        const collinearGeometry = {
            type: "Polygon",
            coordinates: [[
                [-9.500, 7.000],
                [-9.490, 7.000],
                [-9.480, 7.000], // all three on the same latitude line
                [-9.500, 7.000],
            ]],
        };

        const result = await service.validate({
            geometry: collinearGeometry,
            skipOverlapCheck: true,
        });

        expect(result.status).toBe(GeometryStatus.INVALID);
        expect(result.blockSubmission).toBe(true);
        expect(result.hasCollinearPoints).toBe(true);
        expect(result.errors.some((e) => e.toLowerCase().includes("collinear") || e.toLowerCase().includes("distinct"))).toBe(true);
    });

    // ---------------------------------------------------------------
    // 3. Duplicate coordinates
    // ---------------------------------------------------------------
    test("Scenario 3: duplicate coordinate points preventing valid area calculation is INVALID", async () => {
        const duplicatePointGeometry = {
            type: "Polygon",
            coordinates: [[
                [-9.501, 6.999],
                [-9.501, 6.999], // exact duplicate of the first point
                [-9.499, 6.999],
                [-9.499, 7.001],
                [-9.501, 6.999],
            ]],
        };

        const result = await service.validate({
            geometry: duplicatePointGeometry,
            skipOverlapCheck: true,
        });

        expect(result.hasDuplicatePoints).toBe(true);
        expect(result.status).toBe(GeometryStatus.INVALID);
        expect(result.blockSubmission).toBe(true);
        expect(result.errors.some((e) => e.toLowerCase().includes("duplicate"))).toBe(true);
    });

    // ---------------------------------------------------------------
    // 4. Self-intersecting polygon
    // ---------------------------------------------------------------
    test("Scenario 4: self-intersecting (bowtie) polygon is INVALID", async () => {
        // Classic bowtie/hourglass shape: edges cross in the middle.
        const bowtieGeometry = {
            type: "Polygon",
            coordinates: [[
                [-9.502, 6.998],
                [-9.498, 7.002],
                [-9.498, 6.998],
                [-9.502, 7.002],
                [-9.502, 6.998],
            ]],
        };

        const result = await service.validate({
            geometry: bowtieGeometry,
            skipOverlapCheck: true,
        });

        expect(result.isSelfIntersecting).toBe(true);
        expect(result.status).toBe(GeometryStatus.INVALID);
        expect(result.blockSubmission).toBe(true);
        expect(result.errors.some((e) => e.toLowerCase().includes("self-intersecting"))).toBe(true);
    });

    // ---------------------------------------------------------------
    // 5. Polygon outside Liberia
    // ---------------------------------------------------------------
    test("Scenario 5: polygon entirely outside Liberia's geographic boundary is INVALID", async () => {
        // A valid, well-formed square — but centered in the Atlantic Ocean far
        // from Liberia (lat 0, lng 0), well outside the configured bounding box.
        const outsideLiberiaGeometry = {
            type: "Polygon",
            coordinates: [[
                [-0.001, -0.001],
                [0.001, -0.001],
                [0.001, 0.001],
                [-0.001, 0.001],
                [-0.001, -0.001],
            ]],
        };

        const result = await service.validate({
            geometry: outsideLiberiaGeometry,
            skipOverlapCheck: true,
        });

        expect(result.withinLiberiaBounds).toBe(false);
        expect(result.status).toBe(GeometryStatus.INVALID);
        expect(result.blockSubmission).toBe(true);
        expect(result.errors.some((e) => e.toLowerCase().includes("liberia"))).toBe(true);
    });

    // ---------------------------------------------------------------
    // 6. Large declared/calculated-area difference
    // ---------------------------------------------------------------
    test("Scenario 6: valid geometry but large declared-vs-calculated area difference is NEEDS_REVIEW (not blocked)", async () => {
        const result = await service.validate({
            geometry: VALID_SQUARE_LIBERIA,
            declaredAreaHa: 50, // real calculated area is ~4.9ha -- huge mismatch
            skipOverlapCheck: true,
        });

        expect(result.status).toBe(GeometryStatus.NEEDS_REVIEW);
        expect(result.blockSubmission).toBe(false); // valid geometry -> allowed, just flagged
        expect(result.needsReview).toBe(true);
        expect(result.materialAreaDifference).toBe(true);
        expect(result.areaDifferenceHa).not.toBeNull();
        expect(result.areaDifferencePercent).not.toBeNull();
        expect(result.areaDifferencePercent!).toBeGreaterThan(15);
        expect(result.warnings.some((w) => w.toLowerCase().includes("differ"))).toBe(true);
    });

    // ---------------------------------------------------------------
    // 7. Overlapping farms
    // ---------------------------------------------------------------
    test("Scenario 7: valid geometry that overlaps an existing registered farm is NEEDS_REVIEW", async () => {
        // Mock the DB-backed overlap lookup so this test needs no real database.
        jest.spyOn(service, "findOverlappingFarms").mockResolvedValueOnce([
            { farmId: "existing-farm-id", farmName: "Neighboring Farm", overlapAreaHa: 1.2 },
        ]);

        const result = await service.validate({
            geometry: VALID_SQUARE_LIBERIA,
            declaredAreaHa: VALID_SQUARE_AREA_HA, // matches, no area-mismatch warning
            skipOverlapCheck: false,
        });

        expect(result.status).toBe(GeometryStatus.NEEDS_REVIEW);
        expect(result.blockSubmission).toBe(false);
        expect(result.overlapsExistingFarm).toBe(true);
        expect(result.overlappingFarms.length).toBe(1);
        expect(result.overlappingFarms[0].farmName).toBe("Neighboring Farm");
        expect(result.warnings.some((w) => w.toLowerCase().includes("overlap"))).toBe(true);
    });

    // ---------------------------------------------------------------
    // 8. Valid farm polygon
    // ---------------------------------------------------------------
    test("Scenario 8: a clean, valid farm polygon with matching declared area and good GPS accuracy passes as VALID", async () => {
        const result = await service.validate({
            geometry: VALID_SQUARE_LIBERIA,
            declaredAreaHa: VALID_SQUARE_AREA_HA, // matches calculated area closely
            gpsAccuracyM: 5, // well within the 15m default tolerance
            skipOverlapCheck: true,
        });

        expect(result.status).toBe(GeometryStatus.VALID);
        expect(result.blockSubmission).toBe(false);
        expect(result.needsReview).toBe(false);
        expect(result.errors.length).toBe(0);
        expect(result.warnings.length).toBe(0);
        expect(result.calculatedAreaHa).toBeGreaterThan(0);
        expect(result.isSelfIntersecting).toBe(false);
        expect(result.hasDuplicatePoints).toBe(false);
        expect(result.hasCollinearPoints).toBe(false);
        expect(result.withinLiberiaBounds).toBe(true);
        expect(result.isClosed).toBe(true);
        expect(result.overlapsExistingFarm).toBe(false);
        expect(result.gpsAccuracyWithinTolerance).toBe(true);
    });

    // ---------------------------------------------------------------
    // Extra: missing polygon (no geometry at all) -> MISSING, not blocking save
    // ---------------------------------------------------------------
    test("Extra: missing polygon (point-only legacy geometry) yields MISSING status, does not block farm save", async () => {
        const pointOnly = { type: "Point", coordinates: [-9.5, 7.0] };

        const result = await service.validate({
            geometry: pointOnly,
            skipOverlapCheck: true,
        });

        expect(result.status).toBe(GeometryStatus.MISSING);
        expect(result.isPolygonMissing).toBe(true);
        expect(result.blockSubmission).toBe(false); // does not block the farm record itself
    });

    // ---------------------------------------------------------------
    // Extra: not-closed ring -> INVALID
    // ---------------------------------------------------------------
    test("Extra: an open (not closed) ring is INVALID", async () => {
        const openRing = {
            type: "Polygon",
            coordinates: [[
                [-9.501, 6.999],
                [-9.499, 6.999],
                [-9.499, 7.001],
                [-9.501, 7.001],
                // missing closing point back to [-9.501, 6.999]
            ]],
        };

        const result = await service.validate({
            geometry: openRing,
            skipOverlapCheck: true,
        });

        expect(result.isClosed).toBe(false);
        expect(result.status).toBe(GeometryStatus.INVALID);
        expect(result.blockSubmission).toBe(true);
    });
});
