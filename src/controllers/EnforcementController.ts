import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { EnforcementAction } from "../entities/EnforcementAction";
import { successResponse, errorResponse } from "../utils/response";

export class EnforcementController {
    private repository = AppDataSource.getRepository(EnforcementAction);

    async getAll(req: Request, res: Response) {
        try {
            const items = await this.repository.find({
                relations: ["officer", "inspection", "qualityControl"],
                order: { createdAt: "DESC" }
            });
            return successResponse(res, items);
        } catch (error: any) {
            return errorResponse(res, "Error fetching enforcement actions", [error.message], 500);
        }
    }

    async create(req: Request, res: Response) {
        try {
            const saved = await this.repository.save({
                ...req.body,
                officer: { id: (req as any).user.id }
            });
            return successResponse(res, saved, "Enforcement action recorded", 201);
        } catch (error: any) {
            return errorResponse(res, "Error recording enforcement action", [error.message], 500);
        }
    }
}
