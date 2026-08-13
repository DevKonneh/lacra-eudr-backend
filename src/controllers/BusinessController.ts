import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Business, BusinessType, BusinessEligibility } from "../entities/Business";
import { User } from "../entities/User";
import { successResponse, errorResponse } from "../utils/response";

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
            return successResponse(res, business, "Business registered successfully", 201);
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
            return successResponse(res, business);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error fetching business profile", [error.message], 500);
        }
    }

    async getAll(req: Request, res: Response) {
        try {
            const businesses = await this.businessRepository.find({ relations: ["owner"] });
            return successResponse(res, businesses);
        } catch (error: any) {
            return errorResponse(res, "Error fetching businesses", [error.message], 500);
        }
    }

    async updateStatus(req: Request, res: Response) {
        // Placeholder for future admin verification logic
        return errorResponse(res, "Not implemented", [], 501);
    }
}
