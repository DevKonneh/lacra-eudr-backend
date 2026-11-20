import { Request, Response } from "express";
import { assessmentQueue } from "../services/AssessmentQueueService";
import { plotAssessmentView } from "../services/PlotAssessmentView";
import { successResponse, errorResponse } from "../utils/response";

/**
 * Staff-facing API for automatic per-plot satellite assessment.
 *
 * WHAT STAFF CAN DO HERE
 * ----------------------
 *   - see every plot on a farm with its assessment status and deforestation
 *     finding, without having started anything themselves
 *   - see WHY a plot is parked in 'boundary_review' (missing/invalid/generated
 *     boundary) rather than being sent to WhISP
 *   - see which plots are still queued/assessing, and which failed
 *   - manually retry a failed check (authorised roles only, enforced by route
 *     middleware)
 *
 * DELIBERATELY READ-ONLY EXCEPT RETRY: nothing here lets staff inject or edit a
 * risk finding. Verdicts come from WhISP only; this API surfaces them.
 */
export class AssessmentQueueController {
    /** Full per-plot assessment view for one farm. */
    async forFarm(req: Request, res: Response) {
        try {
            const { farmId } = req.params;
            const view = await plotAssessmentView.forFarm(farmId);
            if (!view) return errorResponse(res, "Farm not found", [], 404);
            return successResponse(res, view);
        } catch (error: any) {
            console.error("Error building plot assessment view:", error);
            return errorResponse(res, "Error fetching plot assessment status", [error.message], 500);
        }
    }

    /** Queue overview: what is still queued or running across the platform. */
    async outstanding(req: Request, res: Response) {
        try {
            const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;
            const jobs = await plotAssessmentView.outstanding(Number.isFinite(limit) ? limit : 100);
            return successResponse(res, jobs);
        } catch (error: any) {
            return errorResponse(res, "Error fetching assessment queue", [error.message], 500);
        }
    }

    /**
     * Manual retry for a plot whose automatic check failed.
     *
     * Re-enqueues rather than re-running inline, so the HTTP request does not
     * wait on WhISP (which can take up to ~90s). The response reports the job's
     * new state; staff watch progress in the panel.
     */
    async retryPlot(req: Request, res: Response) {
        try {
            const { plotId } = req.params;
            const result = await assessmentQueue.retryForPlot(plotId);

            if (!result.job) {
                return errorResponse(
                    res,
                    "This plot could not be queued for assessment.",
                    [result.eligibility.eligible ? "Unknown error." : result.eligibility.reason],
                    400,
                );
            }

            if (!result.eligibility.eligible) {
                // Honest response: nothing was sent to WhISP because the
                // boundary is not assessable, and here is exactly why.
                return successResponse(
                    res,
                    {
                        jobId: result.job.id,
                        status: result.job.status,
                        boundaryReviewReason: result.eligibility.reason,
                    },
                    "Boundary review required before this plot can be assessed.",
                    202,
                );
            }

            return successResponse(
                res,
                { jobId: result.job.id, status: result.job.status, created: result.created },
                result.created ? "Assessment queued." : "An assessment for this boundary is already queued or complete.",
                202,
            );
        } catch (error: any) {
            console.error("Error retrying plot assessment:", error);
            return errorResponse(res, "Error queuing assessment", [error.message], 500);
        }
    }

    /** Retry a specific job by id (the queue's own identifier). */
    async retryJob(req: Request, res: Response) {
        try {
            const { jobId } = req.params;
            const job = await assessmentQueue.retryJob(jobId);
            if (!job) return errorResponse(res, "Assessment job not found", [], 404);
            return successResponse(res, job, "Assessment re-queued.", 202);
        } catch (error: any) {
            return errorResponse(res, "Error re-queueing assessment", [error.message], 500);
        }
    }
}
