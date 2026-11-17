import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Inspection } from "../entities/Inspection";
import { successResponse, errorResponse } from "../utils/response";
import { deepSanitizeUsers } from "../utils/sanitizeUser";

export class InspectionController {
    private repository = AppDataSource.getRepository(Inspection);

    async getAll(req: Request, res: Response) {
        try {
            const items = await this.repository.find({
                relations: ["inspector", "farm", "shipment"],
                order: { createdAt: "DESC" }
            });
            // DEFECT FOUND AND FIXED: `inspector` is the full User entity
            // (bcrypt password hash included) — this endpoint previously
            // serialized it straight into the JSON response. See
            // utils/sanitizeUser.ts for the full rationale.
            return successResponse(res, deepSanitizeUsers(items));
        } catch (error: any) {
            return errorResponse(res, "Error fetching inspections", [error.message], 500);
        }
    }

    async create(req: Request, res: Response) {
        try {
            const saved = await this.repository.save({
                ...req.body,
                inspector: { id: (req as any).user.id } // Set inspector to current user
            });
            return successResponse(res, saved, "Inspection scheduled", 201);
        } catch (error: any) {
            return errorResponse(res, "Error creating inspection", [error.message], 500);
        }
    }
}
