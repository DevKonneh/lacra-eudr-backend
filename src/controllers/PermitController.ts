import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Permit, PermitStatus } from "../entities/Permit";
import { Business, BusinessEligibility } from "../entities/Business";
import { successResponse, errorResponse } from "../utils/response";


export class PermitController {
    private permitRepository = AppDataSource.getRepository(Permit);
    private businessRepository = AppDataSource.getRepository(Business);

    async create(req: any, res: Response) {
        try {
            const userId = req.user.id;
            const business = await this.businessRepository.findOne({ where: { owner: { id: userId } } });

            if (!business) return errorResponse(res, "Business profile not found", [], 404);

            if (business.eligibility !== BusinessEligibility.PERMIT_ALLOWED) {
                return errorResponse(res, "Your business type is not eligible for Permits", [], 403);
            }

            const permit = this.permitRepository.create({
                business,
                status: PermitStatus.DRAFT,
                documents: []
            });

            await this.permitRepository.save(permit);
            return successResponse(res, permit, "Permit creating successfully", 201);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error creating permit application", [error.message], 500);
        }
    }

    async submit(req: any, res: Response) {
        try {
            const { id } = req.params;
            const permit = await this.permitRepository.findOneBy({ id });

            if (!permit) return errorResponse(res, "Permit not found", [], 404);

            // Should verify ownership here too in real app

            if (permit.status !== PermitStatus.DRAFT && permit.status !== PermitStatus.RETURNED_FOR_CORRECTION) {
                return errorResponse(res, "Cannot submit permit in current status", [], 400);
            }

            permit.status = PermitStatus.SUBMITTED;
            await this.permitRepository.save(permit);
            return successResponse(res, permit);
        } catch (error: any) {
            return errorResponse(res, "Error submitting permit", [error.message], 500);
        }
    }

    // Commercial Review
    async recommend(req: any, res: Response) {
        try {
            const { id } = req.params;
            const permit = await this.permitRepository.findOneBy({ id });
            if (!permit) return errorResponse(res, "Permit not found", [], 404);

            permit.status = PermitStatus.RECOMMENDED_TO_DG;
            await this.permitRepository.save(permit);
            return successResponse(res, permit);
        } catch (error: any) {
            return errorResponse(res, "Error recommending permit", [error.message], 500);
        }
    }

    // DG Decision
    async approve(req: any, res: Response) {
        try {
            const { id } = req.params;
            const permit = await this.permitRepository.findOneBy({ id });
            if (!permit) return errorResponse(res, "Permit not found", [], 404);

            permit.status = PermitStatus.DG_APPROVED;
            await this.permitRepository.save(permit);
            return successResponse(res, permit);
        } catch (error: any) {
            return errorResponse(res, "Error approving permit", [error.message], 500);
        }
    }

    // Finance/Issuance
    async issue(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { validFrom, validTo } = req.body;
            const permit = await this.permitRepository.findOneBy({ id });
            if (!permit) return errorResponse(res, "Permit not found", [], 404);

            permit.status = PermitStatus.PERMIT_ISSUED;

            // Generate Permit Number
            const count = await this.permitRepository.count();
            permit.permitNumber = `PER-${new Date().getFullYear()}-${(count + 1).toString().padStart(4, '0')}`;

            permit.validFrom = validFrom ? new Date(validFrom) : new Date();
            permit.validTo = validTo ? new Date(validTo) : new Date(new Date().setFullYear(new Date().getFullYear() + 1));

            await this.permitRepository.save(permit);
            return successResponse(res, permit);
        } catch (error: any) {
            return errorResponse(res, "Error issuing permit", [error.message], 500);
        }
    }

    async getAll(req: Request, res: Response) {
        try {
            const permits = await this.permitRepository.find({ relations: ["business"] });
            return successResponse(res, permits);
        } catch (error: any) {
            return errorResponse(res, "Error fetching permits", [error.message], 500);
        }
    }
}
