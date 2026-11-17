import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { EnforcementAction } from "../entities/EnforcementAction";
import { successResponse, errorResponse } from "../utils/response";
import { deepSanitizeUsers } from "../utils/sanitizeUser";

export class EnforcementController {
    private repository = AppDataSource.getRepository(EnforcementAction);

    async getAll(req: Request, res: Response) {
        try {
            const items = await this.repository.find({
                relations: ["officer", "inspection", "qualityControl"],
                order: { createdAt: "DESC" }
            });
            // DEFECT FOUND AND FIXED: `officer` is the enforcing staff
            // member's full User entity (bcrypt password hash included) —
            // this endpoint previously serialized it straight into the
            // JSON response. See utils/sanitizeUser.ts for the full
            // rationale.
            return successResponse(res, deepSanitizeUsers(items));
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
