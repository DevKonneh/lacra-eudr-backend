import { LessThanOrEqual, Not, In } from "typeorm";
import { AppDataSource } from "../data-source";
import { AssessmentJob } from "../entities/AssessmentJob";
import { Farm } from "../entities/Farm";
import { Plot } from "../entities/Plot";
import { RiskAssessment } from "../entities/RiskAssessment";
import { geometryValidationService, GeometryStatus } from "./GeometryValidationService";
import {
    GeometrySource,
    resolveGeometrySource,
    isLegacyGeneratedSquare,
} from "./GeometryProvenance";
import { geometryHashOf, nextGeometryVersion, assessmentDedupeKey } from "./GeometryVersioning";
import { RiskService } from "./RiskService";

/**
 * Automatic per-plot satellite (Open Foris WhISP) assessment queue.
 *
 * WHY THIS EXISTS
 * ---------------
 * A farm synced from the Farm Mapping app used to sit with no satellite
 * evidence until a member of staff clicked "Assess". Field collection and
 * due-diligence evidence were therefore decoupled, and nothing in the admin
 * panel told staff that a plot had never been checked.
 *
 * Now: the moment CMIS commits a plot whose polygon is eligible, a job row is
 * inserted and the sync returns. A background worker performs the WhISP call.
 *
 * THE FOUR GUARANTEES THIS MODULE PROVIDES
 * ----------------------------------------
 *  1. NEVER BLOCKS SYNC. Enqueueing is a single INSERT (plus a dedupe read).
 *     No network call happens on the request path, ever.
 *
 *  2. ONE JOB PER (PLOT, POLYGON). `dedupeKey` is `plotId:sha256(polygon)` with
 *     a UNIQUE index behind it, so a retried sync of an unchanged boundary
 *     collides with the existing row instead of creating a duplicate. The
 *     uniqueness is enforced by Postgres, not by a check-then-insert that could
 *     race between two concurrent syncs.
 *
 *  3. A CORRECTED POLYGON GETS A NEW JOB, AND THE OLD RESULT CANNOT WIN.
 *     The polygon's hash is recomputed on every save. When it changes, the old
 *     job is closed out and a new one queued at the new version. The old
 *     RiskAssessment row is KEPT (due-diligence history) but flagged
 *     `supersededByGeometryChange`, and the write path re-checks the plot's
 *     hash immediately before committing a verdict — so a run that started
 *     against v1 and finished after v2 was saved is recorded as superseded
 *     rather than silently becoming the plot's rating.
 *
 *  4. INELIGIBLE GEOMETRY IS EXPLAINED, NOT SWALLOWED. A point-only plot, a
 *     generated square, a missing or invalid polygon is parked as
 *     'boundary_review' with a human-readable reason, and nothing is sent to
 *     WhISP. The moment a valid surveyed polygon arrives, enqueueing runs again
 *     and a real job is created.
 */

/** Retry delays for TEMPORARY WhISP failures (network/timeout/5xx/rate limit). */
const BACKOFF_MS = [
    30_000,      // 30s
    2 * 60_000,  // 2m
    8 * 60_000,  // 8m
    30 * 60_000, // 30m
    2 * 3_600_000, // 2h
];
const MAX_ATTEMPTS = BACKOFF_MS.length;

export const AssessmentJobStatus = {
    QUEUED: "queued",
    ASSESSING: "assessing",
    COMPLETED: "completed",
    FAILED: "failed",
    BOUNDARY_REVIEW: "boundary_review",
} as const;

export type AssessmentJobStatusValue =
    typeof AssessmentJobStatus[keyof typeof AssessmentJobStatus];

/** Result of deciding whether a plot's geometry may be sent to WhISP. */
export type EligibilityOutcome =
    | {
        eligible: true;
        geometry: any;
        geometryHash: string;
        provenance: GeometrySourceValue;
        /** Where the polygon came from, for audit: the plot itself, or the farm. */
        geometryOrigin: "plot" | "farm";
    }
    | {
        eligible: false;
        reason: string;
        provenance: GeometrySourceValue | null;
    };

type GeometrySourceValue = typeof GeometrySource[keyof typeof GeometrySource];

/** Minimal plot shape this module needs (avoids importing the entity type). */
type PlotLike = {
    id: string;
    name?: string;
    boundary?: any;
    areaHa?: number | null;
    isDefault?: boolean;
    geometryHash?: string | null;
    geometryVersion?: number | null;
    farmId?: string;
};

type FarmLike = {
    id: string;
    location?: any;
    geometrySource?: string | null;
    totalAreaHa?: number | null;
    geometryStatus?: string | null;
};

export class AssessmentQueueService {
    private jobRepo = AppDataSource.getRepository(AssessmentJob);
    private plotRepo = AppDataSource.getRepository(Plot);
    private farmRepo = AppDataSource.getRepository(Farm);
    private assessmentRepo = AppDataSource.getRepository(RiskAssessment);

    private workerTimer: NodeJS.Timeout | null = null;
    private ticking = false;

    // ────────────────────────────────────────────────────────────────────────
    // Geometry resolution + eligibility
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Resolves the polygon that should be sent to WhISP for a given plot.
     *
     * A plot with its own boundary is assessed on THAT polygon — this is what
     * makes "if one submission contains multiple plots, assess each eligible
     * polygon and attach its result to the correct plot" work.
     *
     * The auto-created default plot deliberately has `boundary === null`
     * (see CommodityService.buildPlotsForFarm / Plot.ts), because it represents
     * "the whole farm, undivided". For those, and only those, the farm's own
     * polygon is the correct geometry. Falling back for a non-default plot
     * would silently assess the wrong parcel, so that is NOT done.
     */
    resolvePlotGeometry(plot: PlotLike, farm: FarmLike): {
        geometry: any;
        origin: "plot" | "farm";
        provenance: GeometrySourceValue | null;
    } {
        if (plot.boundary) {
            return {
                geometry: plot.boundary,
                origin: "plot",
                provenance: resolveGeometrySource(plot.boundary, null),
            };
        }
        if (plot.isDefault) {
            return {
                geometry: farm.location,
                origin: "farm",
                provenance: resolveGeometrySource(farm.location, farm.geometrySource),
            };
        }
        return { geometry: null, origin: "plot", provenance: null };
    }

    /**
     * Decides whether this plot may be assessed, and if not, exactly why.
     *
     * Order matters: provenance is checked BEFORE geometric validity, because a
     * point or a generated square is not "invalid geometry" — it is simply not
     * survey evidence, and telling staff "invalid boundary" would misdirect them
     * into trying to fix a polygon they never drew.
     */
    async evaluateEligibility(plot: PlotLike, farm: FarmLike): Promise<EligibilityOutcome> {
        const { geometry, origin, provenance } = this.resolvePlotGeometry(plot, farm);

        if (!geometry || !geometry.type) {
            return {
                eligible: false,
                provenance,
                reason: "No boundary has been recorded for this plot yet. A surveyed polygon is required before a satellite assessment can run.",
            };
        }

        if (geometry.type === "Point") {
            return {
                eligible: false,
                provenance: provenance ?? GeometrySource.RECORDED_POINT,
                reason: "Only a single GPS point was captured. A point is a location, not a boundary — survey the plot's polygon before assessing.",
            };
        }

        if (provenance === GeometrySource.GENERATED_BUFFER || isLegacyGeneratedSquare(geometry)) {
            return {
                eligible: false,
                provenance: GeometrySource.GENERATED_BUFFER,
                reason: "This boundary is the automatically generated square, not a surveyed polygon. Survey the real parcel before assessing, otherwise the satellite result would describe a shape that does not exist on the ground.",
            };
        }

        if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") {
            return {
                eligible: false,
                provenance,
                reason: `Unsupported geometry type "${geometry.type}". A polygon or multipolygon is required.`,
            };
        }

        // Geometric validity. Overlap is skipped deliberately: a subplot is
        // EXPECTED to sit inside its own farm, so the farm-to-farm overlap check
        // would report a false positive for every correctly drawn subplot.
        const validation = await geometryValidationService.validate({
            geometry,
            declaredAreaHa: plot.areaHa ?? farm.totalAreaHa ?? null,
            skipOverlapCheck: true,
            excludeFarmId: farm.id,
        });

        if (validation.status === GeometryStatus.INVALID) {
            return {
                eligible: false,
                provenance,
                reason: `The boundary failed geometry validation: ${validation.errors.join(" ")}`,
            };
        }
        if (validation.status === GeometryStatus.MISSING) {
            return {
                eligible: false,
                provenance,
                reason: "No usable boundary polygon was found for this plot.",
            };
        }

        const hash = geometryHashOf(geometry);
        if (!hash) {
            return {
                eligible: false,
                provenance,
                reason: "The boundary could not be fingerprinted, so it cannot be safely deduplicated. Re-save the polygon.",
            };
        }

        return {
            eligible: true,
            geometry,
            geometryHash: hash,
            provenance: provenance ?? GeometrySource.SURVEYED,
            geometryOrigin: origin,
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    // Enqueue
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Queues (or reuses) an assessment job for one plot.
     *
     * Returns the job plus whether it was newly created, so a sync response can
     * honestly report "queued" vs "already queued/assessed".
     *
     * Never throws for ordinary conditions: enqueueing runs on the farm-save
     * path, and a queueing problem must not fail a field sync.
     */
    async enqueueForPlot(
        plotId: string,
        opts: { reason?: string } = {},
    ): Promise<{ job: AssessmentJob | null; created: boolean; eligibility: EligibilityOutcome }> {
        const plot = await this.plotRepo.findOne({
            where: { id: plotId },
            relations: ["farm"],
        });
        if (!plot || !plot.farm) {
            return {
                job: null,
                created: false,
                eligibility: {
                    eligible: false,
                    provenance: null,
                    reason: "Plot or its farm could not be loaded.",
                },
            };
        }
        return this.enqueueForPlotEntity(plot, plot.farm, opts);
    }

    /** Same as enqueueForPlot, for callers that already hold the entities. */
    async enqueueForPlotEntity(
        plot: Plot,
        farm: Farm,
        opts: { reason?: string } = {},
    ): Promise<{ job: AssessmentJob | null; created: boolean; eligibility: EligibilityOutcome }> {
        const eligibility = await this.evaluateEligibility(plot as any, farm as any);

        if (!eligibility.eligible) {
            // Park a visible 'boundary_review' row (or refresh the existing one)
            // so staff can see WHY nothing is being assessed. Keyed on the plot
            // alone, since there is no polygon to hash.
            const reviewKey = `${plot.id}:no-polygon`;
            const job = await this.upsertBoundaryReview(plot, farm, reviewKey, eligibility.reason);
            return { job, created: true, eligibility };
        }

        const hash = eligibility.geometryHash;

        // Persist the plot's geometry identity so later saves can tell an edit
        // from a retry. Only a REAL polygon change bumps the version.
        const { changed } = await this.syncPlotGeometryVersion(plot, eligibility.geometry);
        const version = (plot as any).geometryVersion ?? 0;

        const dedupeKey = assessmentDedupeKey(plot.id, hash);

        // Dedupe: one job per (plot, polygon). A retried sync lands here.
        const existing = await this.jobRepo.findOne({ where: { dedupeKey } });
        if (existing) {
            // If a previous attempt landed in boundary_review but the geometry
            // is now eligible (e.g. staff corrected a point into a polygon at
            // the same coordinates is impossible, but a re-save can promote a
            // row), move it back to queued so it actually runs.
            if (existing.status === AssessmentJobStatus.BOUNDARY_REVIEW) {
                existing.status = AssessmentJobStatus.QUEUED;
                existing.boundaryReviewReason = null;
                existing.nextAttemptAt = new Date();
                await this.jobRepo.save(existing);
                this.kick();
                return { job: existing, created: false, eligibility };
            }
            return { job: existing, created: false, eligibility };
        }

        // A corrected polygon supersedes any in-flight job for this plot: the
        // older run must not be able to publish a verdict for the new boundary.
        await this.supersedeOpenJobsForPlot(plot.id, hash);

        const job = this.jobRepo.create({
            plot,
            plotId: plot.id,
            farm,
            farmId: farm.id,
            plotNameSnapshot: plot.name,
            geometryHash: hash,
            geometryVersion: version,
            dedupeKey,
            status: AssessmentJobStatus.QUEUED,
            attempts: 0,
            nextAttemptAt: new Date(),
            boundaryReviewReason: opts.reason ?? null,
        });

        // The UNIQUE index on dedupeKey is the real guarantee: if two concurrent
        // syncs race past the findOne above, one INSERT fails and we return the
        // winner's row instead of erroring the whole sync.
        try {
            const saved = await this.jobRepo.save(job);
            this.kick();
            return { job: saved, created: true, eligibility };
        } catch (err: any) {
            if (/duplicate key|unique constraint/i.test(String(err?.message))) {
                const winner = await this.jobRepo.findOne({ where: { dedupeKey } });
                return { job: winner, created: false, eligibility };
            }
            throw err;
        }
    }

    /**
     * Enqueues every active plot of a farm. Used after a farm (and its plots)
     * is committed, and after a boundary correction.
     *
     * Deliberately per-plot: a submission carrying several plots produces one
     * job per eligible polygon, so each verdict attaches to the right parcel.
     */
    async enqueueForFarm(
        farmId: string,
    ): Promise<{ created: number; reused: number; boundaryReview: number; results: any[] }> {
        const farm = await this.farmRepo.findOne({ where: { id: farmId } });
        if (!farm) return { created: 0, reused: 0, boundaryReview: 0, results: [] };

        const plots = await this.plotRepo.find({
            where: { farmId, isActive: true },
            order: { createdAt: "ASC" },
        });

        let created = 0, reused = 0, boundaryReview = 0;
        const results: any[] = [];

        for (const plot of plots) {
            try {
                const r = await this.enqueueForPlotEntity(plot, farm);
                if (!r.eligibility.eligible) boundaryReview++;
                else if (r.created) created++;
                else reused++;
                results.push({
                    plotId: plot.id,
                    plotName: plot.name,
                    eligible: r.eligibility.eligible,
                    status: r.job?.status ?? null,
                    reason: r.eligibility.eligible ? null : r.eligibility.reason,
                    jobId: r.job?.id ?? null,
                });
            } catch (err: any) {
                // One bad plot must not stop the others in the same submission.
                console.error(`[assessment-queue] enqueue failed for plot ${plot.id}:`, err?.message);
                results.push({ plotId: plot.id, plotName: plot.name, error: err?.message });
            }
        }

        return { created, reused, boundaryReview, results };
    }

    // ────────────────────────────────────────────────────────────────────────
    // Geometry version bookkeeping
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Recomputes and stores the plot's geometry hash/version.
     *
     * `changed` is true only when the canonical polygon actually differs, which
     * is what distinguishes "a corrected boundary" from "the same boundary
     * synced twice". A retried sync MUST report changed=false, otherwise it
     * would bump the version and defeat deduplication.
     */
    async syncPlotGeometryVersion(
        plot: Plot,
        geometry: any,
    ): Promise<{ version: number; hash: string | null; changed: boolean }> {
        const { version, hash, changed } = nextGeometryVersion(
            (plot as any).geometryHash,
            geometry,
            (plot as any).geometryVersion,
        );
        if (changed || (plot as any).geometryHash !== hash) {
            (plot as any).geometryHash = hash;
            (plot as any).geometryVersion = version;
            await this.plotRepo.save(plot as any);
        }
        return { version, hash, changed };
    }

    /**
     * Marks any still-open job for this plot whose polygon differs as
     * superseded, so the worker cannot later publish it as current.
     *
     * The job row is retained (status 'failed' with an explanatory message) —
     * deleting it would erase the record that a check was started for the older
     * boundary, which due diligence needs.
     */
    private async supersedeOpenJobsForPlot(plotId: string, newHash: string): Promise<void> {
        const open = await this.jobRepo.find({
            where: {
                plotId,
                status: In([AssessmentJobStatus.QUEUED, AssessmentJobStatus.ASSESSING]),
                geometryHash: Not(newHash),
            },
        });
        for (const stale of open) {
            stale.status = AssessmentJobStatus.FAILED;
            stale.retryable = false;
            stale.failureCode = "superseded_by_geometry_change";
            stale.lastError =
                "The plot's boundary was corrected while this check was queued or running. " +
                "This job describes an older polygon and will not become the current rating. " +
                "A new check has been queued for the current boundary.";
            stale.finishedAt = new Date();
            await this.jobRepo.save(stale);
        }

        // Retire verdicts produced for an older polygon — INDEPENDENTLY of
        // whether any job was still open.
        //
        // The common case is a boundary corrected AFTER a check already
        // COMPLETED. There is no open job then, so flagging inside the loop
        // above would never run and the stale verdict would silently remain the
        // plot's current rating. Rows are kept (due-diligence history), only
        // marked superseded.
        const prior = await this.assessmentRepo.find({
            where: { plotId, geometryHash: Not(newHash) },
        });
        for (const row of prior) {
            if (!row.supersededByGeometryChange) {
                row.supersededByGeometryChange = true;
                await this.assessmentRepo.save(row);
            }
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Worker
    // ────────────────────────────────────────────────────────────────────────

    /** Wakes the worker without waiting for the next poll interval. */
    private kick(): void {
        if (this.workerTimer === null) return; // no worker running in this process
        setImmediate(() => { void this.tick(); });
    }

    /**
     * Starts the background worker. Idempotent, so a double call in tests or a
     * hot reload cannot create two drainers.
     *
     * In-process by design for now: a single timer draining due rows. Because
     * the queue is a TABLE, moving to an external scheduler later is a matter of
     * calling `tick()` from cron instead — no data migration needed.
     */
    startWorker(intervalMs = 15_000): void {
        if (this.workerTimer) return;
        this.workerTimer = setInterval(() => { void this.tick(); }, intervalMs);
        // Do not hold the event loop open in tests / short-lived scripts.
        if (typeof this.workerTimer.unref === "function") this.workerTimer.unref();
        void this.tick();
    }

    stopWorker(): void {
        if (this.workerTimer) {
            clearInterval(this.workerTimer);
            this.workerTimer = null;
        }
    }

    /**
     * One drain pass: pick up to `limit` due jobs and run them.
     *
     * `ticking` guards against overlapping passes — without it, two timers (or a
     * timer plus a manual retry) could pick the same row and double-submit the
     * same polygon to WhISP.
     */
    async tick(limit = 5): Promise<{ processed: number }> {
        if (this.ticking) return { processed: 0 };
        this.ticking = true;
        let processed = 0;
        try {
            const due = await this.jobRepo.find({
                where: {
                    status: AssessmentJobStatus.QUEUED,
                    nextAttemptAt: LessThanOrEqual(new Date()),
                },
                order: { createdAt: "ASC" },
                take: limit,
            });

            for (const job of due) {
                await this.runJob(job);
                processed++;
            }
        } catch (err: any) {
            console.error("[assessment-queue] tick failed:", err?.message);
        } finally {
            this.ticking = false;
        }
        return { processed };
    }

    /**
     * Executes one job. Every outcome is written to the job row; nothing is
     * thrown at the caller, because the worker has no caller to inform.
     */
    private async runJob(job: AssessmentJob): Promise<void> {
        job.status = AssessmentJobStatus.ASSESSING;
        job.attempts = (job.attempts ?? 0) + 1;
        job.startedAt = job.startedAt ?? new Date();
        job.nextAttemptAt = null;
        await this.jobRepo.save(job);

        try {
            const riskService = new RiskService();
            const assessment = await riskService.assessPlot(job.plotId!, {
                geometryHash: job.geometryHash ?? null,
                geometryVersion: job.geometryVersion,
            });

            job.status = AssessmentJobStatus.COMPLETED;
            job.assessmentId = assessment.id;
            job.failureCode = null;
            job.lastError = null;
            job.retryable = false;
            job.boundaryReviewReason = null;
            job.finishedAt = new Date();
            await this.jobRepo.save(job);
        } catch (err: any) {
            await this.recordFailure(job, err);
        }
    }

    /** Applies the terminal-vs-retry decision and schedules the next attempt. */
    private async recordFailure(job: AssessmentJob, err: any): Promise<void> {
        const code = err?.code ?? err?.failureCode ?? "request_failed";
        const retryable = err?.retryable === true && (job.attempts ?? 0) < MAX_ATTEMPTS;

        job.failureCode = code;
        job.lastError = err?.message ?? "Assessment failed for an unknown reason.";
        job.retryable = retryable;

        // A provenance/geometry block is not a WhISP failure — it is a boundary
        // problem staff must fix, so it must not spin in the retry loop.
        if (err?.isGeometryValidationError || err?.isProvenanceBlock) {
            job.status = AssessmentJobStatus.BOUNDARY_REVIEW;
            job.boundaryReviewReason = err.message;
            job.retryable = false;
            job.finishedAt = new Date();
            await this.jobRepo.save(job);
            return;
        }

        if (retryable) {
            const delay = BACKOFF_MS[Math.min((job.attempts ?? 1) - 1, BACKOFF_MS.length - 1)];
            job.status = AssessmentJobStatus.QUEUED;
            job.nextAttemptAt = new Date(Date.now() + delay);
        } else {
            job.status = AssessmentJobStatus.FAILED;
            job.finishedAt = new Date();
        }
        await this.jobRepo.save(job);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Staff-facing helpers
    // ────────────────────────────────────────────────────────────────────────

    /** Manual retry, for authorised staff. Resets the backoff and re-queues. */
    async retryJob(jobId: string): Promise<AssessmentJob | null> {
        const job = await this.jobRepo.findOne({ where: { id: jobId } });
        if (!job) return null;
        if (job.status === AssessmentJobStatus.COMPLETED) return job;

        job.status = AssessmentJobStatus.QUEUED;
        job.attempts = 0;
        job.nextAttemptAt = new Date();
        job.lastError = null;
        job.retryable = false;
        job.finishedAt = null;
        job.boundaryReviewReason = null;
        const saved = await this.jobRepo.save(job);
        this.kick();
        return saved;
    }

    /** Manual retry by plot (what the plot's admin panel button uses). */
    async retryForPlot(plotId: string): Promise<{ job: AssessmentJob | null; created: boolean; eligibility: EligibilityOutcome }> {
        return this.enqueueForPlot(plotId, { reason: "Queued manually by staff." });
    }

    /** Current job for a plot, newest first. */
    async latestJobForPlot(plotId: string): Promise<AssessmentJob | null> {
        const rows = await this.jobRepo.find({
            where: { plotId },
            order: { createdAt: "DESC" },
            take: 1,
        });
        return rows[0] ?? null;
    }

    private async upsertBoundaryReview(
        plot: Plot,
        farm: Farm,
        reviewKey: string,
        reason: string,
    ): Promise<AssessmentJob> {
        const existing = await this.jobRepo.findOne({ where: { dedupeKey: reviewKey } });
        if (existing) {
            // Keep the reason current (e.g. the point-only wording is more
            // specific than a generic earlier one) without creating new rows.
            if (existing.boundaryReviewReason !== reason) {
                existing.boundaryReviewReason = reason;
            }
            existing.status = AssessmentJobStatus.BOUNDARY_REVIEW;
            existing.nextAttemptAt = null;
            return this.jobRepo.save(existing);
        }
        const job = this.jobRepo.create({
            plot,
            plotId: plot.id,
            farm,
            farmId: farm.id,
            plotNameSnapshot: plot.name,
            geometryHash: null,
            geometryVersion: (plot as any).geometryVersion ?? 0,
            dedupeKey: reviewKey,
            status: AssessmentJobStatus.BOUNDARY_REVIEW,
            attempts: 0,
            nextAttemptAt: null,
            boundaryReviewReason: reason,
        });
        try {
            return await this.jobRepo.save(job);
        } catch (err: any) {
            if (/duplicate key|unique constraint/i.test(String(err?.message))) {
                const winner = await this.jobRepo.findOne({ where: { dedupeKey: reviewKey } });
                if (winner) return winner;
            }
            throw err;
        }
    }
}

/** Process-wide singleton: one worker, one drain guard. */
export const assessmentQueue = new AssessmentQueueService();

/**
 * Enqueues every active plot of a farm, swallowing any error.
 *
 * WHY IT SWALLOWS: this runs on the farm-save / mobile-sync path, immediately
 * after the record has been committed. The field data is the irreplaceable part
 * of the transaction; a queueing problem (transient DB error, a single weird
 * plot) must never turn a successful sync into a failed one, because the client
 * would then retry the whole submission. The queue is also recoverable —
 * `backfill` / a manual retry can re-create anything missed — whereas a synced
 * record that the app was told had failed may simply be dropped on the device.
 *
 * Returns a small, serialisable summary for the API response so staff (and the
 * sync client) can see that assessment was queued without waiting for it.
 */
export async function enqueueAssessmentSafely(
    farmId: string,
    reason: string,
): Promise<{ queued: number; reused: number; boundaryReview: number; error?: string }> {
    try {
        const r = await assessmentQueue.enqueueForFarm(farmId);
        return { queued: r.created, reused: r.reused, boundaryReview: r.boundaryReview };
    } catch (err: any) {
        console.error(`[assessment-queue] enqueue failed (${reason}) for farm ${farmId}:`, err?.message);
        return { queued: 0, reused: 0, boundaryReview: 0, error: "Assessment could not be queued automatically." };
    }
}
