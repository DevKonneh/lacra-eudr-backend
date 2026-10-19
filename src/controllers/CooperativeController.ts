import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Cooperative } from "../entities/Cooperative";
import { successResponse, errorResponse } from "../utils/response";

/**
 * Read-mostly access to the CDA cooperative registry (see Cooperative.ts
 * and scripts/seedCooperatives.ts). Left publicly reachable (no
 * authMiddleware) deliberately: this is non-sensitive published
 * reference data (cooperative names/locations/membership counts, same
 * as what CDA's own letter already discloses), and it needs to be
 * usable from the ADMIN-panel's public self-service farmer registration
 * page (/register, which has no login) as well as every authenticated
 * flow (mobile app, admin RegisterFarmer.tsx).
 */
export class CooperativeController {
    private cooperativeRepository = AppDataSource.getRepository(Cooperative);

    /**
     * Returns every active cooperative, optionally narrowed by county
     * and/or commodity (?county=Bong&commodity=Cocoa), for the
     * searchable picker on both mobile and admin-panel registration
     * forms. Intentionally returns the full active set when no filters
     * are given (same as the old hardcoded dataset's `entries` list) so
     * the existing client-side substring search keeps working unchanged
     * — filters here are a lightweight server-side narrowing, not a
     * replacement for client search.
     */
    async getAll(req: Request, res: Response) {
        try {
            const { county, commodity } = req.query;

            const qb = this.cooperativeRepository
                .createQueryBuilder("coop")
                .where("coop.isActive = :active", { active: true });

            if (county && typeof county === "string") {
                qb.andWhere("coop.county ILIKE :county", { county });
            }
            if (commodity && typeof commodity === "string") {
                // simple-array is stored as a comma-joined string column;
                // ILIKE substring match is sufficient for a short,
                // controlled vocabulary (Cocoa/Oil Palm/Rubber/Coffee).
                qb.andWhere("coop.commodities ILIKE :commodity", { commodity: `%${commodity}%` });
            }

            const cooperatives = await qb.orderBy("coop.name", "ASC").getMany();
            return successResponse(res, cooperatives);
        } catch (error: any) {
            console.error("Error fetching cooperatives:", error);
            return errorResponse(res, "Error fetching cooperatives", [error.message], 500);
        }
    }

    async getOne(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const cooperative = await this.cooperativeRepository.findOne({ where: { id } });
            if (!cooperative) return errorResponse(res, "Cooperative not found", [], 404);
            return successResponse(res, cooperative);
        } catch (error: any) {
            console.error("Error fetching cooperative:", error);
            return errorResponse(res, "Error fetching cooperative", [error.message], 500);
        }
    }
}
