import "reflect-metadata";

/**
 * Public-surface assessment status tests.
 *
 * THE DEFECT THESE LOCK IN
 * ------------------------
 * `Farm.riskLevel` is a Postgres column with `DEFAULT 'Low'`. A farm that has
 * NEVER been assessed therefore still reads `riskLevel = 'Low'` on every row,
 * and every public surface returned that column verbatim:
 *
 *   - GET /api/public/farm-scan/:farmId            (QR scan, WHIMO)
 *   - GET /api/public/farm-scan/geoid/:geoid       (QR scan by GeoID)
 *   - GET /api/public/farm-scan/:farmId/whimo-payload
 *   - GET /api/public/farmers/:id                  (public profile, geo shape)
 *
 * Consequence: scanning the QR code of an unassessed farm presented a green
 * "Low" — a compliance rating that no assessment ever produced. A legacy mock
 * result was presented the same way.
 *
 * THE RULE NOW
 * ------------
 * Each public surface reports `assessmentStatus`:
 *   verified | unverified_historical | never_assessed
 * and exposes a risk level ONLY when the status is `verified`. In every other
 * state the level is `null`, regardless of what the column contains.
 *
 * Hermetic: repositories are mocked, so this suite needs no database, network
 * or API key. WhimoService is deliberately NOT mocked, so the "the WHIMO
 * transaction body carries no risk field" assertion runs against the real
 * buildTransactionPayload().
 */

interface MockRepos {
    farm: { findOne: jest.Mock; find: jest.Mock };
    farmer: { findOne: jest.Mock; find: jest.Mock };
    assessment: { findOne: jest.Mock; find: jest.Mock };
}

// The factory is hoisted above the imports, so it must be self-contained: it
// builds its own jest.fn()s and hands them back via the mocked module. The
// test body then reads them off `repos` — no closure over outer consts.
jest.mock("../../data-source", () => {
    const make = () => ({
        findOne: jest.fn(async () => null),
        find: jest.fn(async () => []),
        create: jest.fn((x: any) => x),
        save: jest.fn(async (x: any) => x),
        count: jest.fn(async () => 0),
        createQueryBuilder: jest.fn(),
    });
    const repos = { farm: make(), farmer: make(), assessment: make(), other: make() };
    return {
        __repos: repos,
        AppDataSource: {
            getRepository: jest.fn((entity: any) => {
                switch (entity?.name) {
                    case "Farm": return repos.farm;
                    case "Farmer": return repos.farmer;
                    case "RiskAssessment": return repos.assessment;
                    default: return repos.other;
                }
            }),
        },
    };
});

const repos: MockRepos = (require("../../data-source") as any).__repos;

// Import lazily INSIDE the tests so the data-source mock is fully installed.
type Controllers = {
    FarmScanController: any;
    FarmerController: any;
    WhimoService: any;
};
function loadControllers(): Controllers {
    return {
        FarmScanController: require("../FarmScanController").FarmScanController,
        FarmerController: require("../FarmerController").FarmerController,
        WhimoService: require("../../services/WhimoService"),
    };
}

const GEO_POLYGON = {
    type: "Polygon",
    coordinates: [[[-10.81, 6.29], [-10.79, 6.29], [-10.79, 6.31], [-10.81, 6.31], [-10.81, 6.29]]],
};

/** A farm exactly as Postgres returns it with the DEFAULT still applied. */
const makeFarm = (over: Record<string, any> = {}) => ({
    id: "farm-b",
    name: "Farm B",
    geoId: "LACRA-0000000B",
    geoIdUri: null,
    cropType: "Cocoa",
    totalAreaHa: 1.2,
    location: GEO_POLYGON,
    riskLevel: "Low",              // <-- the DB default: the whole point
    lastRiskAssessmentDate: null,  // <-- never assessed
    farmRegistrationStatus: "Registered",
    farmer: { id: "f1", farmerId: "LACRA-0001", firstName: "A", lastName: "B" },
    ...over,
});

/** A verified live Whisp assessment row. */
const VERIFIED_ROW = {
    farmId: "farm-b",
    overallRisk: "Medium",
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    source: "whisp_live",
    whispVerified: true,
    flaggedForReassessment: false,
    flagReason: null,
};

/** A legacy row: it exists, but its provenance cannot be established. */
const LEGACY_ROW = {
    farmId: "farm-b",
    overallRisk: "Low",
    createdAt: new Date("2024-03-04T10:00:00.000Z"),
    source: null,
    whispVerified: false,
    flaggedForReassessment: true,
    flagReason: "Pre-provenance record: source could not be verified.",
};

function buildRes() {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
}
const lastJson = (res: any) => res.json.mock.calls[res.json.mock.calls.length - 1][0];

beforeEach(() => {
    jest.clearAllMocks();
    repos.assessment.findOne.mockResolvedValue(null);
    repos.assessment.find.mockResolvedValue([]);
    repos.farm.findOne.mockResolvedValue(null);
    repos.farmer.findOne.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// FarmScanController — QR scan (geo view)
// ---------------------------------------------------------------------------
describe("FarmScanController.scan — QR / WHIMO geo payload", () => {
    const scanWith = async (farm: any, latestRow: any) => {
        const { FarmScanController } = loadControllers();
        repos.farm.findOne.mockResolvedValue(farm);
        repos.assessment.findOne.mockResolvedValue(latestRow);
        const controller = new FarmScanController();
        const res = buildRes();
        await controller.scan({ params: { farmId: farm.id }, query: {} } as any, res);
        return lastJson(res).data;
    };

    it("never_assessed: an unassessed farm whose column defaults to Low exposes NO level", async () => {
        const data = await scanWith(makeFarm(), null);

        expect(data.assessmentStatus).toBe("never_assessed");
        expect(data.riskLevel).toBeNull();
        // Including the GeoJSON Feature WHIMO stores as location_file.
        expect(data.geojson.properties.riskLevel).toBeNull();
        expect(data.geojson.properties.assessmentStatus).toBe("never_assessed");
        expect(data.lastRiskAssessmentDate).toBeNull();
    });

    it("unverified_historical: a legacy row still exposes NO level", async () => {
        const data = await scanWith(
            makeFarm({ lastRiskAssessmentDate: new Date("2024-03-04T10:00:00.000Z") }),
            LEGACY_ROW,
        );

        expect(data.assessmentStatus).toBe("unverified_historical");
        expect(data.riskLevel).toBeNull();
        expect(data.geojson.properties.riskLevel).toBeNull();
        expect(data.riskAssessmentNote).toMatch(/could not be verified|provenance/i);
    });

    it("verified: the verified level IS exposed, with provenance and timestamp", async () => {
        const data = await scanWith(
            makeFarm({ riskLevel: "Medium", lastRiskAssessmentDate: new Date("2026-09-01T10:00:00.000Z") }),
            VERIFIED_ROW,
        );

        expect(data.assessmentStatus).toBe("verified");
        expect(data.riskLevel).toBe("Medium");
        expect(data.geojson.properties.riskLevel).toBe("Medium");
        expect(data.riskAssessmentSource).toBe("whisp_live");
        expect(data.riskAssessedAt).toBe("2026-09-01T10:00:00.000Z");
    });

    it("queries the assessment repository ONCE per scan, not once per field", async () => {
        await scanWith(makeFarm(), VERIFIED_ROW);
        expect(repos.assessment.findOne).toHaveBeenCalledTimes(1);
    });

    it("the same rules reach a GeoID lookup (scanByGeoId delegates to scan)", async () => {
        const { FarmScanController } = loadControllers();
        repos.farm.findOne
            .mockResolvedValueOnce(makeFarm())   // lookup by geoId
            .mockResolvedValueOnce(makeFarm());  // scan()'s own fetch
        repos.assessment.findOne.mockResolvedValue(null);

        const controller = new FarmScanController();
        const res = buildRes();
        await controller.scanByGeoId({ params: { geoid: "LACRA-0000000B" }, query: {} } as any, res);

        const data = lastJson(res).data;
        expect(data.assessmentStatus).toBe("never_assessed");
        expect(data.riskLevel).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// FarmScanController — WHIMO transaction pre-fill
// ---------------------------------------------------------------------------
describe("FarmScanController.whimoPayload — LACRA-side compliance snapshot", () => {
    const payloadFor = async (farm: any, latestRow: any) => {
        const { FarmScanController } = loadControllers();
        repos.farm.findOne.mockResolvedValue(farm);
        repos.assessment.findOne.mockResolvedValue(latestRow);
        const controller = new FarmScanController();
        const res = buildRes();
        await controller.whimoPayload({ params: { farmId: farm.id } } as any, res);
        return lastJson(res).data;
    };

    it("reports risk_level=null for an unassessed farm (default Low never leaks)", async () => {
        const data = await payloadFor(makeFarm(), null);
        expect(data.assessment_status).toBe("never_assessed");
        expect(data.risk_level).toBeNull();
    });

    it("reports risk_level=null for an unverified historical result", async () => {
        const data = await payloadFor(makeFarm(), LEGACY_ROW);
        expect(data.assessment_status).toBe("unverified_historical");
        expect(data.risk_level).toBeNull();
    });

    it("reports the verified level when a live assessment exists", async () => {
        const data = await payloadFor(makeFarm({ riskLevel: "Medium" }), VERIFIED_ROW);
        expect(data.assessment_status).toBe("verified");
        expect(data.risk_level).toBe("Medium");
    });

    it("the REAL WHIMO transaction body carries no risk field at all", async () => {
        // Runs against the real WhimoService.buildTransactionPayload, not a stub,
        // so this pins the contract: WHIMO parses only lat/lng/location/
        // location_file. A risk field can therefore never be injected into what
        // is POSTed to WHIMO.
        const data = await payloadFor(makeFarm({ riskLevel: "Medium" }), VERIFIED_ROW);
        const body = data.transaction_payload;
        expect(body).toBeTruthy();
        expect(JSON.stringify(body)).not.toMatch(/risk/i);
        expect(body).toHaveProperty("farm_latitude");
        expect(body).toHaveProperty("location_file");
    });

    it("computes the assessment status once per request", async () => {
        await payloadFor(makeFarm(), VERIFIED_ROW);
        expect(repos.assessment.findOne).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// FarmerController.getPublicFarmer — public profile
// ---------------------------------------------------------------------------
describe("FarmerController.getPublicFarmer — public profile payload", () => {
    const profileFor = async (farm: any, latestRows: any[]) => {
        const { FarmerController } = loadControllers();
        repos.farmer.findOne.mockResolvedValue({
            id: "farmer-1",
            farmerId: "LACRA-0001",
            farms: [farm],
        });
        repos.assessment.find.mockResolvedValue(latestRows);
        const controller = new FarmerController();
        const res = buildRes();
        // No req.user => anonymous / geo-only shape.
        await controller.getPublicFarmer({ params: { id: "farmer-1" } } as any, res);
        return lastJson(res).data;
    };

    it("never_assessed: anonymous profile exposes no level for a default-Low farm", async () => {
        const data = await profileFor(makeFarm(), []);
        const farm = data.farms[0];

        expect(data._access).toBe("geo");
        expect(farm.assessmentStatus).toBe("never_assessed");
        expect(farm.riskLevel).toBeNull();
        expect(farm.riskLevelVerified).toBeNull();
        expect(farm.geojson.properties.riskLevel).toBeNull();
    });

    it("unverified_historical: anonymous profile exposes no level", async () => {
        const data = await profileFor(
            makeFarm({ lastRiskAssessmentDate: new Date("2024-03-04T10:00:00.000Z") }),
            [LEGACY_ROW],
        );
        const farm = data.farms[0];

        expect(farm.assessmentStatus).toBe("unverified_historical");
        expect(farm.riskLevel).toBeNull();
        expect(farm.riskLevelVerified).toBeNull();
    });

    it("verified: the verified level is exposed", async () => {
        const data = await profileFor(makeFarm({ riskLevel: "High" }), [VERIFIED_ROW]);
        const farm = data.farms[0];

        expect(farm.assessmentStatus).toBe("verified");
        expect(farm.riskLevelVerified).toBe("Medium");
        expect(farm.riskAssessedAt).toBe("2026-09-01T10:00:00.000Z");
    });

    it("resolves all farms' assessments in ONE query (no N+1)", async () => {
        await profileFor(makeFarm(), []);
        expect(repos.assessment.find).toHaveBeenCalledTimes(1);
        // The public profile uses the batch query, never the per-farm one.
        expect(repos.assessment.findOne).not.toHaveBeenCalled();
    });
});
