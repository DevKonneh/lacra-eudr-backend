import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { License, LicenseStatus, LicenseType } from "../entities/License";
import { User, UserRole } from "../entities/User";
import { Business, BusinessEligibility } from "../entities/Business";
import { successResponse, errorResponse } from "../utils/response";

export class LicenseController {
    private licenseRepository = AppDataSource.getRepository(License);
    private businessRepository = AppDataSource.getRepository(Business);

    async apply(req: any, res: Response) {
        try {
            const { type, holderName } = req.body;
            const userId = req.user.id;

            // Check for Business Profile
            const business = await this.businessRepository.findOne({ where: { owner: { id: userId } } });
            if (!business) return errorResponse(res, "No business profile found. Please register your business first.", [], 404);

            if (business.eligibility !== BusinessEligibility.LICENSE_ALLOWED) {
                return errorResponse(res, "Your business is not eligible for Export Licenses.", [], 403);
            }

            // Generate temp license number or placeholder
            const count = await this.licenseRepository.count();
            // Draft license, number might be assigned later or now
            const licenseNumber = `DRAFT-LIC-${new Date().getFullYear()}-${(count + 1).toString().padStart(4, '0')}`;

            const license = this.licenseRepository.create({
                licenseNumber,
                type: type || LicenseType.EXPORTER, // default to Exporter or from body
                holderName: holderName || business.name,
                status: LicenseStatus.DRAFT,
                business,
                user: req.user // Keep track of who submitted
            });

            await this.licenseRepository.save(license);
            return successResponse(res, license, "License applied successfully", 201);
        } catch (error: any) {
            console.error("License Apply Error", error);
            return errorResponse(res, "Error applying for license", [error.message], 500);
        }
    }

    async submit(req: any, res: Response) {
        try {
            const { id } = req.params;
            const license = await this.licenseRepository.findOneBy({ id });
            if (!license) return errorResponse(res, "License not found", [], 404);

            if (license.status !== LicenseStatus.DRAFT && license.status !== LicenseStatus.RETURNED_FOR_CORRECTION) {
                return errorResponse(res, "Cannot submit license in current status", [], 400);
            }

            license.status = LicenseStatus.SUBMITTED;
            await this.licenseRepository.save(license);
            return successResponse(res, license);
        } catch (error: any) {
            return errorResponse(res, "Error submitting license", [error.message], 500);
        }
    }

    // Commercial Review
    async recommend(req: any, res: Response) {
        try {
            const { id } = req.params;
            const license = await this.licenseRepository.findOneBy({ id });
            if (!license) return errorResponse(res, "License not found", [], 404);

            license.status = LicenseStatus.RECOMMENDED_TO_DG;
            await this.licenseRepository.save(license);
            return successResponse(res, license);
        } catch (error: any) {
            return errorResponse(res, "Error recommending license", [error.message], 500);
        }
    }

    // DG Decision
    // Accepts an explicit `decision` in the body so the DG can either
    // approve or reject a license recommended by Commercial review.
    // Previously this always hard-coded DG_APPROVED regardless of what the
    // caller intended, so Reject (and the frontend's Suspend, which also
    // misused this same endpoint) silently approved the license instead.
    // Defaults to DG_APPROVED only when no decision is supplied, to keep
    // any existing caller that never sent a body working exactly as before.
    private static readonly VALID_DG_DECISIONS = [LicenseStatus.DG_APPROVED, LicenseStatus.DG_REJECTED];

    async approve(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { decision } = req.body || {};

            const license = await this.licenseRepository.findOneBy({ id });
            if (!license) return errorResponse(res, "License not found", [], 404);

            if (license.status !== LicenseStatus.RECOMMENDED_TO_DG) {
                return errorResponse(res, `Cannot record a DG decision while license is in status ${license.status}. It must first be recommended by Commercial review.`, [], 400);
            }

            const resolvedDecision: LicenseStatus = decision ?? LicenseStatus.DG_APPROVED;
            if (!LicenseController.VALID_DG_DECISIONS.includes(resolvedDecision)) {
                return errorResponse(res, `Invalid DG decision "${decision}". Must be one of: ${LicenseController.VALID_DG_DECISIONS.join(", ")}.`, [], 400);
            }

            license.status = resolvedDecision;
            await this.licenseRepository.save(license);
            return successResponse(res, license);
        } catch (error: any) {
            return errorResponse(res, "Error recording DG decision on license", [error.message], 500);
        }
    }

    // Suspend an already-issued license. Previously the admin panel routed
    // "Suspend" through the DG-decision endpoint (approve()), which always
    // hard-coded DG_APPROVED, so clicking Suspend silently re-approved the
    // license instead. This is now its own endpoint with its own status
    // guard so a license can only be suspended while it is actually active.
    async suspend(req: any, res: Response) {
        try {
            const { id } = req.params;
            const license = await this.licenseRepository.findOneBy({ id });
            if (!license) return errorResponse(res, "License not found", [], 404);

            if (license.status !== LicenseStatus.LICENSE_ISSUED && license.status !== LicenseStatus.ACTIVE) {
                return errorResponse(res, `Cannot suspend a license in status ${license.status}. Only an issued/active license can be suspended.`, [], 400);
            }

            license.status = LicenseStatus.SUSPENDED;
            await this.licenseRepository.save(license);
            return successResponse(res, license);
        } catch (error: any) {
            return errorResponse(res, "Error suspending license", [error.message], 500);
        }
    }

    // Finance/Issuance
    async issue(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { validFrom, validTo } = req.body;

            const license = await this.licenseRepository.findOneBy({ id });
            if (!license) return errorResponse(res, "License not found", [], 404);

            license.status = LicenseStatus.LICENSE_ISSUED;

            // Final License Number
            const count = await this.licenseRepository.count(); // Or logic to keep consistent
            license.licenseNumber = `LIC-${new Date().getFullYear()}-${(count + 1).toString().padStart(4, '0')}`;

            license.validFrom = validFrom ? new Date(validFrom) : new Date();
            license.validTo = validTo ? new Date(validTo) : new Date(new Date().setFullYear(new Date().getFullYear() + 1));

            await this.licenseRepository.save(license);
            return successResponse(res, license);
        } catch (error: any) {
            console.error("License Approve Error", error);
            return errorResponse(res, "Error issuing license", [error.message], 500);
        }
    }

    async getMyLicenses(req: any, res: Response) {
        try {
            const userId = req.user.id;
            // Get business first
            const business = await this.businessRepository.findOne({ where: { owner: { id: userId } } });

            let licenses;
            if (business) {
                licenses = await this.licenseRepository.find({
                    where: { business: { id: business.id } },
                    relations: ["business"]
                });
            } else {
                // Fallback if no business but user has licenses associated directly (legacy)
                licenses = await this.licenseRepository.find({
                    where: { user: { id: userId } }
                });
            }

            return successResponse(res, licenses);
        } catch (error: any) {
            return errorResponse(res, "Error fetching licenses", [error.message], 500);
        }
    }

    async getAll(req: Request, res: Response) {
        try {
            const licenses = await this.licenseRepository.find({ relations: ["user", "business"] });
            return successResponse(res, licenses);
        } catch (error: any) {
            return errorResponse(res, "Error fetching all licenses", [error.message], 500);
        }
    }
}
