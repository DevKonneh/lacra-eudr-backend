import { In } from "typeorm";
import { AppDataSource } from "../data-source";
import { AssessmentJob } from "../entities/AssessmentJob";
import { Farm } from "../entities/Farm";
import { FarmDocument } from "../entities/FarmDocument";
import { Plot } from "../entities/Plot";
import { PlotEudrReview, EUDR_DECISION_VALUES, EudrDecision } from "../entities/PlotEudrReview";
import { RiskAssessment } from "../entities/RiskAssessment";
import { AssessmentJobStatus } from "./AssessmentQueueService";
import {
    AssessmentInputs,
    PlotEudrEvaluation,
    FarmEudrSummary,
    PlotEudrInputs,
    ReviewInputs,
    evaluateFarm,
    evaluatePlot,
} from "./EudrStatusService";

/**
 * Builds the EUDR assessment view for a farm: the evidence each plot has, the
 * human decisions recorded against it, and the resulting status.
 *
 * WHY THE READ PATH IS SEPARATE FROM THE WRITE PATH
 * ------------------------------------------------
 * `recordReview` writes a decision. `forFarm` only reads and judges. Keeping
 * them apart means the report can never accidentally create evidence, and the
 * decision rules live in one place (EudrStatusService) rather than being
 * restated in every endpoint.
 *
 * THE CURRENCY RULE
 * -----------------
 * A review only counts when it still describes the parcel on the map:
 *   - it is FINAL (a recommendation never clears anything), and
 *   - its geometryHash matches the plot's CURRENT boundary hash.
 * When the boundary changes, the old decision stops applying automatically -
 * which is exactly the "fresh assessment and a new decision" requirement. The
 * row is never deleted; it stays as history.
 */
export class EudrReviewService {
    private plotRepo = AppDataSource.getRepository(Plot);
    private farmRepo = AppDataSource.getRepository(Farm);
    private jobRepo = AppDataSource.getRepository(AssessmentJob);
    private assessmentRepo = AppDataSource.getRepository(RiskAssessment);
    private documentRepo = AppDataSource.getRepository(FarmDocument);
    private reviewRepo = AppDataSource.getRepository(PlotEudrReview);

    /** Everything the Farmer Profile Report needs for one farm. */
    async forFarm(farmId: string): Promise<{
        farmId: string;
        farmName: string;
        plots: PlotEudrEvaluation[];
        farm: FarmEudrSummary;
    } | null> {
        const farm = await this.farmRepo.findOne({ where: { id: farmId } });
        if (!farm) return null;

        const plots = await this.plotRepo.find({
            where: { farmId, isActive: true },
            order: { createdAt: "ASC" },
        });

        const documents = await this.documentRepo.find({ where: { farmId } });
        const docStates = documents.map(d => ({ status: d.status as string }));

        if (plots.length === 0) {
            const farmSummary = evaluateFarm([], docStates);
            return { farmId: farm.id, farmName: farm.name, plots: [], farm: farmSummary };
        }

        const plotIds = plots.map(p => p.id);

        const [jobs, assessments, reviews] = await Promise.all([
            this.jobRepo.find({ where: { plotId: In(plotIds) }, order: { createdAt: "DESC" } }),
            this.assessmentRepo.find({ where: { plotId: In(plotIds) }, order: { createdAt: "DESC" } }),
            this.reviewRepo.find({ where: { plotId: In(plotIds) }, order: { createdAt: "DESC" } }),
        ]);

        const latestJob = new Map<string, AssessmentJob>();
        for (const j of jobs) {
            if (j.plotId && !latestJob.has(j.plotId)) latestJob.set(j.plotId, j);
        }

        const evaluations = plots.map(plot => {
            const plotAssessments = assessments.filter(a => a.plotId === plot.id);
            const plotReviews = reviews.filter(r => r.plotId === plot.id);
            return evaluatePlot(
                this.buildInputs(plot, latestJob.get(plot.id) ?? null, plotAssessments, plotReviews, docStates),
            );
        });

        return {
            farmId: farm.id,
            farmName: farm.name,
            plots: evaluations,
            farm: evaluateFarm(evaluations, docStates),
        };
    }

    /** Assembles one plot's inputs, applying the currency rules. */
    private buildInputs(
        plot: Plot,
        job: AssessmentJob | null,
        assessments: RiskAssessment[],
        reviews: PlotEudrReview[],
        legalDocuments: Array<{ status: string }>,
    ): PlotEudrInputs {
        const currentHash: string | null = (plot as any).geometryHash ?? null;
        const current = assessments.find(a => this.isCurrentAssessment(a, plot)) ?? null;

        // A final review only counts for the boundary it described.
        const finalReviewRow = reviews.find(
            r => r.isFinal === true && this.reviewMatchesBoundary(r, currentHash),
        ) ?? null;

        // Recommendations are shown but never applied.
        const hasPendingRecommendation = reviews.some(r => r.isFinal === false);

        return {
            plotId: plot.id,
            plotName: plot.name,
            isDefault: !!plot.isDefault,
            hasValidBoundary: !!(plot as any).boundary || !!plot.isDefault,
            assessment: current ? this.toAssessmentInputs(current) : null,
            jobStatus: job?.status ?? null,
            jobFailureMessage: job?.lastError ?? null,
            jobRetryable: job ? this.isRetryable(job) : false,
            legalDocuments,
            finalReview: finalReviewRow ? this.toReviewInputs(finalReviewRow) : null,
            hasPendingRecommendation,
        };
    }

    /**
     * A stored verdict counts only if it is verified, not superseded, and
     * describes the polygon the plot has NOW.
     *
     * Identical rule to PlotAssessmentView.isCurrentFinding, deliberately - the
     * two views must never disagree about whether a plot has a finding.
     */
    private isCurrentAssessment(a: RiskAssessment, plot: Plot): boolean {
        if (a.source !== "whisp_live" || a.whispVerified !== true) return false;
        if (a.supersededByGeometryChange) return false;
        const currentHash = (plot as any).geometryHash ?? null;
        if (!a.geometryHash || !currentHash) return false;
        return a.geometryHash === currentHash;
    }

    /**
     * A review describes the current parcel only when its hash matches.
     * A review with no stored hash cannot be proven to describe this boundary, so
     * it is treated as historical (fail closed, not open).
     */
    private reviewMatchesBoundary(review: PlotEudrReview, currentHash: string | null): boolean {
        if (!review.geometryHash || !currentHash) return false;
        return review.geometryHash === currentHash;
    }

    private toAssessmentInputs(a: RiskAssessment): AssessmentInputs {
        const w: any = a.whispData ?? {};
        const events: any[] = Array.isArray(w.annualEvents) ? w.annualEvents : [];
        const post2020 = events
            .filter(e => typeof e?.year === "number" && e.year > 2020)
            .map(e => e.year as number);

        const label =
            w.rawVerdict?.risk_pcrop ??
            w.riskPerennialCrop ??
            w.rawVerdict?.risk_acrop ??
            w.riskAnnualCrop ??
            null;

        return {
            deforestationRisk: !!a.deforestationRisk,
            riskLabel: label == null ? null : String(label),
            eufo2020Ha: w.eufo2020Ha != null ? Number(w.eufo2020Ha) : null,
            areaHa: w.areaHa != null ? Number(w.areaHa) : null,
            distAfter2020Ha: w.distAfter2020Ha != null ? Number(w.distAfter2020Ha) : null,
            gfcLossAfter2020Ha: w.gfcLossAfter2020Ha != null ? Number(w.gfcLossAfter2020Ha) : null,
            post2020EventYears: Array.from(new Set(post2020)).sort((x, y) => x - y),
            assessedAt: a.createdAt ? new Date(a.createdAt).toISOString() : null,
        };
    }

    private toReviewInputs(r: PlotEudrReview): ReviewInputs {
        return {
            decision: r.decision,
            reason: r.reason,
            reviewedByName: r.reviewedByName ?? null,
            createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
        };
    }

    private isRetryable(job: AssessmentJob): boolean {
        if (job.status === AssessmentJobStatus.FAILED) return job.retryable === true;
        if (job.status === AssessmentJobStatus.BOUNDARY_REVIEW) return false;
        return false;
    }

    /**
     * Records a review decision against a plot.
     *
     * `isFinal` is NOT taken from the request body - the controller decides it
     * from the caller's permissions, so a client cannot promote its own
     * recommendation into a decision.
     */
    async recordReview(params: {
        plotId: string;
        decision: string;
        reason: string;
        evidence?: any;
        isFinal: boolean;
        reviewer: { id: string; name: string; role: string };
    }): Promise<{ review: PlotEudrReview; plot: Plot }> {
        if (!EUDR_DECISION_VALUES.includes(params.decision)) {
            const err: any = new Error(
                `Invalid decision "${params.decision}". Expected one of: ${EUDR_DECISION_VALUES.join(", ")}.`,
            );
            err.isValidation = true;
            throw err;
        }
        const trimmed = (params.reason ?? "").trim();
        if (!trimmed) {
            const err: any = new Error("A reason is required when recording an EUDR review.");
            err.isValidation = true;
            throw err;
        }
        if (params.decision === EudrDecision.NON_COMPLIANT && trimmed.length < 10) {
            const err: any = new Error(
                "A non-compliant decision requires a substantive reason explaining the confirmed conversion or legal violation.",
            );
            err.isValidation = true;
            throw err;
        }

        const plot = await this.plotRepo.findOne({ where: { id: params.plotId } });
        if (!plot) {
            const err: any = new Error("Plot not found");
            err.isNotFound = true;
            throw err;
        }

        const currentHash: string | null = (plot as any).geometryHash ?? null;

        // Link the decision to the CURRENT verified assessment, so the audit trail
        // points at the exact satellite evidence that was reviewed.
        const assessments = await this.assessmentRepo.find({
            where: { plotId: plot.id },
            order: { createdAt: "DESC" },
        });
        const current = assessments.find(a => this.isCurrentAssessment(a, plot)) ?? null;

        const review = this.reviewRepo.create({
            plot,
            plotId: plot.id,
            farm: plot.farm,
            farmId: plot.farmId,
            riskAssessment: current ?? null,
            riskAssessmentId: current?.id ?? null,
            geometryHash: currentHash,
            geometryVersion: (plot as any).geometryVersion ?? null,
            decision: params.decision,
            isFinal: params.isFinal,
            reason: trimmed,
            evidence: params.evidence ?? null,
            reviewedByUserId: params.reviewer.id,
            reviewedByName: params.reviewer.name,
            reviewedByRole: params.reviewer.role,
        });

        const saved = await this.reviewRepo.save(review);
        return { review: saved, plot };
    }

    /** Review history for one plot, newest first (recommendations included). */
    async historyForPlot(plotId: string): Promise<PlotEudrReview[]> {
        return this.reviewRepo.find({
            where: { plotId },
            order: { createdAt: "DESC" },
        });
    }
}

export const eudrReviewService = new EudrReviewService();
