import "reflect-metadata";

/**
 * Assessment-integrity regression tests.
 *
 * These lock in the fix for the P0 defect that made a FAILED (or entirely
 * fabricated) satellite assessment look like a completed, official verdict:
 *
 *   - WhispService returned a RANDOMISED mock when WHISP_API_KEY was unset,
 *     and `null` on every real failure.
 *   - RiskService then fell back to a name heuristic and still wrote a
 *     RiskAssessment row, stamping farm.riskLevel + farm.lastRiskAssessmentDate.
 *
 * The tests assert the opposite of that behaviour: when no verified Whisp
 * result exists, NOTHING is saved as an assessment, the farm's previously
 * verified verdict and timestamp are left untouched, and the failure is
 * recorded separately so it is visible.
 *
 * Hermetic: the DB layer, the geometry helper and the Whisp client are all
 * mocked, so this suite needs no database, network or API key.
 */

// ---------------------------------------------------------------------------
// Module mocks (factories are hoisted, so everything they need is defined
// inside them - no reliance on outer `const`s).
// ---------------------------------------------------------------------------
jest.mock("../../data-source", () => {
    const makeRepo = () => ({
        create: jest.fn((x: any) => x),
        save: jest.fn(async (x: any) => x),
        find: jest.fn(async () => []),
        findOne: jest.fn(async () => null),
        count: jest.fn(async () => 0),
        createQueryBuilder: jest.fn(),
    });
    const repositories: Record<string, any> = {};
    return {
        __repositories: repositories,
        AppDataSource: {
            getRepository: jest.fn((entity: any) => {
                const name = entity?.name || "unknown";
                if (!repositories[name]) repositories[name] = makeRepo();
                return repositories[name];
            }),
        },
    };
});

// Geometry gate passes unconditionally here; the gate itself is covered by
// GeometryValidationService.test.ts. We only care that analysis proceeds.
jest.mock("../FarmGeometryHelper", () => ({
    validateAndAnnotateFarm: jest.fn(async () => ({
        status: "Valid",
        needsReview: false,
        overlapsExistingFarm: false,
        errors: [],
        warnings: [],
        calculatedAreaHa: 4.9,
        coordinateCount: 5,
    })),
}));

// NotificationService would hit the DB + any mail transport; stub it out.
jest.mock("../NotificationService", () => ({
    NotificationService: { createForAdmins: jest.fn(async () => undefined) },
}));

import { RiskService } from "../RiskService";
import { WhispService, WhispUnavailableError } from "../WhispService";
import { AppDataSource } from "../../data-source";

const repos = (AppDataSource as any).getRepository as jest.Mock;

/** The repository mock TypeORM would hand back for a given entity class. */
const repoFor = (entity: any) => repos.mock.results
    .map((r, i) => ({ entity: repos.mock.calls[i][0], value: r.value }))
    .filter((x) => x.entity === entity)
    .pop()?.value ?? (AppDataSource as any).getRepository(entity);

/** A farm that already carries a PREVIOUS verified verdict, for preservation checks. */
const PREVIOUS_ASSESSED_AT = new Date("2026-05-01T09:00:00.000Z");
const makeFarm = () => {
    const farm: any = {
        id: "farm-1",
        name: "Kollie Family Plot", // deliberately does NOT contain "risk"
        cropType: "Cocoa",
        geometryStatus: "Valid",
        riskLevel: "Medium",
        lastRiskAssessmentDate: PREVIOUS_ASSESSED_AT,
        location: {
            type: "Polygon",
            coordinates: [[[-9.5, 7.0], [-9.499, 7.0], [-9.499, 7.001], [-9.5, 7.001], [-9.5, 7.0]]],
        },
        farmer: { firstName: "A", lastName: "B", identityStatus: "Verified" },
    };
    return farm;
};

/** Builds a RiskService whose Whisp client throws the given failure. */
const buildService = (failWith?: WhispUnavailableError) => {
    const service = new RiskService();
    (service as any).whispService = {
        analyzeFarm: failWith
            ? jest.fn().mockRejectedValue(failWith)
            : jest.fn(),
    };
    return service;
};

beforeEach(() => {
    jest.clearAllMocks();
});

describe("RiskService.analyzeFarm - failed assessment must never be saved as a result", () => {
    it("does not save an assessment or overwrite the farm when Whisp is NOT CONFIGURED", async () => {
        const farm = makeFarm();
        const service = buildService(
            new WhispUnavailableError("not_configured", "Whisp is not configured. No assessment has been recorded.")
        );

        const farmRepo = (service as any).farmRepo;
        const assessmentRepo = (service as any).assessmentRepo;
        farmRepo.findOne.mockResolvedValue(farm);

        // Attempt the analysis; it must REJECT rather than resolve.
        await expect(service.analyzeFarm(farm.id)).rejects.toBeInstanceOf(WhispUnavailableError);

        // 1. No assessment row written.
        expect(assessmentRepo.save).not.toHaveBeenCalled();
        expect(assessmentRepo.create).not.toHaveBeenCalled();

        // 2. The previous verified verdict and its timestamp survive untouched.
        expect(farm.riskLevel).toBe("Medium");
        expect(farm.lastRiskAssessmentDate).toBe(PREVIOUS_ASSESSED_AT);

        // 3. The failure is recorded separately so staff can see it.
        const attemptRepo = (service as any).constructor === undefined
            ? null
            : repoFor(require("../../entities/AssessmentAttempt").AssessmentAttempt);
        expect(attemptRepo.save).toHaveBeenCalledTimes(1);
        const savedAttempt = attemptRepo.save.mock.calls[0][0];
        expect(savedAttempt.outcome).toBe("failed");
        expect(savedAttempt.failureCode).toBe("not_configured");
        expect(savedAttempt.farmId).toBe(farm.id);
    });

    it("does not save an assessment when Whisp AUTH fails", async () => {
        const farm = makeFarm();
        const service = buildService(
            new WhispUnavailableError("auth_failed", "Whisp rejected our credentials. No assessment has been recorded.", {
                httpStatus: 502,
            })
        );
        (service as any).farmRepo.findOne.mockResolvedValue(farm);

        await expect(service.analyzeFarm(farm.id)).rejects.toMatchObject({ code: "auth_failed" });

        expect((service as any).assessmentRepo.save).not.toHaveBeenCalled();
        expect(farm.riskLevel).toBe("Medium");
        expect(farm.lastRiskAssessmentDate).toBe(PREVIOUS_ASSESSED_AT);

        const attemptRepo = repoFor(require("../../entities/AssessmentAttempt").AssessmentAttempt);
        expect(attemptRepo.save).toHaveBeenCalledTimes(1);
        expect(attemptRepo.save.mock.calls[0][0].failureCode).toBe("auth_failed");
        expect(attemptRepo.save.mock.calls[0][0].retryable).toBe(false);
    });

    it("does not save an assessment when Whisp TIMES OUT", async () => {
        const farm = makeFarm();
        const service = buildService(
            new WhispUnavailableError("timeout", "Whisp did not finish in time. No assessment has been recorded.", {
                httpStatus: 504,
                retryable: true,
            })
        );
        (service as any).farmRepo.findOne.mockResolvedValue(farm);

        await expect(service.analyzeFarm(farm.id)).rejects.toMatchObject({ code: "timeout" });

        expect((service as any).assessmentRepo.save).not.toHaveBeenCalled();
        expect(farm.lastRiskAssessmentDate).toBe(PREVIOUS_ASSESSED_AT);

        const attemptRepo = repoFor(require("../../entities/AssessmentAttempt").AssessmentAttempt);
        // A timeout is retryable - that flag must reach the stored record.
        expect(attemptRepo.save.mock.calls[0][0].retryable).toBe(true);
    });

    it("does not fall back to a name heuristic for a farm whose name contains 'risk'", async () => {
        // The old checkDeforestation() would have marked this farm HIGH purely
        // because of its name. With Whisp failing, NO verdict may be produced.
        const farm = makeFarm();
        farm.name = "RISK Demo Farm";
        const service = buildService(
            new WhispUnavailableError("service_unavailable", "Whisp unavailable. No assessment has been recorded.")
        );
        (service as any).farmRepo.findOne.mockResolvedValue(farm);

        await expect(service.analyzeFarm(farm.id)).rejects.toBeInstanceOf(WhispUnavailableError);

        expect((service as any).assessmentRepo.save).not.toHaveBeenCalled();
        // Crucially, it did NOT become High Risk.
        expect(farm.riskLevel).toBe("Medium");
    });
});

describe("RiskService.analyzeFarm - the verified success path still works and is marked", () => {
    it("saves a verified assessment stamped source=whisp_live and updates the farm", async () => {
        const farm = makeFarm();
        const service = buildService();
        (service as any).farmRepo.findOne.mockResolvedValue(farm);

        // Make the OTHER mitigating checks deterministic so this test isolates
        // the Whisp/provenance behaviour. Without a valid document on file,
        // checkLegality() correctly flags a risk and the farm would score
        // Medium for reasons unrelated to what this test is asserting.
        (service as any).documentRepo.find.mockResolvedValue([{ status: "Valid" }]);
        (service as any).forestRepo.createQueryBuilder.mockReturnValue({
            where: jest.fn().mockReturnThis(),
            getOne: jest.fn().mockResolvedValue(null),
        });

        (service as any).whispService.analyzeFarm.mockResolvedValue({
            provenance: "whisp_live",
            verified: true,
            resultId: "whisp-token-abc",
            areaHa: 4.9,
            unit: "ha",
            eufo2020Ha: 0,
            annualEvents: [],
            commodityOverlaps: [],
            indicators: {},
            riskPerennialCrop: "low",
            riskAnnualCrop: "unknown",
            riskTimber: "unknown",
        });

        const result = await service.analyzeFarm(farm.id);

        // Provenance reaches the persisted row, so a later audit can trust it.
        expect((service as any).assessmentRepo.save).toHaveBeenCalledTimes(1);
        const saved = (service as any).assessmentRepo.save.mock.calls[0][0];
        expect(saved.source).toBe("whisp_live");
        expect(saved.whispVerified).toBe(true);
        expect(saved.whispAnalysisId).toBe("whisp-token-abc");
        expect(result).toBeDefined();

        // The farm IS updated on a genuine success.
        expect(farm.lastRiskAssessmentDate).not.toBe(PREVIOUS_ASSESSED_AT);
        expect(farm.riskLevel).toBe("Low");

        // And no failure record is written.
        const attemptRepo = repoFor(require("../../entities/AssessmentAttempt").AssessmentAttempt);
        expect(attemptRepo.save).not.toHaveBeenCalled();
    });
});

describe("WhispService - no mock fallback exists", () => {
    it("throws not_configured (never a mock result) when WHISP_API_KEY is unset", async () => {
        const previous = process.env.WHISP_API_KEY;
        delete process.env.WHISP_API_KEY;
        try {
            const service = new WhispService(); // reads env at construction
            const geometry = { type: "Polygon", coordinates: [[[-9.5, 7.0], [-9.499, 7.0], [-9.49, 7.001], [-9.5, 7.0]]] };

            await expect(service.analyzeFarm("farm-x", geometry)).rejects.toBeInstanceOf(WhispUnavailableError);

            // Explicitly assert it is the typed config failure, not a random verdict.
            await expect(service.analyzeFarm("farm-x", geometry)).rejects.toMatchObject({
                code: "not_configured",
                retryable: false,
            });
        } finally {
            if (previous !== undefined) process.env.WHISP_API_KEY = previous;
        }
    });
});
