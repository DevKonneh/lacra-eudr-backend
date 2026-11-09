/**
 * ManualLicenseEntryService — creates a single Application + Certificate
 * pair, DIRECTLY in ISSUED status, for a license/permit that was already
 * approved and issued on paper in the past, now being backfilled into the
 * CMIS digital register by Commercial/Marketing staff.
 *
 * This is the single-record, staff-form-driven counterpart to the
 * existing batch/seed-data-driven historical importers
 * (LocalProduceBuyerImportService, AgencyImportService,
 * ExporterImportService) — it reuses the exact same "historical record,
 * not a live CMIS approval" pattern those importers established:
 *   - Application.status = ISSUED set directly (never routed through
 *     SUBMITTED -> ... -> CERTIFICATE_PRINTED).
 *   - Application.channel = OFFICE_ASSISTED, submissionMethod set to a
 *     distinct label (MANUAL_ENTRY_SUBMISSION_METHOD) so this is always
 *     clearly distinguishable from both a live Commercial-entered
 *     OFFICE_ASSISTED application (submissionMethod "Entered by
 *     Commercial") and a bulk historical import ("Historical Register
 *     Import").
 *   - Certificate.isHistoricalImport = true.
 *   - Exactly ONE audit trail row ("MANUAL_HISTORICAL_ENTRY").
 *
 * Differences from the batch importers (by design, per the approved
 * spec for this feature):
 *   - Driven by a single staff-submitted form payload, not hardcoded
 *     seed data — every field below comes from Section A (Business/
 *     Applicant Information), Section B (Ownership and Management) and
 *     Section C (Operational Information) of the manual-entry form.
 *   - Supporting documents are OPTIONAL (explicitly overriding the
 *     reference portal's "all required" language) — documentUrls may be
 *     an empty array.
 *   - The original paper license/permit number may be entered verbatim
 *     by staff (preserved EXACTLY as typed — no reformatting, padding,
 *     or prefix normalization, consistent with how the Exporter import
 *     preserved mixed EXP/EXPO prefixes and leading-zero styles) OR left
 *     blank, in which case this service auto-generates one using the
 *     SAME per-category numbering convention already used by
 *     ApplicationController.printCertificate() for a live issuance:
 *       - LOCAL_BUYER: LocalProduceBuyerNumberService's non-resetting
 *         LACRA-{3digit}-{year} running sequence.
 *       - AGENCY / EXPORTER / COOPERATIVE: the shared, yearly-resetting
 *         LACRA-CERT-{year}-{6digit} sequence (counts ALL certificate
 *         rows created in the current calendar year, regardless of
 *         category — mirrors ApplicationController.nextSequentialNumber()
 *         exactly, which already treats every non-Local-Buyer category,
 *         including COOPERATIVE, this way).
 *   - Builds Application.data in the EXACT SAME per-category shape the
 *     /apply wizard and ApplicationController.extractApplicantName()
 *     already expect (data.buyer / data.agency / data.cooperative /
 *     data.exporter, each keyed by `legalName`/`fullName` etc.), so this
 *     record is indistinguishable in shape from a live-workflow
 *     application to any code that reads Application.data generically.
 *
 * Cooperative category note: there is no existing Cooperative
 * Certificate register prior to this feature — see
 * CooperativePermitController.ts (new) for the admin-facing register
 * this feeds, and PermitVerificationController.verifyCooperativeToken()
 * (new) for its public QR verification endpoint. permitOrLicenceType
 * "COOPERATIVE" is a new discriminator value but requires NO new
 * Certificate columns — every field this register needs is already
 * generic on the entity, exactly like the Exporter Register reused the
 * Local Produce Buyer/Agency columns before it.
 */

import { AppDataSource } from "../data-source";
import { EntityManager } from "typeorm";
import { Application, ApplicationCategory, ApplicationChannel, ApplicationStatus } from "../entities/Application";
import { ApplicationStatusHistory } from "../entities/ApplicationStatusHistory";
import { Certificate } from "../entities/Certificate";
import { LocalProduceBuyerNumberService } from "./LocalProduceBuyerNumberService";
import { EXPORTER_PERMIT_TYPE } from "./ExporterImportService";
import * as crypto from "crypto";

export const MANUAL_ENTRY_SUBMISSION_METHOD = "Manually Recorded \u2014 Previously Issued";
export const COOPERATIVE_PERMIT_TYPE = "COOPERATIVE";

export type ManualEntryCategory = "LOCAL_BUYER" | "AGENCY" | "COOPERATIVE" | "EXPORTER";

const VALID_CATEGORIES: ManualEntryCategory[] = ["LOCAL_BUYER", "AGENCY", "COOPERATIVE", "EXPORTER"];

export interface ManualLicenseEntryDocument {
    key: string;
    url: string;
    name?: string;
}

export interface ManualLicenseEntryInput {
    category: ManualEntryCategory;

    // Section A — Business / Applicant Information
    businessName: string;
    tinNumber?: string;
    businessRegistrationNumber: string;
    county: string;
    district: string;
    businessAddress: string;
    contactPerson: string;
    email?: string;
    whatsapp?: string;

    // Section B — Ownership and Management
    ownerManagerName: string;
    dateOfBirth: string;
    gender: string;
    placeOfBirth: string;
    nationality: string;
    position: string;
    idType: string;
    idNumber: string;

    // Section C — Operational Information
    intendedCommodities: string[];
    estimatedAnnualPurchaseVolume: number | string;
    expectedAreasOfOperation: string;

    // Optional overrides / backfill-specific fields
    licenseNumber?: string;
    issuedOn?: string;
    validityMonths?: number;
    documents?: ManualLicenseEntryDocument[];
    notes?: string;

    // Exporter-only, OPTIONAL — Standard Basic Agreement (SBA) execution
    // status. Per LACRA's regulation, an Exporter applicant must execute
    // an SBA "before operational commencement where required as part of
    // issuance/control" — but this is a NEW tracking field being added
    // going forward, and historical paper-issued records being backfilled
    // through this form were never asked for it. Deliberately left
    // optional (not required, unlike every Section A/B/C field above) so
    // staff can record what they actually know today (checked, left
    // blank/unknown, or a free-text note on status) without blocking
    // entry of old records. Ignored for every non-EXPORTER category.
    sbaExecuted?: boolean;
    sbaNotes?: string;
}

export class ManualLicenseEntryValidationError extends Error {
    constructor(public readonly errors: string[]) {
        super(errors.join(" "));
        this.name = "ManualLicenseEntryValidationError";
    }
}

interface CategoryMapping {
    applicationCategory: ApplicationCategory;
    permitOrLicenceType: string;
    dataKey: "buyer" | "agency" | "cooperative" | "exporter";
}

function resolveCategoryMapping(category: ManualEntryCategory): CategoryMapping {
    switch (category) {
        case "LOCAL_BUYER":
            return { applicationCategory: ApplicationCategory.LOCAL_BUYER, permitOrLicenceType: "LOCAL_BUYER", dataKey: "buyer" };
        case "AGENCY":
            return { applicationCategory: ApplicationCategory.AGENCY, permitOrLicenceType: "AGENCY", dataKey: "agency" };
        case "COOPERATIVE":
            return { applicationCategory: ApplicationCategory.COOPERATIVE, permitOrLicenceType: COOPERATIVE_PERMIT_TYPE, dataKey: "cooperative" };
        case "EXPORTER":
            // Mirrors ExporterImportService's own choice: every historical
            // Exporter record is filed under ApplicationCategory.LOCAL_EXPORTER
            // / permitOrLicenceType EXPORTER_PERMIT_TYPE, since the Exporter
            // Register itself has no Local/Foreign column or filter.
            return { applicationCategory: ApplicationCategory.LOCAL_EXPORTER, permitOrLicenceType: EXPORTER_PERMIT_TYPE, dataKey: "exporter" };
    }
}

function validate(input: ManualLicenseEntryInput): string[] {
    const errors: string[] = [];
    const req = (val: any, label: string) => {
        if (val === undefined || val === null || (typeof val === "string" && !val.trim())) {
            errors.push(`${label} is required.`);
        }
    };

    if (!input.category || !VALID_CATEGORIES.includes(input.category)) {
        errors.push(`category must be one of: ${VALID_CATEGORIES.join(", ")}.`);
    }

    // Section A
    req(input.businessName, "Business name");
    req(input.businessRegistrationNumber, "Business registration number");
    req(input.county, "County");
    req(input.district, "District");
    req(input.businessAddress, "Business address");
    req(input.contactPerson, "Contact person");

    // Section B — all required per spec
    req(input.ownerManagerName, "Owner/manager name");
    req(input.dateOfBirth, "Date of birth");
    req(input.gender, "Gender");
    req(input.placeOfBirth, "Place of birth");
    req(input.nationality, "Nationality");
    req(input.position, "Position");
    req(input.idType, "ID type");
    req(input.idNumber, "ID number");

    // Section C — all required per spec
    if (!Array.isArray(input.intendedCommodities) || input.intendedCommodities.length === 0) {
        errors.push("At least one intended commodity is required.");
    }
    if (input.estimatedAnnualPurchaseVolume === undefined || input.estimatedAnnualPurchaseVolume === null || input.estimatedAnnualPurchaseVolume === "") {
        errors.push("Estimated annual purchase volume is required.");
    } else if (Number.isNaN(Number(input.estimatedAnnualPurchaseVolume)) || Number(input.estimatedAnnualPurchaseVolume) < 0) {
        errors.push("Estimated annual purchase volume must be a non-negative number.");
    }
    req(input.expectedAreasOfOperation, "Expected areas of operation");

    return errors;
}

// Mirrors ApplicationController.nextSequentialNumber() exactly: counts ALL
// certificate rows created in the current calendar year (regardless of
// permitOrLicenceType) and returns the next LACRA-{prefix}-{year}-{6digit}
// value. Kept as a standalone copy here (rather than importing the
// ApplicationController's private method, which isn't exported) —
// LocalProduceBuyerNumberService is already a precedent for a dedicated,
// standalone numbering helper living outside ApplicationController.
async function nextSharedCertNumber(manager: EntityManager, prefix: string): Promise<string> {
    const year = new Date().getFullYear();
    const yearStart = new Date(year, 0, 1);
    const yearEnd = new Date(year + 1, 0, 1);
    const count = await manager
        .getRepository(Certificate)
        .createQueryBuilder("row")
        .where("row.createdAt >= :start AND row.createdAt < :end", { start: yearStart, end: yearEnd })
        .getCount();
    return `LACRA-${prefix}-${year}-${(count + 1).toString().padStart(6, "0")}`;
}

export class ManualLicenseEntryService {
    /**
     * Creates the Application + Certificate pair for one manually-recorded,
     * already-issued license/permit. Runs entirely inside one transaction
     * so the (possibly pessimistic-locked) number allocation and the
     * Application/Certificate/history writes commit atomically.
     */
    static async create(
        rawInput: ManualLicenseEntryInput,
        actor: { userId?: string | null; name?: string | null }
    ): Promise<{ application: Application; certificate: Certificate }> {
        const errors = validate(rawInput);
        if (errors.length > 0) {
            throw new ManualLicenseEntryValidationError(errors);
        }

        const mapping = resolveCategoryMapping(rawInput.category);
        const months = Number(rawInput.validityMonths) > 0 ? Number(rawInput.validityMonths) : 12;

        // issuedOn defaults to today when staff don't supply the original
        // paper issuance date — this is a reasonable default for a
        // historical backfill where the exact original date isn't always
        // on hand, while still letting staff enter the real date when they
        // have it so the register's Issuance/Expiration columns and the
        // public QR verification page reflect the actual paper record.
        const issuedOn = rawInput.issuedOn ? new Date(rawInput.issuedOn) : new Date();
        if (Number.isNaN(issuedOn.getTime())) {
            throw new ManualLicenseEntryValidationError(["issuedOn is not a valid date."]);
        }
        const expiresOn = new Date(issuedOn);
        expiresOn.setMonth(expiresOn.getMonth() + months);

        const sectionAB_C = {
            businessName: rawInput.businessName.trim(),
            legalName: rawInput.businessName.trim(),
            fullName: rawInput.businessName.trim(),
            tinNumber: rawInput.tinNumber?.trim() || null,
            tin: rawInput.tinNumber?.trim() || null,
            businessRegistrationNumber: rawInput.businessRegistrationNumber.trim(),
            businessRegNumber: rawInput.businessRegistrationNumber.trim(),
            county: rawInput.county.trim(),
            district: rawInput.district.trim(),
            businessAddress: rawInput.businessAddress.trim(),
            contactPerson: rawInput.contactPerson.trim(),
            email: rawInput.email?.trim() || null,
            whatsapp: rawInput.whatsapp?.trim() || null,
            ownerManagerName: rawInput.ownerManagerName.trim(),
            dateOfBirth: rawInput.dateOfBirth,
            gender: rawInput.gender,
            placeOfBirth: rawInput.placeOfBirth.trim(),
            nationality: rawInput.nationality.trim(),
            position: rawInput.position.trim(),
            idType: rawInput.idType,
            idNumber: rawInput.idNumber.trim(),
            intendedCommodities: rawInput.intendedCommodities,
            estimatedAnnualPurchaseVolume: Number(rawInput.estimatedAnnualPurchaseVolume),
            expectedAreasOfOperation: rawInput.expectedAreasOfOperation.trim(),
            documents: rawInput.documents || [],
            notes: rawInput.notes?.trim() || null,
            // Exporter-only, optional (see ManualLicenseEntryInput's doc
            // comment on sbaExecuted) — stored as null for every other
            // category regardless of what was sent, since SBA tracking
            // has no meaning outside EXPORTER.
            sbaExecuted: rawInput.category === "EXPORTER" ? !!rawInput.sbaExecuted : null,
            sbaNotes: rawInput.category === "EXPORTER" ? (rawInput.sbaNotes?.trim() || null) : null,
        };

        const { application, certificate } = await AppDataSource.transaction(async (manager) => {
            const applicationRepository = manager.getRepository(Application);
            const certificateRepository = manager.getRepository(Certificate);
            const historyRepository = manager.getRepository(ApplicationStatusHistory);

            let certificateNumber = rawInput.licenseNumber?.trim() || null;
            if (certificateNumber) {
                const clash = await certificateRepository.findOne({ where: { certificateNumber } });
                if (clash) {
                    throw new ManualLicenseEntryValidationError([
                        `License/permit number "${certificateNumber}" is already assigned to another record.`,
                    ]);
                }
            } else if (mapping.applicationCategory === ApplicationCategory.LOCAL_BUYER) {
                certificateNumber = await LocalProduceBuyerNumberService.allocateNext(manager);
            } else {
                certificateNumber = await nextSharedCertNumber(manager, "CERT");
            }

            const application = applicationRepository.create({
                category: mapping.applicationCategory,
                commodity: undefined,
                channel: ApplicationChannel.OFFICE_ASSISTED,
                submissionMethod: MANUAL_ENTRY_SUBMISSION_METHOD,
                status: ApplicationStatus.ISSUED,
                data: {
                    [mapping.dataKey]: sectionAB_C,
                },
                officeApplicantName: sectionAB_C.businessName,
                officeApplicantPhone: undefined,
                officeApplicantEmail: sectionAB_C.email || undefined,
                officeLocation: sectionAB_C.county,
                enteringOfficerName: actor.name || "Commercial and Marketing Officer",
                enteringOfficerUserId: actor.userId || undefined,
                assistedEntryReason:
                    "Manually recorded by Commercial/Marketing staff: a license/permit already approved and issued on paper, backfilled into the digital register (self-registration is not yet live).",
                applicantConsentConfirmed: false,
                submittedByUserId: actor.userId || undefined,
                submittedAt: issuedOn,
            });
            await applicationRepository.save(application);

            const certificate = certificateRepository.create({
                applicationId: application.id,
                permitOrLicenceType: mapping.permitOrLicenceType,
                certificateNumber,
                issueDate: issuedOn,
                expiryDate: expiresOn,
                verificationToken: crypto.randomUUID(),
                buyerDisplayName: sectionAB_C.businessName,
                county: sectionAB_C.county,
                locality: sectionAB_C.district || null,
                isHistoricalImport: true,
                importRawData: {
                    enteredBy: actor.name || "Commercial and Marketing Officer",
                    enteredAt: new Date().toISOString(),
                    originalLicenseNumberProvided: !!rawInput.licenseNumber?.trim(),
                    documents: sectionAB_C.documents,
                },
                printedByUserId: actor.userId || undefined,
                printedByName: actor.name || "Commercial and Marketing Officer",
                printedAt: new Date(),
                issuedAt: issuedOn,
            });
            await certificateRepository.save(certificate);

            await historyRepository.save(
                historyRepository.create({
                    applicationId: application.id,
                    action: "MANUAL_HISTORICAL_ENTRY",
                    previousStatus: undefined,
                    newStatus: ApplicationStatus.ISSUED,
                    userId: actor.userId || undefined,
                    userName: actor.name || "Commercial and Marketing Officer",
                    role: "Commercial and Marketing Officer",
                    comments: `Manually recorded as an already-issued ${rawInput.category} license/permit (number ${certificateNumber}). This is a historical record of a paper-issued license, not a live CMIS approval \u2014 no verification/approval/payment workflow was run.`,
                })
            );

            return { application, certificate };
        });

        return { application, certificate };
    }
}
