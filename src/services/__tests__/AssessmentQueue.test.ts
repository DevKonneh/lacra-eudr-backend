import "reflect-metadata";
import { createTables, RepoBundle } from "./support/inMemoryRepos";

/**
 * Automatic per-plot WhISP assessment queue — behavioural tests.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The queue carries four promises that are easy to state and easy to break:
 *
 *   1. A retried sync of an UNCHANGED polygon creates NO duplicate job.
 *   2. A CORRECTED polygon creates a new job, and the older run can never
 *      become the plot's current rating.
 *   3. INELIGIBLE geometry (a GPS point, the legacy generated square, a
 *      missing boundary, a self-intersecting ring) is never sent to WhISP —
 *      it is parked for boundary review with a reason staff can act on.
 *   4. A FAILED check never destroys a previously verified result or its
 *      timestamp, and temporary failures are retried with growing backoff.
 *
 * These are exactly the requirements the field-sync acceptance test checks by
 * hand. Locking them into automated tests means a future refactor cannot
 * quietly reintroduce the duplicates or the false "current" verdicts.
 *
 * HOW IT IS HERMETIC
 * ------------------
 *   - `data-source` is mocked onto an in-memory table engine that honours the
 *     UNIQUE index on `dedupeKey` (see support/inMemoryRepos.ts), so promise 1
 *     is proved by the same mechanism production relies on.
 *   - `RiskService` is mocked so the worker's success/failure handling can be
 *     driven directly, but the QUEUE's own logic (eligibility, dedupe,
 *     supersede, backoff, retry) is the real implementation under test.
 *   - No database, network, or API key is touched.
 */

let tables: RepoBundle;

// The repo mapping is read lazily at each call (via a stable facade), so that a
// fresh table bundle in beforeEach is picked up even by service singletons that
// were constructed during module import.
jest.mock("../../data-source", () => {
    const { makeGetRepository } = require("./support/inMemoryRepos");
    const getRepository = makeGetRepository();
    return { AppDataSource: { getRepository: jest.fn(getRepository) } };
});

// The worker calls `new RiskService().assessPlot(...)`. Mocking the class lets
// each test dictate the outcome while the queue's handling stays real.
jest.mock("../RiskService", () => {
    const assessPlot = jest.fn();
    return {
        RiskService: jest.fn().mockImplementation(() => ({ assessPlot })),
        __assessPlot: assessPlot,
    };
});

const { WhispUnavailableError } = require("../WhispService");
const { geometryHashOf } = require("../GeometryVersioning");
const { AssessmentJobStatus } = require("../AssessmentQueueService");

/** Loaded after `global.__queueTables` exists, so eager repo construction works. */
function loadQueue() {
    const mod = require("../AssessmentQueueService");
    return {
        AssessmentQueueService: mod.AssessmentQueueService,
        enqueueAssessmentSafely: mod.enqueueAssessmentSafely,
        assessmentQueue: mod.assessmentQueue,
        service: new mod.AssessmentQueueService(),
    };
}

function mockAssessPlot(): jest.Mock {
    return require("../RiskService").__assessPlot;
}

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// A genuine surveyed-looking parcel near Gbarnga. Deliberately NOT axis-aligned
// with a 0.002° span, because that exact signature is what marks the legacy
// generated square, and using it here would make the "eligible" tests
// accidentally ineligible.
const SURVEYED_POLYGON = {
    type: "Polygon",
    coordinates: [[
        [-10.8000, 6.3000],
        [-10.7950, 6.3000],
        [-10.7950, 6.3040],
        [-10.8000, 6.3040],
        [-10.8000, 6.3000],
    ]],
};

/** Same parcel, one corner genuinely moved: a real survey correction. */
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

/** Same parcel, traversed counter-clockwise: NOT a correction. */
const SURVEYED_POLYGON_REVERSED = {
    type: "Polygon",
    coordinates: [[...SURVEYED_POLYGON.coordinates[0]].reverse()],
};

/** The exact signature the retired FarmController path used to fabricate. */
const LEGACY_GENERATED_SQUARE = {
    type: "Polygon",
    coordinates: [[
        [-10.801, 6.299],
        [-10.799, 6.299],
        [-10.799, 6.301],
        [-10.801, 6.301],
        [-10.801, 6.299],
    ]],
};

const RECORDED_POINT = { type: "Point", coordinates: [-10.80, 6.30] };

/** Self-intersecting "bowtie": geometrically invalid. */
const BOWTIE_POLYGON = {
    type: "Polygon",
    coordinates: [[
        [-10.8000, 6.3000],
        [-10.7950, 6.3040],
        [-10.7950, 6.3000],
        [-10.8000, 6.3040],
        [-10.8000, 6.3000],
    ]],
};

function makeFarm(over: Record<string, any> = {}) {
    return {
        id: "farm-1",
        name: "Farm One",
        location: SURVEYED_POLYGON,
        geometrySource: "surveyed",
        geometryStatus: "Valid",
        totalAreaHa: null,
        riskLevel: "Low",
        lastRiskAssessmentDate: null,
        ...over,
    };
}

function makePlot(over: Record<string, any> = {}) {
    return {
        id: "plot-1",
        name: "Plot A",
        farmId: "farm-1",
        boundary: SURVEYED_POLYGON,
        areaHa: null,
        isDefault: false,
        isActive: true,
        geometryHash: null,
        geometryVersion: 0,
        ...over,
    };
}

/** Seeds a farm + plot into the in-memory tables and returns them. */
function seed(farmOver: Record<string, any> = {}, plotOver: Record<string, any> = {}) {
    const farm = makeFarm(farmOver);
    const plot = makePlot({ ...plotOver, farmId: farm.id, farm });
    tables.farm.rows.push(farm);
    tables.plot.rows.push(plot);
    return { farm, plot };
}

beforeEach(() => {
    tables = createTables();
    (global as any).__queueTables = tables;
    mockAssessPlot().mockReset();
});

afterEach(() => {
    jest.resetModules();
});

// ════════════════════════════════════════════════════════════════════════════
// 1. ELIGIBILITY — nothing ineligible is ever sent to WhISP
// ════════════════════════════════════════════════════════════════════════════
describe("eligibility — ineligible geometry is parked, never sent to WhISP", () => {
    it("parks a GPS point for boundary review with point-specific wording", async () => {
        const { service } = loadQueue();
        const { plot } = seed({}, { boundary: RECORDED_POINT });
        const farm = tables.farm.rows[0];

        const r = await service.enqueueForPlotEntity(plot as any, farm as any);

        expect(r.eligibility.eligible).toBe(false);
        expect(r.job!.status).toBe(AssessmentJobStatus.BOUNDARY_REVIEW);
        expect(r.job!.boundaryReviewReason).toMatch(/point/i);
        // A point has no polygon, so it must be keyed on the plot alone.
        expect(r.job!.dedupeKey).toBe(`${plot.id}:no-polygon`);
        expect(r.job!.geometryHash).toBeNull();
    });

    it("parks the legacy generated square, naming it as generated rather than invalid", async () => {
        const { service } = loadQueue();
        const { plot } = seed({}, { boundary: LEGACY_GENERATED_SQUARE });
        const farm = tables.farm.rows[0];

        const r = await service.enqueueForPlotEntity(plot as any, farm as any);

        expect(r.eligibility.eligible).toBe(false);
        expect(r.job!.status).toBe(AssessmentJobStatus.BOUNDARY_REVIEW);
        // Staff must not be told to "fix an invalid polygon" they never drew.
        expect(r.job!.boundaryReviewReason).toMatch(/generated square/i);
    });

    it("parks a non-default plot with no boundary instead of borrowing the farm's polygon", async () => {
        // This is the subtle one: falling back to the farm boundary here would
        // assess the WRONG parcel and attribute the verdict to this subplot.
        const { service } = loadQueue();
        const { plot } = seed({}, { boundary: null, isDefault: false });
        const farm = tables.farm.rows[0];

        const r = await service.enqueueForPlotEntity(plot as any, farm as any);

        expect(r.eligibility.eligible).toBe(false);
        expect(r.job!.status).toBe(AssessmentJobStatus.BOUNDARY_REVIEW);
        expect(r.job!.boundaryReviewReason).toMatch(/No boundary has been recorded/i);
    });

    it("DOES fall back to the farm polygon for the default whole-farm plot", async () => {
        const { service } = loadQueue();
        const { plot } = seed({}, { boundary: null, isDefault: true });
        const farm = tables.farm.rows[0];

        const r = await service.enqueueForPlotEntity(plot as any, farm as any);

        expect(r.eligibility.eligible).toBe(true);
        expect(r.eligibility).toMatchObject({ geometryOrigin: "farm" });
        expect(r.job!.status).toBe(AssessmentJobStatus.QUEUED);
        expect(r.job!.geometryHash).toBe(geometryHashOf(SURVEYED_POLYGON));
    });

    it("parks a self-intersecting polygon and reports the validation reason", async () => {
        const { service } = loadQueue();
        const { plot } = seed({}, { boundary: BOWTIE_POLYGON });
        const farm = tables.farm.rows[0];

        const r = await service.enqueueForPlotEntity(plot as any, farm as any);

        expect(r.eligibility.eligible).toBe(false);
        expect(r.job!.status).toBe(AssessmentJobStatus.BOUNDARY_REVIEW);
        expect(r.job!.boundaryReviewReason).toBeTruthy();
        // The reason must explain the failure, not just say "failed".
        expect(r.job!.boundaryReviewReason!.length).toBeGreaterThan(20);
    });

    it("creates no queued job at all for an ineligible plot", async () => {
        const { service } = loadQueue();
        const { plot } = seed({}, { boundary: RECORDED_POINT });
        await service.enqueueForPlotEntity(plot as any, tables.farm.rows[0] as any);

        expect(tables.job.rows.filter((j) => j.status === AssessmentJobStatus.QUEUED))
            .toHaveLength(0);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. DEDUPLICATION — one job per (plot, polygon)
// ════════════════════════════════════════════════════════════════════════════
describe("deduplication — a retried sync must not create a second job", () => {
    it("reuses the existing job when the identical polygon is synced twice", async () => {
        const { service } = loadQueue();
        const { plot } = seed();
        const farm = tables.farm.rows[0];

        const first = await service.enqueueForPlotEntity(plot as any, farm as any);
        const second = await service.enqueueForPlotEntity(plot as any, farm as any);

        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.job!.id).toBe(first.job!.id);
        expect(tables.job.rows).toHaveLength(1);
    });

    it("reuses the job when the same parcel arrives with reversed winding", async () => {
        // A device that traversed the boundary the other way is re-sending the
        // SAME parcel. Without winding normalisation this created a duplicate.
        const { service } = loadQueue();
        const { plot } = seed();
        const farm = tables.farm.rows[0];

        const first = await service.enqueueForPlotEntity(plot as any, farm as any);
        plot.boundary = SURVEYED_POLYGON_REVERSED;
        const second = await service.enqueueForPlotEntity(plot as any, farm as any);

        expect(second.created).toBe(false);
        expect(second.job!.id).toBe(first.job!.id);
        expect(tables.job.rows).toHaveLength(1);
    });

    it("survives an INSERT race: the UNIQUE key, not a pre-check, is the guarantee", async () => {
        const { service } = loadQueue();
        const { plot } = seed();
        const farm = tables.farm.rows[0];

        await service.enqueueForPlotEntity(plot as any, farm as any);
        expect(tables.job.rows).toHaveLength(1);

        // Simulate a concurrent sync that slipped past its own dedupe read and
        // is about to INSERT the same key.
        tables.job.findOne.mockImplementationOnce(async () => null);

        const raced = await service.enqueueForPlotEntity(plot as any, farm as any);

        expect(raced.created).toBe(false);
        expect(tables.job.rows).toHaveLength(1);
        expect(raced.job!.dedupeKey).toBe(`${plot.id}:${geometryHashOf(SURVEYED_POLYGON)}`);
    });

    it("keys jobs per plot, so one submission with several plots yields one job each", async () => {
        const { service } = loadQueue();
        const farm = makeFarm();
        tables.farm.rows.push(farm);
        const plotA = makePlot({ id: "plot-a", name: "Plot A", farmId: farm.id });
        const plotB = makePlot({
            id: "plot-b",
            name: "Plot B",
            farmId: farm.id,
            boundary: CORRECTED_POLYGON,
        });
        tables.plot.rows.push(plotA, plotB);

        const result = await service.enqueueForFarm(farm.id);

        expect(result.created).toBe(2);
        expect(tables.job.rows).toHaveLength(2);
        const byPlot = new Map(tables.job.rows.map((j) => [j.plotId, j]));
        expect(byPlot.get("plot-a")!.geometryHash).toBe(geometryHashOf(SURVEYED_POLYGON));
        expect(byPlot.get("plot-b")!.geometryHash).toBe(geometryHashOf(CORRECTED_POLYGON));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. CORRECTED BOUNDARY — new job, old result cannot win
// ════════════════════════════════════════════════════════════════════════════
describe("corrected boundary — a new job is queued and the old verdict is retired", () => {
    it("queues a second job and supersedes the still-open one", async () => {
        const { service } = loadQueue();
        const { plot } = seed();
        const farm = tables.farm.rows[0];

        const first = await service.enqueueForPlotEntity(plot as any, farm as any);
        expect(first.job!.status).toBe(AssessmentJobStatus.QUEUED);

        plot.boundary = CORRECTED_POLYGON;
        const second = await service.enqueueForPlotEntity(plot as any, farm as any);

        expect(second.created).toBe(true);
        expect(tables.job.rows).toHaveLength(2);

        const stale = tables.job.rows.find((j) => j.id === first.job!.id)!;
        expect(stale.status).toBe(AssessmentJobStatus.FAILED);
        expect(stale.retryable).toBe(false);
        expect(stale.failureCode).toBe("superseded_by_geometry_change");
        expect(stale.lastError).toMatch(/older polygon/i);

        // The row is KEPT — deleting it would erase the audit trail.
        expect(tables.job.rows.some((j) => j.id === first.job!.id)).toBe(true);
    });

    it("bumps the plot's geometry version only on a real edit", async () => {
        const { service } = loadQueue();
        const { plot } = seed();
        const farm = tables.farm.rows[0];

        await service.enqueueForPlotEntity(plot as any, farm as any);
        const v1 = plot.geometryVersion;

        await service.enqueueForPlotEntity(plot as any, farm as any); // retry
        expect(plot.geometryVersion).toBe(v1);

        plot.boundary = CORRECTED_POLYGON;
        await service.enqueueForPlotEntity(plot as any, farm as any);
        expect(plot.geometryVersion).toBe(v1 + 1);
    });

    it("flags a COMPLETED verdict once the boundary is corrected (no open job case)", async () => {
        // The regression this guards: flagging used to happen only inside the
        // loop over still-open jobs, so correcting the boundary AFTER a check
        // completed left the stale verdict as the plot's current rating.
        const { service } = loadQueue();
        const { plot } = seed();
        const farm = tables.farm.rows[0];

        const oldHash = geometryHashOf(SURVEYED_POLYGON);
        plot.geometryHash = oldHash;
        plot.geometryVersion = 1;

        // A finished job and its verdict, both describing the OLD polygon.
        tables.job.rows.push({
            id: "job-done",
            plotId: plot.id,
            farmId: farm.id,
            geometryHash: oldHash,
            geometryVersion: 1,
            dedupeKey: `${plot.id}:${oldHash}`,
            status: AssessmentJobStatus.COMPLETED,
            attempts: 1,
            supersededByGeometryChange: false,
            createdAt: new Date(1_700_000_000_000),
        });
        tables.assessment.rows.push({
            id: "ra-old",
            farmId: farm.id,
            plotId: plot.id,
            geometryHash: oldHash,
            geometryVersion: 1,
            overallRisk: "High",
            source: "whisp_live",
            whispVerified: true,
            supersededByGeometryChange: false,
            createdAt: new Date(1_700_000_000_000),
        });

        plot.boundary = CORRECTED_POLYGON;
        await service.enqueueForPlotEntity(plot as any, farm as any);

        const verdict = tables.assessment.rows.find((r) => r.id === "ra-old")!;
        expect(verdict.supersededByGeometryChange).toBe(true);
        // Retained as history, not deleted.
        expect(tables.assessment.rows.some((r) => r.id === "ra-old")).toBe(true);
        // And a fresh job exists for the corrected polygon.
        expect(tables.job.rows.some((j) => j.plotId === plot.id
            && j.status === AssessmentJobStatus.QUEUED
            && j.geometryHash === geometryHashOf(CORRECTED_POLYGON))).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. WORKER — success, backoff, permanent failure, prior-result preservation
// ════════════════════════════════════════════════════════════════════════════
describe("worker — result handling", () => {
    it("marks the job completed and records the assessment id on success", async () => {
        const { service } = loadQueue();
        const { plot } = seed();
        const farm = tables.farm.rows[0];
        await service.enqueueForPlotEntity(plot as any, farm as any);

        mockAssessPlot().mockResolvedValue({ id: "ra-new" });
        const { processed } = await service.tick();

        expect(processed).toBe(1);
        const job = tables.job.rows[0];
        expect(job.status).toBe(AssessmentJobStatus.COMPLETED);
        expect(job.assessmentId).toBe("ra-new");
        expect(job.failureCode).toBeNull();
        expect(job.retryable).toBe(false);
        expect(job.finishedAt).toBeInstanceOf(Date);
    });

    it("schedules a retry with 30s backoff on a temporary failure", async () => {
        const { service } = loadQueue();
        const { plot } = seed();
        await service.enqueueForPlotEntity(plot as any, tables.farm.rows[0] as any);

        mockAssessPlot().mockRejectedValue(
            new WhispUnavailableError("timeout", "WhISP timed out.", { httpStatus: 504 }),
        );

        const before = Date.now();
        await service.tick();

        const job = tables.job.rows[0];
        expect(job.status).toBe(AssessmentJobStatus.QUEUED);
        expect(job.retryable).toBe(true);
        expect(job.failureCode).toBe("timeout");
        expect(job.attempts).toBe(1);
        // First retry delay is BACKOFF_MS[0] = 30s.
        expect(job.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 29_000);
        expect(job.nextAttemptAt.getTime()).toBeLessThanOrEqual(before + 31_000);
    });

    it("grows the backoff on the second failure (30s -> 2m)", async () => {
        const { service } = loadQueue();
        const { plot } = seed();
        await service.enqueueForPlotEntity(plot as any, tables.farm.rows[0] as any);

        mockAssessPlot().mockRejectedValue(
            new WhispUnavailableError("service_unavailable", "WhISP is down.", { httpStatus: 502 }),
        );

        await service.tick();
        // Make the row due again immediately, then drain once more.
        tables.job.rows[0].nextAttemptAt = new Date(Date.now() - 1_000);
        const before = Date.now();
        await service.tick();

        const job = tables.job.rows[0];
        expect(job.attempts).toBe(2);
        expect(job.status).toBe(AssessmentJobStatus.QUEUED);
        expect(job.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 119_000);
        expect(job.nextAttemptAt.getTime()).toBeLessThanOrEqual(before + 121_000);
    });

    it("does not retry a permanent failure (auth_failed)", async () => {
        const { service } = loadQueue();
        const { plot } = seed();
        await service.enqueueForPlotEntity(plot as any, tables.farm.rows[0] as any);

        mockAssessPlot().mockRejectedValue(
            new WhispUnavailableError("auth_failed", "WhISP rejected the API key.", { httpStatus: 401 }),
        );
        await service.tick();

        const job = tables.job.rows[0];
        expect(job.status).toBe(AssessmentJobStatus.FAILED);
        expect(job.retryable).toBe(false);
        expect(job.nextAttemptAt).toBeNull();
        expect(job.finishedAt).toBeInstanceOf(Date);
    });

    it("parks a geometry/provenance block in boundary_review instead of retrying", async () => {
        const { service } = loadQueue();
        const { plot } = seed();
        await service.enqueueForPlotEntity(plot as any, tables.farm.rows[0] as any);

        const err: any = new Error("Compliance analysis blocked: this plot has no boundary polygon.");
        err.isGeometryValidationError = true;
        mockAssessPlot().mockRejectedValue(err);

        await service.tick();

        const job = tables.job.rows[0];
        expect(job.status).toBe(AssessmentJobStatus.BOUNDARY_REVIEW);
        expect(job.retryable).toBe(false);
        expect(job.boundaryReviewReason).toMatch(/no boundary polygon/i);
    });

    it("gives up after MAX_ATTEMPTS even for retryable errors", async () => {
        const { service } = loadQueue();
        const { plot } = seed();
        await service.enqueueForPlotEntity(plot as any, tables.farm.rows[0] as any);

        mockAssessPlot().mockRejectedValue(
            new WhispUnavailableError("timeout", "WhISP timed out.", { httpStatus: 504 }),
        );

        for (let i = 0; i < 6; i++) {
            const job = tables.job.rows[0];
            if (job.status !== AssessmentJobStatus.QUEUED) break;
            job.nextAttemptAt = new Date(Date.now() - 1_000);
            await service.tick();
        }

        const job = tables.job.rows[0];
        expect(job.attempts).toBe(5); // MAX_ATTEMPTS
        expect(job.status).toBe(AssessmentJobStatus.FAILED);
        expect(job.retryable).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. FAILURE MUST NOT DESTROY PRIOR VERIFIED EVIDENCE
// ════════════════════════════════════════════════════════════════════════════
describe("failure preserves the previous verified result", () => {
    it("leaves the earlier verdict row and farm rating/timestamp untouched", async () => {
        const { service } = loadQueue();
        const verifiedAt = new Date("2026-09-01T10:00:00.000Z");
        const { plot } = seed(
            { riskLevel: "Medium", lastRiskAssessmentDate: verifiedAt },
        );
        const farm = tables.farm.rows[0];

        // A prior, verified verdict about this plot's current polygon.
        const hash = geometryHashOf(SURVEYED_POLYGON);
        plot.geometryHash = hash;
        plot.geometryVersion = 1;
        tables.assessment.rows.push({
            id: "ra-prior",
            farmId: farm.id,
            plotId: plot.id,
            geometryHash: hash,
            geometryVersion: 1,
            overallRisk: "Medium",
            source: "whisp_live",
            whispVerified: true,
            supersededByGeometryChange: false,
            createdAt: verifiedAt,
        });

        // Request a re-check of the SAME polygon, and have it fail.
        await service.enqueueForPlotEntity(plot as any, farm as any);
        mockAssessPlot().mockRejectedValue(
            new WhispUnavailableError("timeout", "WhISP timed out.", { httpStatus: 504 }),
        );
        await service.tick();

        // The verdict survives, still verified and current.
        const prior = tables.assessment.rows.find((r) => r.id === "ra-prior")!;
        expect(prior.supersededByGeometryChange).toBe(false);
        expect(prior.whispVerified).toBe(true);
        expect(tables.assessment.rows).toHaveLength(1);

        // The farm's last verified rating and its ORIGINAL timestamp survive.
        expect(farm.riskLevel).toBe("Medium");
        expect(farm.lastRiskAssessmentDate).toBe(verifiedAt);

        // And the failure is recorded on the job row so staff can see it.
        expect(tables.job.rows[0].status).toBe(AssessmentJobStatus.QUEUED);
        expect(tables.job.rows[0].lastError).toMatch(/timed out/i);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. MANUAL RETRY
// ════════════════════════════════════════════════════════════════════════════
describe("manual retry", () => {
    it("resets attempts, backoff and the error message", async () => {
        const { service } = loadQueue();
        const { plot } = seed();
        await service.enqueueForPlotEntity(plot as any, tables.farm.rows[0] as any);

        mockAssessPlot().mockRejectedValue(
            new WhispUnavailableError("auth_failed", "WhISP rejected the API key.", { httpStatus: 401 }),
        );
        await service.tick();
        expect(tables.job.rows[0].status).toBe(AssessmentJobStatus.FAILED);

        const retried = await service.retryJob(tables.job.rows[0].id);

        expect(retried!.status).toBe(AssessmentJobStatus.QUEUED);
        expect(retried!.attempts).toBe(0);
        expect(retried!.lastError).toBeNull();
        expect(retried!.retryable).toBe(false);
        expect(retried!.nextAttemptAt).toBeInstanceOf(Date);
    });

    it("does not re-queue a completed job", async () => {
        const { service } = loadQueue();
        const { plot } = seed();
        await service.enqueueForPlotEntity(plot as any, tables.farm.rows[0] as any);

        mockAssessPlot().mockResolvedValue({ id: "ra-new" });
        await service.tick();

        const out = await service.retryJob(tables.job.rows[0].id);
        expect(out!.status).toBe(AssessmentJobStatus.COMPLETED);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. THE SYNC-PATH WRAPPER MUST NEVER FAIL A FIELD SYNC
// ════════════════════════════════════════════════════════════════════════════
describe("enqueueAssessmentSafely — a queue problem must not fail the sync", () => {
    it("returns a summary rather than throwing when enqueueing explodes", async () => {
        const { assessmentQueue, enqueueAssessmentSafely } = loadQueue();
        const spy = jest
            .spyOn(assessmentQueue, "enqueueForFarm")
            .mockRejectedValue(new Error("connection reset"));

        const result = await enqueueAssessmentSafely("farm-1", "test");

        expect(result).toEqual({
            queued: 0,
            reused: 0,
            boundaryReview: 0,
            error: "Assessment could not be queued automatically.",
        });
        spy.mockRestore();
    });

    it("reports the real counts on the happy path", async () => {
        const { enqueueAssessmentSafely } = loadQueue();
        seed();

        const result = await enqueueAssessmentSafely("farm-1", "farm created");

        expect(result).toEqual({ queued: 1, reused: 0, boundaryReview: 0 });
    });
});
