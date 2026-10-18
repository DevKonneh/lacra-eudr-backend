import { Request, Response } from "express";
import { RiskService } from "../services/RiskService";
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

    async seedForests(req: Request, res: Response) {
        try {
            const result = await this.riskService.seedForests();
            return successResponse(res, result, `Forest reference dataset seeded: ${result.created} created, ${result.updated} updated, ${result.total} total.`);
        } catch (error: any) {
            return errorResponse(res, error.message, [error.message], 500);
        }
    }
}
