import { In } from "typeorm";
import { AppDataSource } from "../data-source";
import { AssessmentJob } from "../entities/AssessmentJob";
import { Farm } from "../entities/Farm";
import { Plot } from "../entities/Plot";
import { RiskAssessment } from "../entities/RiskAssessment";
import { AssessmentJobStatus } from "./AssessmentQueueService";

/**
 * Read-side projection: what the admin panel shows for ONE plot.
 *
 * WHY THIS IS A SEPARATE MODULE FROM THE QUEUE
 * --------------------------------------------
 * The queue decides what to DO (enqueue, dedupe, retry). This decides what to
 * SHOW. Keeping them apart means the panel can never change queue behaviour,
 * and the queue can never accidentally leak internals to staff.
 *
 * THE ONE RULE THAT MATTERS HERE
 * ------------------------------
 * A verdict is only reported as the plot's current finding when ALL of these
 * hold:
 *
 *   1. it has verified provenance (source === 'whisp_live' AND whispVerified),
 *   2. it was NOT flagged superseded because the boundary changed, and
 *   3. its geometryHash still matches the plot's current polygon.
 *
 * Rule 3 is the belt-and-braces twin of the write-time guard: even if a row
 * somehow escaped being flagged, a hash mismatch keeps it out of the "current"
 * slot. It stays visible as history, so the due-diligence file still contains
 * the evidence about the older shape.
 */

export type PlotAssessmentStatus =
    | "queued"
    | "assessing"
    | "completed"
    | "failed"
    | "boundary_review"
    | "not_queued";

export interface PlotAssessmentView {
    plotId: string;
    plotName: string;
    isDefault: boolean;
    areaHa: number | null;
    /** Human-facing boundary version ("v2"). Bumped only on a real edit. */
    geometryVersion: number;
    geometryHash: string | null;

    status: PlotAssessmentStatus;
    /** Present when status === 'boundary_review' (or a failed job explains why). */
    statusReason: string | null;

    jobId: string | null;
    attempts: number;
    /** When the worker will try again, for a retryable failure. */
    nextAttemptAt: string | null;

    /**
     * The CURRENT deforestation finding, or null.
     *
     * Null is meaningful and must be rendered as "not assessed" rather than as
     * a clean result — see the rule at the top of this file.
     */
    riskLevel: 'Low' | 'Medium' | 'High' | null;
    /** Whisp's own commodity-category verdict label (low/high/more_info_needed). */
    deforestationFinding: string | null;
    /** True when Whisp returned 'more_info_needed' - inconclusive, NOT a pass. */
    inconclusive: boolean;
    assessedAt: string | null;
    /** Which polygon version the current finding describes. */
    assessedGeometryVersion: number | null;
    attention: string | null;
    narrative: string | null;

    /** Older verdicts retained for history (boundary since corrected). */
    historyCount: number;
    lastFailureMessage: string | null;
}

/** Shape returned by the per-farm endpoint, so the panel can render a table. */
export interface FarmPlotAssessmentView {
    farmId: string;
    farmName: string;
    plots: PlotAssessmentView[];
    summary: {
        total: number;
        completed: number;
        queued: number;
        assessing: number;
        failed: number;
        boundaryReview: number;
        /** Plots whose current finding is a verified satellite result. */
        withVerifiedFinding: number;
    };
}

export class PlotAssessmentViewService {
    private plotRepo = AppDataSource.getRepository(Plot);
    private farmRepo = AppDataSource.getRepository(Farm);
    private jobRepo = AppDataSource.getRepository(AssessmentJob);
    private assessmentRepo = AppDataSource.getRepository(RiskAssessment);

    /** Builds the per-plot view for one farm (one query per table, no N+1). */
    async forFarm(farmId: string): Promise<FarmPlotAssessmentView | null> {
        const farm = await this.farmRepo.findOne({ where: { id: farmId } });
        if (!farm) return null;

        const plots = await this.plotRepo.find({
            where: { farmId, isActive: true },
            order: { createdAt: "ASC" },
        });
        if (plots.length === 0) {
            return {
                farmId: farm.id,
                farmName: farm.name,
                plots: [],
                summary: { total: 0, completed: 0, queued: 0, assessing: 0, failed: 0, boundaryReview: 0, withVerifiedFinding: 0 },
            };
        }

        const plotIds = plots.map(p => p.id);

        // One query for the latest job per plot, one for all verdicts.
        const jobs = await this.jobRepo.find({
            where: { plotId: In(plotIds) },
            order: { createdAt: "DESC" },
        });
        const assessments = await this.assessmentRepo.find({
            where: { plotId: In(plotIds) },
            order: { createdAt: "DESC" },
        });

        const latestJobByPlot = new Map<string, AssessmentJob>();
        for (const job of jobs) {
            if (job.plotId && !latestJobByPlot.has(job.plotId)) latestJobByPlot.set(job.plotId, job);
        }

        const views = plots.map(plot => this.buildPlotView(plot, latestJobByPlot.get(plot.id) ?? null, assessments.filter(a => a.plotId === plot.id)));

        const summary = {
            total: views.length,
            completed: views.filter(v => v.status === "completed").length,
            queued: views.filter(v => v.status === "queued").length,
            assessing: views.filter(v => v.status === "assessing").length,
            failed: views.filter(v => v.status === "failed").length,
            boundaryReview: views.filter(v => v.status === "boundary_review").length,
            withVerifiedFinding: views.filter(v => v.riskLevel !== null).length,
        };

        return { farmId: farm.id, farmName: farm.name, plots: views, summary };
    }

    private buildPlotView(plot: Plot, job: AssessmentJob | null, verdicts: RiskAssessment[]): PlotAssessmentView {
        // Newest verdict that describes the polygon CURRENTLY on the plot.
        const current = verdicts.find(a => this.isCurrentFinding(a, plot)) ?? null;

        // Everything else is history: either superseded by a boundary change or
        // produced for a different polygon.
        const historyCount = verdicts.filter(a => a !== current).length;

        const status = this.statusOf(plot, job, current);

        const whispData: any = current?.whispData ?? null;
        const deforestationFinding =
            whispData?.riskPerennialCrop ?? whispData?.riskAnnualCrop ?? whispData?.riskTimber ?? null;

        return {
            plotId: plot.id,
            plotName: plot.name,
            isDefault: !!plot.isDefault,
            areaHa: plot.areaHa ?? null,
            geometryVersion: (plot as any).geometryVersion ?? 0,
            geometryHash: (plot as any).geometryHash ?? null,

            status,
            statusReason:
                status === "boundary_review"
                    ? (job?.boundaryReviewReason ?? null)
                    : status === "failed"
                        ? (job?.lastError ?? null)
                        : null,

            jobId: job?.id ?? null,
            attempts: job?.attempts ?? 0,
            nextAttemptAt: job?.nextAttemptAt ? new Date(job.nextAttemptAt).toISOString() : null,

            riskLevel: current ? (current.overallRisk as any) : null,
            deforestationFinding,
            // 'more_info_needed' is Whisp saying it could NOT decide. It must
            // never be rendered as a clean pass.
            inconclusive: deforestationFinding === 'more_info_needed',
            assessedAt: current?.createdAt ? new Date(current.createdAt).toISOString() : null,
            assessedGeometryVersion: current?.geometryVersion ?? null,
            attention: current?.deforestationRisk ? "Deforestation signal after the 2020 cutoff" : null,
            narrative: (current?.details as any)?.narrative ?? null,

            historyCount,
            lastFailureMessage: job?.lastError ?? null,
        };
    }

    /**
     * A verdict may only be shown as current when it is verified, not
     * superseded, and describes the polygon the plot has NOW.
     */
    private isCurrentFinding(a: RiskAssessment, plot: Plot): boolean {
        if (a.source !== "whisp_live" || a.whispVerified !== true) return false;
        if (a.supersededByGeometryChange) return false;
        const currentHash = (plot as any).geometryHash ?? null;
        // A legacy row with no hash cannot be proven to describe this polygon.
        if (!a.geometryHash || !currentHash) return false;
        return a.geometryHash === currentHash;
    }

    private statusOf(plot: Plot, job: AssessmentJob | null, current: RiskAssessment | null): PlotAssessmentStatus {
        if (current) return "completed";
        if (!job) return "not_queued";

        switch (job.status) {
            case AssessmentJobStatus.COMPLETED:
                // The job says completed but no verdict survives the currency
                // test — e.g. the boundary has moved on since. Report the job's
                // own terminal state rather than pretending nothing happened.
                return job.boundaryReviewReason ? "boundary_review" : "completed";
            case AssessmentJobStatus.BOUNDARY_REVIEW: return "boundary_review";
            case AssessmentJobStatus.ASSESSING: return "assessing";
            case AssessmentJobStatus.QUEUED: return "queued";
            case AssessmentJobStatus.FAILED: return "failed";
            default: return "not_queued";
        }
    }

    /** Queue overview for staff: everything not in a terminal happy state. */
    async outstanding(limit = 100): Promise<AssessmentJob[]> {
        return this.jobRepo.find({
            where: { status: In([AssessmentJobStatus.QUEUED, AssessmentJobStatus.ASSESSING]) },
            order: { createdAt: "ASC" },
            take: limit,
        });
    }
}

export const plotAssessmentView = new PlotAssessmentViewService();
