import "reflect-metadata";

/**
 * Auto-enqueue wiring — a saved plot boundary must queue a WhISP assessment.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The delivery spec requires: "saving a valid new or changed plot boundary
 * automatically queues the WhISP assessment". Two different things have to be
 * true for that sentence to hold, and they are proved in two places:
 *
 *   (a) THE QUEUE actually creates a job for a valid boundary and dedupes an
 *       unchanged polygon - covered by AssessmentQueue.test.ts.
 *   (b) THE CALLERS actually invoke the queue once the geometry is persisted -
 *       covered HERE. Nothing in the queue's own tests would notice if the
 *       `enqueueAssessmentSafely(...)` line were deleted from FarmController,
 *       because those tests call the queue directly.
 *
 * So this suite asserts the wiring, not the queue's internals: after a boundary
 * is saved (new farm, or a corrected boundary on an existing farm) the enqueue
 * helper is called; when no boundary was submitted it is NOT called. That is a
 * non-tautological assertion - it fails if the enqueue line is removed, moved
 * before the save, or made conditional on the wrong thing.
 *
 * HOW IT IS HERMETIC
 * ------------------
 * The queue module is mocked, so no WhISP/RiskService dependency chain is
 * loaded. Peripheral collaborators (geometry validation, Cloudinary, GeoID,
 * field events, commodity/plot building) are stubbed because they are not what
 * this test is about. A tiny in-test repository double lets the handlers reach
 * the enqueue line without a database.
 */

const enqueueAssessmentSafely = jest.fn();

jest.mock("../AssessmentQueueService", () => ({
    enqueueAssessmentSafely: (...args: any[]) => enqueueAssessmentSafely(...args),
    assessmentQueue: {},
    AssessmentQueueService: jest.fn(),
}));

jest.mock("../FarmGeometryHelper", () => ({
    validateAndAnnotateFarm: jest.fn(async (farm: any) => {
        farm.geometryStatus = "Valid";
        farm.areaHa = 24.42;
        return { status: "Valid", isBlocking: false, warnings: [] };
    }),
    assertGeometryNotBlocking: jest.fn(),
    attemptBowtieRepair: jest.fn(),
}));

jest.mock("../CommodityService", () => ({
    buildPlotsForFarm: jest.fn(async () => ({ plots: [], warning: null })),
    resolveCommodity: jest.fn(),
    refreshFarmPlotsAndLegacyCropType: jest.fn(async () => ({ cropType: null })),
    computeAreaWarning: jest.fn(() => null),
}));

jest.mock("../FieldEventService", () => ({
    recordFarmCaptureFieldEvent: jest.fn(async () => undefined),
}));

jest.mock("../GeoIdService", () => ({
    // normaliseGeometry returns null so `mintGeoIdForFarm` short-circuits and
    // writes nothing: the GeoID path is irrelevant to the assertion here.
    GeoIdService: {
        normaliseGeometry: jest.fn(() => null),
        buildFarmGeoJsonFeature: jest.fn(() => null),
        buildFarmGeoJsonFeatureCentroidOnly: jest.fn(() => null),
        encodeGeoJsonQr: jest.fn(async () => "qr"),
    },
    getGeoIdService: jest.fn(() => ({ mintGeoId: jest.fn(async () => ({ geoid: "X", uri: "u" })) })),
}));

jest.mock("../../utils/cloudUpload", () => ({
    uploadFilesToCloudinary: jest.fn(async () => []),
    uploadFileToCloudinary: jest.fn(async (f: any) => `https://cdn.example/${f?.fieldname ?? "photo"}.jpg`),
}));

// ── Minimal repository double ───────────────────────────────────────────────
// Shallow `where` matching is enough: the handlers here query by a scalar id.
function makeTable(rows: any[] = []) {
    let counter = rows.length;
    return {
        rows,
        create: (partial: any) => ({ ...partial }),
        save: jest.fn(async (row: any) => {
            if (Array.isArray(row)) {
                for (const r of row) {
                    if (!r.id) {
                        counter += 1;
                        r.id = `row-${counter}`;
                    }
                    rows.push(r);
                }
                return row;
            }
            if (!row.id) {
                counter += 1;
                row.id = `row-${counter}`;
            }
            const existing = rows.find(r => r.id === row.id);
            if (existing) Object.assign(existing, row);
            else rows.push(row);
            return row;
        }),
        findOne: jest.fn(async (args: any = {}) => {
            const where = args?.where ?? {};
            const keys = Object.keys(where).filter(k => where[k] !== undefined);
            return (
                rows.find(r =>
                    keys.every(k => {
                        const want = where[k];
                        if (want && typeof want === "object" && "id" in want) return r[k]?.id === want.id;
                        return r[k] === want;
                    }),
                ) ?? null
            );
        }),
        find: jest.fn(async (args: any = {}) => {
            const where = args?.where ?? {};
            const keys = Object.keys(where);
            return rows.filter(r => keys.every(k => r[k] === where[k]));
        }),
        delete: jest.fn(async () => ({ affected: 0 })),
    };
}

const farmTable = makeTable();
const plotTable = makeTable();
const miscTable = makeTable();
const farmerTable = makeTable([{ id: "farmer-1", firstName: "Jusu", lastName: "Gondor" }]);

jest.mock("../../data-source", () => ({
    AppDataSource: {
        getRepository: jest.fn((entity: any) => {
            const name = typeof entity === "string" ? entity : entity?.name;
            switch (name) {
                case "Farm": return farmTable;
                case "Plot": return plotTable;
                case "Farmer": return farmerTable;
                default: return miscTable;
            }
        }),
    },
}));

import { FarmController } from "../../controllers/FarmController";
import { UserRole } from "../../entities/User";

const VALID_POLYGON = {
    type: "Polygon",
    coordinates: [[
        [-10.8000, 6.3000],
        [-10.7950, 6.3000],
        [-10.7950, 6.3040],
        [-10.8000, 6.3040],
        [-10.8000, 6.3000],
    ]],
};

/** Same parcel with one corner genuinely moved: a real survey correction. */
const CORRECTED_POLYGON = {
    type: "Polygon",
    coordinates: [[
        [-10.8000, 6.3000],
        [-10.7950, 6.3000],
        [-10.7950, 6.3045],
        [-10.8000, 6.3045],
        [-10.8000, 6.3000],
    ]],
};

function makeRes() {
    const res: any = {};
    res.statusCode = 200;
    res.body = undefined;
    res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
    res.json = jest.fn((b: any) => { res.body = b; return res; });
    return res;
}

function boundaryPoints() {
    return [1, 2, 3, 4].map(sequence => ({
        sequence,
        lat: 6.3 + sequence * 0.0001,
        lng: -10.8 + sequence * 0.0001,
    }));
}

function boundaryFiles() {
    return [1, 2, 3, 4].map(sequence => ({ fieldname: `boundaryPhoto_${sequence}`, originalname: `p${sequence}.jpg` }));
}

beforeEach(() => {
    enqueueAssessmentSafely.mockReset();
    enqueueAssessmentSafely.mockResolvedValue({ queued: 1, reused: 0, boundaryReview: 0 });
    farmTable.rows.length = 0;
    plotTable.rows.length = 0;
    miscTable.rows.length = 0;
});

// ════════════════════════════════════════════════════════════════════════════
// 1. A NEW farm with a valid boundary queues an assessment
// ════════════════════════════════════════════════════════════════════════════
describe("farm create — a valid boundary queues the assessment", () => {
    it("calls the queue once, after the farm exists, with the create reason", async () => {
        const controller = new FarmController();
        const req: any = {
            user: { id: "u-1", role: UserRole.ADMIN, name: "Field Admin" },
            body: { name: "Gola Test Farm", farmerId: "farmer-1", location: JSON.stringify(VALID_POLYGON) },
            files: undefined,
        };
        const res = makeRes();

        await controller.create(req, res);

        expect(res.statusCode).toBe(201);
        expect(enqueueAssessmentSafely).toHaveBeenCalledTimes(1);

        const [farmIdArg, reasonArg] = enqueueAssessmentSafely.mock.calls[0];
        // The farm must already be persisted when the queue is asked: a job row
        // pointing at an unsaved farm would be an orphan.
        expect(farmIdArg).toBe(farmTable.rows[0].id);
        expect(reasonArg).toBe("farm created");

        // The queue summary is surfaced to the client so staff can see the
        // assessment was accepted without waiting for the satellite call.
        expect(res.body.data.assessment).toEqual({ queued: 1, reused: 0, boundaryReview: 0 });
    });

    it("still saves the farm when the queue reports a problem", async () => {
        enqueueAssessmentSafely.mockResolvedValue({
            queued: 0, reused: 0, boundaryReview: 0,
            error: "Assessment could not be queued automatically.",
        });
        const controller = new FarmController();
        const req: any = {
            user: { id: "u-1", role: UserRole.ADMIN, name: "Field Admin" },
            body: { name: "Gola Test Farm", farmerId: "farmer-1", location: JSON.stringify(VALID_POLYGON) },
        };
        const res = makeRes();

        await controller.create(req, res);

        // Field data is irreplaceable; a queue hiccup must not lose the farm.
        expect(res.statusCode).toBe(201);
        expect(farmTable.rows).toHaveLength(1);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. A CORRECTED boundary on an existing farm queues a fresh assessment
// ════════════════════════════════════════════════════════════════════════════
describe("boundary evidence — a new or changed boundary queues the assessment", () => {
    beforeEach(() => {
        farmTable.rows.length = 0;
        farmTable.rows.push({ id: "farm-1", name: "Existing Farm", location: VALID_POLYGON });
    });

    it("queues when a NEW polygon is submitted", async () => {
        const controller = new FarmController();
        const req: any = {
            params: { id: "farm-1" },
            body: {
                points: JSON.stringify(boundaryPoints()),
                location: JSON.stringify(VALID_POLYGON),
            },
            files: boundaryFiles(),
        };
        const res = makeRes();

        await controller.addBoundaryEvidence(req, res);

        expect(res.statusCode).toBe(200);
        expect(enqueueAssessmentSafely).toHaveBeenCalledTimes(1);
        expect(enqueueAssessmentSafely).toHaveBeenCalledWith("farm-1", "boundary corrected");
    });

    it("queues again when the boundary is CHANGED", async () => {
        const controller = new FarmController();

        // First save: the original polygon.
        await controller.addBoundaryEvidence(
            {
                params: { id: "farm-1" },
                body: { points: JSON.stringify(boundaryPoints()), location: JSON.stringify(VALID_POLYGON) },
                files: boundaryFiles(),
            } as any,
            makeRes(),
        );

        // Second save: a genuinely corrected polygon.
        await controller.addBoundaryEvidence(
            {
                params: { id: "farm-1" },
                body: { points: JSON.stringify(boundaryPoints()), location: JSON.stringify(CORRECTED_POLYGON) },
                files: boundaryFiles(),
            } as any,
            makeRes(),
        );

        // Both submissions reach the queue. De-duplication is the queue's job:
        // it hashes (plot, polygon) and reuses the open job for an unchanged
        // boundary while minting a new one for a correction.
        expect(enqueueAssessmentSafely).toHaveBeenCalledTimes(2);
    });

    it("does NOT queue when only photos/points are added and the boundary is untouched", async () => {
        const controller = new FarmController();
        const req: any = {
            params: { id: "farm-1" },
            body: { points: JSON.stringify(boundaryPoints()) }, // no `location`
            files: boundaryFiles(),
        };
        const res = makeRes();

        await controller.addBoundaryEvidence(req, res);

        expect(res.statusCode).toBe(200);
        // Re-photographing an unchanged parcel is not a geometry change.
        expect(enqueueAssessmentSafely).not.toHaveBeenCalled();
    });
});
