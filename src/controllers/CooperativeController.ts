import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Cooperative } from "../entities/Cooperative";
import { successResponse, errorResponse } from "../utils/response";
import { CDA_COOPERATIVE_SEED_DATA } from "../data/cdaCooperativeSeedData";

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

    /**
     * ADMIN-only: (re-)seeds the Cooperative table from the embedded CDA
     * registry data (src/data/cdaCooperativeSeedData.ts - 95 cooperatives
     * parsed from the official "CDA COOPERATIVE LISTING 2025" letter).
     *
     * Exists specifically so production can be seeded over HTTP by an
     * admin, without needing direct database/shell access to the Render
     * instance - call once after deploy:
     *   POST /api/cooperatives/seed  (Authorization: Bearer <admin token>)
     *
     * Idempotent: upserts by `slug`, identical logic to the standalone
     * seedCooperatives.ts script (safe to call again later if the
     * registry data is corrected and redeployed - it will update
     * existing rows rather than duplicate them).
     */
    async seed(req: Request, res: Response) {
        try {
            let created = 0;
            let updated = 0;

            for (const rec of CDA_COOPERATIVE_SEED_DATA) {
                let coop = await this.cooperativeRepository.findOne({ where: { slug: rec.id } });
                const isNew = !coop;
                if (!coop) coop = new Cooperative();

                coop.slug = rec.id;
                coop.name = rec.name;
                coop.county = rec.county || undefined as any;
                coop.location = rec.location || undefined as any;
                coop.commodities = rec.commodities;
                coop.membershipTotal = rec.membership.total;
                coop.membershipMale = rec.membership.male;
                coop.membershipFemale = rec.membership.female;
                coop.contactName = rec.contact.name || undefined as any;
                coop.contactRole = rec.contact.role || undefined as any;
                coop.contactPhones = rec.contact.phones;
                coop.rawMembership = rec.membership.raw || undefined as any;
                coop.rawContact = rec.contact.raw || undefined as any;
                coop.isActive = true;

                await this.cooperativeRepository.save(coop);
                if (isNew) created++; else updated++;
            }

            const total = await this.cooperativeRepository.count();
            return successResponse(res, { created, updated, total });
        } catch (error: any) {
            console.error("Error seeding cooperatives:", error);
            return errorResponse(res, "Error seeding cooperatives", [error.message], 500);
        }
    }
}
