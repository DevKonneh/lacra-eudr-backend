import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Business, BusinessType, BusinessEligibility } from "../entities/Business";
import { User } from "../entities/User";
import { successResponse, errorResponse } from "../utils/response";
import { deepSanitizeUsers } from "../utils/sanitizeUser";

// DEFECT FOUND AND FIXED during this task's integration-testing pass
// (item #4: "resolve... any defects found during verification"): every
// method below that returns a Business with its `owner` relation
// (register/getMyBusiness/getAll) was serializing the FULL User entity —
// including the bcrypt password HASH — directly into the JSON response.
// Confirmed live via a real HTTP integration test against the running
// staging server: POST /api/business/register's response body contained
// `owner.password` = a real bcrypt hash string. Not a plaintext-password
// leak (bcrypt, not reversible), but still an unnecessary sensitive-field
// exposure that other controllers in this codebase (e.g.
// UserController.getAll()) already deliberately strip. Now uses the
// shared deepSanitizeUsers() helper (see utils/sanitizeUser.ts) instead of
// an ad-hoc one-off strip, since the same User-embedding pattern turned
// out to exist in several other controllers too (License, Permit, Batch,
// Enforcement, Inspection, QualityControl — all fixed in the same pass).

export class BusinessController {
    private businessRepository = AppDataSource.getRepository(Business);
    private userRepository = AppDataSource.getRepository(User);

    async register(req: any, res: Response) {
        try {
            const { name, type, registrationNumber, kycDocuments } = req.body;
            const userId = req.user.id;

            const existingBusiness = await this.businessRepository.findOneBy({ registrationNumber });
            if (existingBusiness) {
                return errorResponse(res, "Business with this registration number already exists", [], 400);
            }

            let eligibility = BusinessEligibility.NONE;
            if (type === BusinessType.EXPORTER) {
                eligibility = BusinessEligibility.LICENSE_ALLOWED;
            } else if ([BusinessType.LOCAL_BUYER, BusinessType.AGENCY, BusinessType.COOPERATIVE, BusinessType.TRANSPORTER, BusinessType.WAREHOUSE].includes(type)) {
                eligibility = BusinessEligibility.PERMIT_ALLOWED;
            }

            const user = await this.userRepository.findOneBy({ id: userId });
            if (!user) return errorResponse(res, "User not found", [], 404);

            const business = this.businessRepository.create({
                name,
                type,
                registrationNumber,
                kycDocuments,
                eligibility,
                owner: user
            });

            await this.businessRepository.save(business);
            return successResponse(res, deepSanitizeUsers(business), "Business registered successfully", 201);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error registering business", [error.message], 500);
        }
    }

    async getMyBusiness(req: any, res: Response) {
        try {
            const userId = req.user.id;
            const business = await this.businessRepository.findOne({
                where: { owner: { id: userId } },
                relations: ["owner", "licenses", "permits"]
            });
            if (!business) return errorResponse(res, "No business profile found", [], 404);
            return successResponse(res, deepSanitizeUsers(business));
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error fetching business profile", [error.message], 500);
        }
    }

    async getAll(req: Request, res: Response) {
        try {
            const businesses = await this.businessRepository.find({ relations: ["owner"] });
            return successResponse(res, deepSanitizeUsers(businesses));
        } catch (error: any) {
            return errorResponse(res, "Error fetching businesses", [error.message], 500);
        }
    }
}
