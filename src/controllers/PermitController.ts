import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Permit, PermitStatus } from "../entities/Permit";
import { Business, BusinessEligibility } from "../entities/Business";
import { successResponse, errorResponse } from "../utils/response";

// Fields the applicant is allowed to set themselves, matching LACRA Form
// No. 0050 Sections A-D. Kept as an explicit whitelist (rather than
// spreading req.body directly onto the entity) so applicants can never set
// internal/staff-only fields like status, permitNumber, or internalRemarks
// through this endpoint.
const APPLICANT_FIELDS = [
    // Section A — Applicant Information
    "businessName", "typeOfEntity", "tinNumber", "county", "district",
    "businessAddress", "contactPerson", "phoneNumber", "emailAddress", "whatsapp",
    // Section B — Ownership and Management
    "ownerManagerName", "dateOfBirth", "gender", "placeOfBirth", "nationality",
    "position", "idType", "idNumber",
    // Section C — Operational Information
    "intendedCommodities", "estimatedPurchaseVolume", "warehousingLocation",
    "expectedAreasOfOperation",
    // Section D — Declaration
    "declarationAccepted", "declarationName", "declarationDate"
] as const;

function pickApplicantFields(body: any): Partial<Permit> {
    const data: any = {};
    for (const field of APPLICANT_FIELDS) {
        if (body[field] !== undefined) {
            data[field] = body[field];
        }
    }
    // Date fields arrive as ISO strings over JSON; coerce explicitly.
    if (data.dateOfBirth) data.dateOfBirth = new Date(data.dateOfBirth);
    if (data.declarationDate) data.declarationDate = new Date(data.declarationDate);
    return data;
}

/**
 * Required-field check for final submission (Section A/B/C "Yes" required
 * fields per Form No. 0050, plus the Section D declaration). Draft saves are
 * intentionally NOT validated this strictly, so an applicant can save
 * partial progress — only submit() enforces completeness.
 */
function findMissingRequiredFields(permit: Permit): string[] {
    const required: Array<[keyof Permit, string]> = [
        ["businessName", "Business Name"],
        ["typeOfEntity", "Type of Entity"],
        ["tinNumber", "TIN Number"],
        ["county", "County / District"],
        ["businessAddress", "Business Address"],
        ["contactPerson", "Contact Person"],
        ["phoneNumber", "Phone Number"],
        ["ownerManagerName", "Owner/Manager Name(s)"],
        ["dateOfBirth", "Date of Birth"],
        ["gender", "Gender"],
        ["placeOfBirth", "Place of Birth"],
        ["nationality", "Nationality"],
        ["position", "Position"],
        ["idType", "ID Type"],
        ["idNumber", "ID Number"],
        ["intendedCommodities", "Intended Commodity"],
        ["estimatedPurchaseVolume", "Estimated Purchase Volume"],
        ["warehousingLocation", "Warehousing Location"],
        ["expectedAreasOfOperation", "Expected Areas of Operation"],
        ["declarationName", "Declaration: Name of Applicant"],
    ];
    const missing: string[] = [];
    for (const [key, label] of required) {
        const value: any = (permit as any)[key];
        if (value === null || value === undefined || value === "" ||
            (Array.isArray(value) && value.length === 0)) {
            missing.push(label);
        }
    }
    if (!permit.declarationAccepted) {
        missing.push("Declaration acceptance");
    }
    return missing;
}

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

            const applicantData = pickApplicantFields(req.body || {});

            const permit = this.permitRepository.create({
                business,
                status: PermitStatus.DRAFT,
                documents: [],
                // Pre-fill from the Business Registry where the paper form's
                // Section A overlaps with what was already captured at
                // business registration, so the applicant doesn't retype it.
                businessName: business.name,
                ...applicantData
            });

            await this.permitRepository.save(permit);
            return successResponse(res, permit, "Permit application draft created successfully", 201);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error creating permit application", [error.message], 500);
        }
    }

    async getOne(req: any, res: Response) {
        try {
            const { id } = req.params;
            const permit = await this.permitRepository.findOne({
                where: { id },
                relations: ["business", "business.owner"]
            });
            if (!permit) return errorResponse(res, "Permit not found", [], 404);
            return successResponse(res, permit);
        } catch (error: any) {
            return errorResponse(res, "Error fetching permit", [error.message], 500);
        }
    }

    // Save/edit form fields on a Draft (or a Returned-for-Correction) permit.
    // This is what the online form's "Save" button calls while the applicant
    // is filling in Sections A-D — separate from submit(), which locks it in.
    async update(req: any, res: Response) {
        try {
            const { id } = req.params;
            const permit = await this.permitRepository.findOneBy({ id });
            if (!permit) return errorResponse(res, "Permit not found", [], 404);

            if (permit.status !== PermitStatus.DRAFT && permit.status !== PermitStatus.RETURNED_FOR_CORRECTION) {
                return errorResponse(res, "Cannot edit permit application in current status", [], 400);
            }

            const applicantData = pickApplicantFields(req.body || {});
            Object.assign(permit, applicantData);

            await this.permitRepository.save(permit);
            return successResponse(res, permit, "Permit application saved");
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error updating permit application", [error.message], 500);
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

            // Mirrors Form No. 0050's Sections A-D being fully filled in before
            // it can be handed over the counter — an incomplete online form
            // should not be allowed to reach Commercial & Marketing review.
            const missing = findMissingRequiredFields(permit);
            if (missing.length > 0) {
                return errorResponse(
                    res,
                    "Please complete all required fields before submitting",
                    missing,
                    400
                );
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
