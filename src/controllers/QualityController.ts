import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { QualityControl } from "../entities/QualityControl";
import { successResponse, errorResponse } from "../utils/response";
import { deepSanitizeUsers } from "../utils/sanitizeUser";

export class QualityController {
    private repository = AppDataSource.getRepository(QualityControl);

    async getAll(req: Request, res: Response) {
        try {
            const items = await this.repository.find({
                relations: ["inspector", "batch"],
                order: { createdAt: "DESC" }
            });
            // DEFECT FOUND AND FIXED: `inspector` is the full User entity
            // (bcrypt password hash included) — this endpoint previously
            // serialized it straight into the JSON response. See
            // utils/sanitizeUser.ts for the full rationale.
            return successResponse(res, deepSanitizeUsers(items));
        } catch (error: any) {
            return errorResponse(res, "Error fetching QC records", [error.message], 500);
        }
    }

    async create(req: Request, res: Response) {
        try {
            const saved = await this.repository.save({
                ...req.body,
                inspector: { id: (req as any).user.id }
            });
            return successResponse(res, saved, "QC check recorded", 201);
        } catch (error: any) {
            return errorResponse(res, "Error recording QC check", [error.message], 500);
        }
    }
}
