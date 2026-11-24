import { Request, Response } from "express";
import { eudrReviewService } from "../services/EudrReviewService";
import { canIssueFinalEudrDecision, EUDR_REVIEW_PERMISSION } from "../middleware/eudrReview.middleware";
import { successResponse, errorResponse } from "../utils/response";

/**
 * Staff-facing API for the EUDR assessment view and review decisions.
 *
 * TWO WRITE LEVELS, ONE ENDPOINT
 * ------------------------------
 * A POST to /review/plot/:plotId records either:
 *   - a RECOMMENDATION (isFinal = false), for inspectors: evidence and a
 *     suggested outcome. Stored and shown, but it changes nothing on its own.
 *   - a FINAL DECISION (isFinal = true), only for holders of the EUDR review
 *     permission. This is what clears or condemns a plot.
 *
 * `isFinal` is derived HERE from the caller's permissions and never read from the
 * request body. That is the whole point of the permission: a client must not be
 * able to promote its own recommendation into a decision by sending a flag.
 *
 * WHAT THIS API DELIBERATELY CANNOT DO
 * ------------------------------------
 * It cannot create, edit or delete a WhISP result. Satellite evidence is
 * upstream and immutable here; the review layer only records human judgement
 * ABOUT it, linked to the specific assessment it considered.
 */
export class EudrReviewController {
    /** Full EUDR assessment view for one farm (plots + farm rollup). */
    async forFarm(req: Request, res: Response) {
        try {
            const { farmId } = req.params;
            const view = await eudrReviewService.forFarm(farmId);
            if (!view) return errorResponse(res, "Farm not found", [], 404);
            return successResponse(res, view);
        } catch (error: any) {
            console.error("Error building EUDR assessment view:", error);
            return errorResponse(res, "Error fetching EUDR assessment", [error.message], 500);
        }
    }

    /** Review history for one plot, newest first. */
    async historyForPlot(req: Request, res: Response) {
        try {
            const { plotId } = req.params;
            const rows = await eudrReviewService.historyForPlot(plotId);
            return successResponse(res, rows);
        } catch (error: any) {
            return errorResponse(res, "Error fetching review history", [error.message], 500);
        }
    }

    /**
     * Records a review against a plot.
     *
     * Body: { decision, reason, evidence?, final? }
     *   - `final: true` requests a FINAL decision. It is only honoured when the
     *     caller holds the EUDR review permission; otherwise the request is
     *     rejected outright rather than silently downgraded, because a reviewer
     *     who believes they issued a decision must not be told it succeeded when
     *     it was only recorded as a recommendation.
     */
    async recordReview(req: Request, res: Response) {
        try {
            const { plotId } = req.params;
            const { decision, reason, evidence, final } = req.body ?? {};

            if (!decision) {
                return errorResponse(res, "Missing 'decision'", [
                    "Provide one of: cleared, non_compliant, needs_review.",
                ], 400);
            }
            if (!reason || !String(reason).trim()) {
                return errorResponse(res, "Missing 'reason'", [
                    "A plain-language reason is required for every EUDR review.",
                ], 400);
            }

            const reviewer = (req as any).reviewer;
            const wantsFinal = final === true;

            if (wantsFinal && !canIssueFinalEudrDecision(reviewer)) {
                return errorResponse(
                    res,
                    "Forbidden: you do not hold the EUDR review permission required to issue a final decision.",
                    [
                        `Recording a final EUDR decision requires the "${EUDR_REVIEW_PERMISSION}" permission.`,
                        "You may still submit evidence and recommend an outcome (send final: false or omit it).",
                    ],
                    403,
                );
            }

            const { review, plot } = await eudrReviewService.recordReview({
                plotId,
                decision: String(decision),
                reason: String(reason),
                evidence: evidence ?? null,
                isFinal: wantsFinal,
                reviewer: {
                    id: reviewer.id,
                    name: reviewer.name,
                    role: reviewer.role,
                },
            });

            // Re-resolve so the response shows the status this decision produced,
            // rather than making the client guess.
            const view = await eudrReviewService.forFarm(plot.farmId);
            const evaluation = view?.plots.find(p => p.plotId === plot.id) ?? null;

            return successResponse(
                res,
                {
                    review: {
                        id: review.id,
                        plotId: review.plotId,
                        decision: review.decision,
                        isFinal: review.isFinal,
                        reason: review.reason,
                        riskAssessmentId: review.riskAssessmentId,
                        geometryHash: review.geometryHash,
                        geometryVersion: review.geometryVersion,
                        reviewedByName: review.reviewedByName,
                        reviewedByRole: review.reviewedByRole,
                        createdAt: review.createdAt,
                    },
                    plotStatus: evaluation,
                    farmStatus: view?.farm ?? null,
                },
                wantsFinal
                    ? "Final EUDR decision recorded."
                    : "Review recommendation recorded. A final decision by an authorised reviewer is still required.",
                201,
            );
        } catch (error: any) {
            if (error.isValidation) return errorResponse(res, error.message, [error.message], 400);
            if (error.isNotFound) return errorResponse(res, error.message, [error.message], 404);
            console.error("Error recording EUDR review:", error);
            return errorResponse(res, "Error recording EUDR review", [error.message], 500);
        }
    }
}
