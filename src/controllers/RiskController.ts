import { Request, Response } from "express";
import { RiskService } from "../services/RiskService";
import { WhispUnavailableError } from "../services/WhispService";
import { successResponse, errorResponse } from "../utils/response";

export class RiskController {
    private riskService = new RiskService();

    async assessRisk(req: Request, res: Response) {
        try {
            const farmId = req.params.farmId || req.body?.farmId;

            if (!farmId) {
                return errorResponse(res, "Farm ID is required", [], 400);
            }

            const result = await this.riskService.analyzeFarm(farmId);
            return successResponse(res, result);
        } catch (error: any) {
            // Geometry validation blocking compliance analysis is a client-
            // correctable condition (bad/missing boundary), not a server
            // error — surface it as 400 with the full validation detail so
            // the frontend can show exactly what needs fixing.
            if (error.isGeometryValidationError) {
                return errorResponse(res, error.message, [error.geometryValidationResult || error.message], 400);
            }

            // A failed/unavailable satellite assessment is NOT a server crash and
            // MUST NOT read as success. It gets its own status, a machine-readable
            // code and an explicit `retryable` flag so the UI can say
            // "no assessment was recorded" rather than showing a stale or blank
            // verdict as if the run had worked.
            if (error instanceof WhispUnavailableError) {
                return res.status(error.httpStatus ?? 502).json({
                    status: false,
                    message: error.message,
                    errors: [{
                        code: error.code,
                        retryable: error.retryable,
                        assessmentRecorded: false,
                    }],
                    data: {
                        code: error.code,
                        retryable: error.retryable,
                        assessmentRecorded: false,
                    },
                });
            }

            return errorResponse(res, error.message, [error.message], 500);
        }
    }

    async getHistory(req: Request, res: Response) {
        try {
            const { farmId } = req.params;
            const history = await this.riskService.getHistory(farmId);
            return successResponse(res, history);
        } catch (error: any) {
            return errorResponse(res, error.message, [error.message], 500);
        }
    }

    /**
     * Failed assessment attempts for a farm. Makes "this farm has no verified
     * assessment, and here is why" visible to staff instead of silent.
     */
    async getAttempts(req: Request, res: Response) {
        try {
            const { farmId } = req.params;
            const attempts = await this.riskService.getAttempts(farmId);
            return successResponse(res, attempts);
        } catch (error: any) {
            return errorResponse(res, error.message, [error.message], 500);
        }
    }

    /**
     * Assessments whose provenance cannot be verified (legacy rows and any
     * mock-sourced row). Originals are retained; this is a review queue.
     */
    async getFlaggedAssessments(req: Request, res: Response) {
        try {
            const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
            const flagged = await this.riskService.getFlaggedAssessments(
                Number.isFinite(limit as number) ? (limit as number) : undefined
            );
            return successResponse(res, flagged);
        } catch (error: any) {
            return errorResponse(res, error.message, [error.message], 500);
        }
    }

    async seedForests(req: Request, res: Response) {
        try {
            const result = await this.riskService.seedForests();
            return successResponse(res, result, `Forest reference dataset seeded: ${result.created} created, ${result.updated} updated, ${result.total} total.`);
        } catch (error: any) {
            return errorResponse(res, error.message, [error.message], 500);
        }
    }
}
