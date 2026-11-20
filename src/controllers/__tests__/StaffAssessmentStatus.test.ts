import "reflect-metadata";

/**
 * Staff-surface assessment status + additive reporting metric.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The public surfaces were fixed first (PublicAssessmentStatus.test.ts). The
 * STAFF surfaces were still returning raw `Farmer`/`Farm` entities, so
 * `GET /api/farmers` (list), `GET /api/farmers/me` and `GET /api/farmers/:id`
 * shipped each farm's `riskLevel` column untouched — and that column
 * DB-defaults to 'Low', so an unassessed farm looked like a Low verdict on
 * every staff screen (FarmerProfile, FarmsList, RiskAnalysis).
 *
 * These tests lock in two things:
 *
 *   1. The three staff farmer endpoints attach `assessmentStatus` to every
 *      nested farm, resolved in ONE batch query, using the SAME helper as the
 *      public surfaces — so staff and public can never disagree.
 *
 *   2. The compliance report gains an ADDITIVE `unverifiedAssessmentFarms`
 *      metric, while every already-published figure (numerator, denominator,
 *      complianceRate, assessmentCoverageRate) keeps its original value. That
 *      is the whole point: surface the exposure without rewriting history.
 *
 * Hermetic: repositories mock the data source. No database, network or key.
 */

interface MockRepos {
    farm: { findOne: jest.Mock; find: jest.Mock; createQueryBuilder: jest.Mock };
    farmer: { findOne: jest.Mock; find: jest.Mock; createQueryBuilder: jest.Mock };
    assessment: { findOne: jest.Mock; find: jest.Mock };
}

/**
 * A chainable TypeORM query-builder stand-in.
 *
 * `getCount()` serves successive values from a queue shared across EVERY
 * builder created during one request — because the controller calls
 * `this.farmQuery(filters).getCount()` once per metric, which builds a fresh
 * query builder each time. A per-builder cursor would hand `counts[0]` to all
 * four queries; a shared cursor maps them to the real call order.
 *
 * Every `andWhere()` SQL fragment is recorded so assertions can inspect the
 * clauses a query actually used.
 */
function makeQueryBuilder(state: { counts: number[]; cursor: number }) {
    const wheres: string[] = [];
    const builder: any = {
        __wheres: wheres,
        leftJoin: jest.fn(() => builder),
        innerJoin: jest.fn(() => builder),
        select: jest.fn(() => builder),
        addSelect: jest.fn(() => builder),
        groupBy: jest.fn(() => builder),
        orderBy: jest.fn(() => builder),
        addGroupBy: jest.fn(() => builder),
        limit: jest.fn(() => builder),
        offset: jest.fn(() => builder),
        andWhere: jest.fn((sql: string) => { wheres.push(sql); return builder; }),
        where: jest.fn((sql: string) => { wheres.push(sql); return builder; }),
        getCount: jest.fn(async () => state.counts[state.cursor++] ?? 0),
        getRawOne: jest.fn(async () => ({ sum: "0" })),
        getRawMany: jest.fn(async () => []),
        getMany: jest.fn(async () => []),
    };
    return builder;
}

// Hoisted factory: must be self-contained (cannot close over outer consts).
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

// Lazy imports so the data-source mock is installed first.
const FarmerController = () => require("../FarmerController").FarmerController;
const ReportsController = () => require("../ReportsController").ReportsController;

/** A farm row exactly as Postgres returns it, DB default still applied. */
const makeFarm = (over: Record<string, any> = {}) => ({
    id: "farm-1",
    name: "Farm One",
    geoId: "LACRA-00000001",
    cropType: "Cocoa",
    totalAreaHa: 2,
    riskLevel: "Low",             // <-- DB default; not a verdict
    lastRiskAssessmentDate: null, // <-- never assessed
    geometryStatus: "Valid",
    ...over,
});

const makeFarmer = (farms: any[]) => ({
    id: "farmer-1",
    farmerId: "LACRA-0001",
    firstName: "A",
    lastName: "B",
    farms,
});

/** A verified live Whisp assessment row. */
const VERIFIED_ROW = {
    farmId: "farm-1",
    overallRisk: "Medium",
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    source: "whisp_live",
    whispVerified: true,
    flaggedForReassessment: false,
    flagReason: null,
};

/** A legacy row: present, but provenance cannot be established. */
const LEGACY_ROW = {
    farmId: "farm-1",
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
    repos.assessment.find.mockResolvedValue([]);
    repos.assessment.findOne.mockResolvedValue(null);
    repos.farmer.findOne.mockResolvedValue(null);
    repos.farmer.find.mockResolvedValue([]);
    repos.farm.findOne.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// FarmerController.getAll — staff farmer list
// ---------------------------------------------------------------------------
describe("FarmerController.getAll — staff list carries per-farm status", () => {
    const listWith = async (farms: any[], rows: any[]) => {
        const Controller = FarmerController();
        repos.farmer.find.mockResolvedValue([makeFarmer(farms)]);
        repos.assessment.find.mockResolvedValue(rows);
        const controller = new Controller();
        const res = buildRes();
        await controller.getAll({ user: { role: "ADMIN" } } as any, res);
        return lastJson(res).data;
    };

    it("never_assessed: a default-Low farm is labelled, and its legacy fields are untouched", async () => {
        const data = await listWith([makeFarm()], []);
        const farm = data[0].farms[0];

        expect(farm.assessmentStatus).toBe("never_assessed");
        // Additive only: the legacy column still reads exactly what it did.
        expect(farm.riskLevel).toBe("Low");
        expect(farm.lastRiskAssessmentDate).toBeNull();
    });

    it("unverified_historical: a legacy result is reported as such, not as a Low verdict", async () => {
        const data = await listWith([makeFarm({ lastRiskAssessmentDate: new Date("2024-03-04") })], [LEGACY_ROW]);
        expect(data[0].farms[0].assessmentStatus).toBe("unverified_historical");
    });

    it("verified: a live Whisp result is reported as verified", async () => {
        const data = await listWith([makeFarm({ riskLevel: "Medium" })], [VERIFIED_ROW]);
        expect(data[0].farms[0].assessmentStatus).toBe("verified");
    });

    it("statuses are per-farm and do not bleed between farms in one list", async () => {
        const Controller = FarmerController();
        const verifiedFarm = makeFarm({ id: "farm-v", riskLevel: "High" });
        const neverFarm = makeFarm({ id: "farm-n" });
        repos.farmer.find.mockResolvedValue([makeFarmer([verifiedFarm, neverFarm])]);
        repos.assessment.find.mockResolvedValue([{ ...VERIFIED_ROW, farmId: "farm-v" }]);

        const res = buildRes();
        await new Controller().getAll({ user: { role: "ADMIN" } } as any, res);
        const [farmer] = lastJson(res).data;

        expect(farmer.farms.find((f: any) => f.id === "farm-v").assessmentStatus).toBe("verified");
        expect(farmer.farms.find((f: any) => f.id === "farm-n").assessmentStatus).toBe("never_assessed");
    });

    it("resolves every farm in ONE batch query (no N+1 per farm)", async () => {
        await listWith([makeFarm({ id: "a" }), makeFarm({ id: "b" }), makeFarm({ id: "c" })], []);
        expect(repos.assessment.find).toHaveBeenCalledTimes(1);
        expect(repos.assessment.findOne).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// FarmerController.getOne / getMe — single farmer
// ---------------------------------------------------------------------------
describe("FarmerController.getOne / getMe — single farmer carries per-farm status", () => {
    it("getOne labels a never-assessed farm without touching riskLevel", async () => {
        const Controller = FarmerController();
        repos.farmer.findOne.mockResolvedValue(makeFarmer([makeFarm()]));
        repos.assessment.find.mockResolvedValue([]);

        const res = buildRes();
        await new Controller().getOne({ params: { id: "farmer-1" } } as any, res);
        const farmer = lastJson(res).data;

        expect(farmer.farms[0].assessmentStatus).toBe("never_assessed");
        expect(farmer.farms[0].riskLevel).toBe("Low");
    });

    it("getOne reports a verified assessment as verified", async () => {
        const Controller = FarmerController();
        repos.farmer.findOne.mockResolvedValue(makeFarmer([makeFarm({ riskLevel: "Medium" })]));
        repos.assessment.find.mockResolvedValue([VERIFIED_ROW]);

        const res = buildRes();
        await new Controller().getOne({ params: { id: "farmer-1" } } as any, res);
        expect(lastJson(res).data.farms[0].assessmentStatus).toBe("verified");
    });

    it("getMe labels the signed-in farmer's farms the same way", async () => {
        const Controller = FarmerController();
        repos.farmer.findOne.mockResolvedValue(makeFarmer([makeFarm({ lastRiskAssessmentDate: new Date("2024-03-04") })]));
        repos.assessment.find.mockResolvedValue([LEGACY_ROW]);

        const res = buildRes();
        await new Controller().getMe({ user: { id: "user-1" } } as any, res);
        expect(lastJson(res).data.farms[0].assessmentStatus).toBe("unverified_historical");
    });

    it("a farmer with no farms still responds, with an empty farm list", async () => {
        const Controller = FarmerController();
        repos.farmer.findOne.mockResolvedValue(makeFarmer([]));
        repos.assessment.find.mockResolvedValue([]);

        const res = buildRes();
        await new Controller().getOne({ params: { id: "farmer-1" } } as any, res);
        expect(lastJson(res).data.farms).toEqual([]);
        // No farms means no ids to look up - the batch query is skipped entirely.
        expect(repos.assessment.find).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// ReportsController — additive exposure metric
// ---------------------------------------------------------------------------
describe("ReportsController.getComplianceCalculationDetails — additive, non-destructive metric", () => {
    /**
     * Drive the endpoint with a scripted count sequence. Query order in the
     * method is: totalFarms, compliantFarms, assessmentPendingFarms,
     * unverifiedAssessmentFarms.
     */
    const runWith = async (counts: number[]) => {
        const Controller = ReportsController();
        const builders: any[] = [];
        // One shared queue+cursor for the whole request: each farmQuery()
        // call builds a NEW query builder, and each one consumes the next
        // count, in the order the controller issues them.
        const state = { counts, cursor: 0 };
        repos.farm.createQueryBuilder.mockImplementation(() => {
            const b = makeQueryBuilder(state);
            builders.push(b);
            return b;
        });

        const res = buildRes();
        await new Controller().getComplianceCalculationDetails({ query: {} } as any, res);
        return { body: lastJson(res).data, builders };
    };

    it("returns unverifiedAssessmentFarms alongside the existing figures", async () => {
        // total=10, compliant=4, pending=3 -> assessed=7; unverified=2
        const { body } = await runWith([10, 4, 3, 2]);

        expect(body).toHaveProperty("unverifiedAssessmentFarms", 2);
        // Published figures keep their original values - nothing reclassified.
        expect(body.numerator).toBe(4);
        expect(body.denominator).toBe(10);
        expect(body.complianceRate).toBe(40);
        expect(body.assessmentPendingFarms).toBe(3);
        expect(body.assessedFarms).toBe(7);
        expect(body.assessmentCoverageRate).toBe(70);
        expect(body.nonCompliantFarms).toBe(6);
    });

    it("the new metric is reported, never subtracted from the compliance numerator", async () => {
        // A large exposure must NOT move complianceRate.
        const { body } = await runWith([10, 4, 3, 7]);

        expect(body.unverifiedAssessmentFarms).toBe(7);
        expect(body.numerator).toBe(4);          // unchanged
        expect(body.complianceRate).toBe(40);    // unchanged
        // Invariant: the exposure is a subset of assessed farms.
        expect(body.unverifiedAssessmentFarms).toBeLessThanOrEqual(body.assessedFarms);
    });

    it("the exposure query keys on the same assessed gate and the newest-row rule", async () => {
        const { builders } = await runWith([10, 4, 3, 2]);
        // The 4th query is the unverified metric.
        const sql = builders[3].__wheres.join("\n");

        // Same "assessed" gate as every other bucket...
        expect(sql).toMatch(/lastRiskAssessmentDate IS NOT NULL/);
        // ...narrowed by the SQL twin of deriveAssessmentStatus(): newest row only.
        expect(sql).toMatch(/risk_assessment/);
        expect(sql).toMatch(/ORDER BY ra\."createdAt" DESC/);
        expect(sql).toMatch(/LIMIT 1/);
        expect(sql).toMatch(/"whispVerified"/);
        expect(sql).toMatch(/"flaggedForReassessment"/);
        expect(sql).toMatch(/source = :uv_source/);
    });

    it("reports zero exposure when every assessed farm is verified", async () => {
        const { body } = await runWith([5, 5, 0, 0]);
        expect(body.unverifiedAssessmentFarms).toBe(0);
        expect(body.complianceRate).toBe(100);
    });
});
