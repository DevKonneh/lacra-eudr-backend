import { Response } from "express";
import { AppDataSource } from "../data-source";
import { Application, ApplicationStatus, ApplicationChannel, ApplicationCategory } from "../entities/Application";
import { ApplicationStatusHistory } from "../entities/ApplicationStatusHistory";
import { WarehouseAssessment, WarehouseAssessmentOutcome } from "../entities/WarehouseAssessment";
import { Invoice } from "../entities/Invoice";
import { PaymentSubmission, PaymentMethod } from "../entities/PaymentSubmission";
import { Certificate } from "../entities/Certificate";
import { User, UserRole } from "../entities/User";
import { successResponse, errorResponse } from "../utils/response";
import { uploadFileToCloudinary } from "../utils/cloudUpload";
import { NotificationService } from "../services/NotificationService";

// Required-document keys per application category, kept in sync with the
// admin panel's pages/apply/documentRequirements.ts (the single source of
// truth for what applicants are asked to upload). Duplicated here
// deliberately so "Verify & Forward to DG" can be enforced server-side —
// the frontend's own gating is only a UX convenience and must never be the
// sole guard for a workflow transition. This does not add a new approval
// stage or document type; it only validates documents the applicant was
// already required to provide.
const REQUIRED_DOCUMENT_KEYS: Record<string, string[]> = {
    LOCAL_BUYER: ["nationalIdOrPassport", "businessRegistration", "passportPhoto"],
    AGENCY: ["ownerIdOrPassport", "citizenshipProof", "businessRegistration", "bankStatement", "personnelIds", "warehouseDocs"],
    COOPERATIVE: [
        "cdaCertificate", "businessRegistration", "taxClearance", "articlesOfIncorporation", "bylaws",
        "constitution", "bankStatement", "leadershipList", "farmerMemberList", "leadershipIds",
        "personnelIds", "warehouseDocs",
    ],
    LOCAL_EXPORTER: [
        "businessRegistration", "taxClearance", "bankConfirmation", "ownersIds", "citizenshipProof",
        "warehouseDocs", "qualityControlDocs", "supplierInfo",
    ],
    FOREIGN_EXPORTER: [
        "businessRegistration", "taxClearance", "bankConfirmation", "ownersIds",
        "warehouseDocs", "qualityControlDocs", "supplierInfo",
    ],
};

// Pulls a human-readable applicant/business name out of the category-
// specific `data` blob, matching ConfirmationPage.tsx's getApplicantName()
// on the frontend exactly, so internal list views show the same name the
// applicant saw on their confirmation page.
function extractApplicantName(category: string, data: any): string {
    if (!data) return "";
    switch (category) {
        case ApplicationCategory.LOCAL_BUYER:
            return data.buyer?.fullName || "";
        case ApplicationCategory.AGENCY:
            return data.agency?.legalName || "";
        case ApplicationCategory.COOPERATIVE:
            return data.cooperative?.legalName || "";
        case ApplicationCategory.LOCAL_EXPORTER:
        case ApplicationCategory.FOREIGN_EXPORTER:
            return data.exporter?.legalName || "";
        default:
            return data.declaration?.fullName || "";
    }
}

export class ApplicationController {
    private applicationRepository = AppDataSource.getRepository(Application);
    private historyRepository = AppDataSource.getRepository(ApplicationStatusHistory);
    private warehouseAssessmentRepository = AppDataSource.getRepository(WarehouseAssessment);
    private invoiceRepository = AppDataSource.getRepository(Invoice);
    private paymentRepository = AppDataSource.getRepository(PaymentSubmission);
    private certificateRepository = AppDataSource.getRepository(Certificate);
    private userRepository = AppDataSource.getRepository(User);

    // Records one immutable audit row. Called on every state-changing
    // action across the whole workflow (submission today; verification/
    // approval/return/reject/payment/certificate actions in later phases).
    private async recordHistory(params: {
        applicationId: string;
        action: string;
        previousStatus?: string | null;
        newStatus?: string | null;
        userId?: string | null;
        userName?: string | null;
        role?: string | null;
        department?: string | null;
        comments?: string | null;
        reason?: string | null;
        ipAddress?: string | null;
    }) {
        const row = this.historyRepository.create({
            applicationId: params.applicationId,
            action: params.action,
            previousStatus: params.previousStatus || undefined,
            newStatus: params.newStatus || undefined,
            userId: params.userId || undefined,
            userName: params.userName || undefined,
            role: params.role || undefined,
            department: params.department || undefined,
            comments: params.comments || undefined,
            reason: params.reason || undefined,
            ipAddress: params.ipAddress || undefined,
        });
        await this.historyRepository.save(row);
    }

    /**
     * Notifies every user in the given department role(s) that an
     * application needs their attention — called at every point an
     * application is routed into a new department's queue, so staff see
     * it via the admin panel's notification bell instead of only finding
     * it by polling their queue page. Kept best-effort: a notification
     * failure must never block the underlying workflow transition, so
     * callers fire-and-log rather than await-and-fail on this.
     */
    private async notifyQueue(roles: UserRole[], applicationNumber: string, title: string, body: string) {
        try {
            await NotificationService.createForRoles(roles, "APPLICATION_WORKFLOW", title, `${body} (${applicationNumber})`);
        } catch (error) {
            console.error("Error sending application workflow notification", error);
        }
    }

    /**
     * Generic document/photo upload used throughout the /apply wizard
     * (Step2-Step5's DocumentUpload instances). Files are uploaded to
     * Cloudinary immediately on selection — same real-upload pattern
     * FarmDocumentController already uses — rather than only being sent
     * at final submission, so a slow/failed upload surfaces to the
     * applicant right away instead of at the very end of a long form.
     *
     * No application record needs to exist yet: online applicants upload
     * documents progressively while filling in Steps 2-5, well before the
     * Application row is created at final Step 6 submission. The returned
     * URL is held in the wizard's client-side state (UploadedFile.url) and
     * only actually attached to an Application when POST /applications is
     * called.
     */
    async uploadDocument(req: any, res: Response) {
        try {
            const file = req.file as Express.Multer.File | undefined;
            if (!file) {
                return errorResponse(res, "No file provided (expected a 'file' field)", [], 400);
            }
            const url = await uploadFileToCloudinary(file);
            return successResponse(res, {
                url,
                name: file.originalname,
                size: file.size,
                type: file.mimetype,
            }, "File uploaded successfully", 201);
        } catch (error: any) {
            console.error("Application document upload error:", error);
            return errorResponse(res, "Error uploading file", [error.message], 500);
        }
    }

    /**
     * Final submission of the /apply wizard (online self-service) or the
     * office-assisted equivalent. This is the ONLY write path that creates
     * an Application row — per the spec, once created the applicant's
     * submitted `data` is treated as read-only from here on; later stages
     * (Commercial verification, DG decisions, etc, added in later phases)
     * only ever add related records/history rows and change `status`,
     * never mutate `data` in place.
     */
    async create(req: any, res: Response) {
        try {
            const {
                category,
                commodity,
                channel,
                data,
                // Office-Assisted intake fields — all optional, only present
                // when channel === OFFICE_ASSISTED.
                officeApplicantName,
                officeApplicantPhone,
                officeApplicantEmail,
                officeLocation,
                enteringOfficerName,
                assistedEntryReason,
                applicantConsentConfirmed,
            } = req.body || {};

            if (!category || !Object.values(ApplicationCategory).includes(category)) {
                return errorResponse(res, "A valid application category is required", [], 400);
            }
            if (!data || typeof data !== "object") {
                return errorResponse(res, "Application data is required", [], 400);
            }
            if (!data.declaration?.confirmTrue || !data.declaration?.signature) {
                return errorResponse(
                    res,
                    "The declaration must be completed (all confirmations checked and signature captured) before submission",
                    [],
                    400
                );
            }

            const resolvedChannel: ApplicationChannel =
                channel === ApplicationChannel.OFFICE_ASSISTED
                    ? ApplicationChannel.OFFICE_ASSISTED
                    : ApplicationChannel.ONLINE;

            if (resolvedChannel === ApplicationChannel.OFFICE_ASSISTED) {
                if (!officeApplicantName || !enteringOfficerName || !assistedEntryReason) {
                    return errorResponse(
                        res,
                        "Office-assisted applications require the applicant's name, the entering officer's name, and a reason for assisted entry",
                        [],
                        400
                    );
                }
                if (!applicantConsentConfirmed) {
                    return errorResponse(res, "Applicant consent must be confirmed for office-assisted entry", [], 400);
                }
            }

            // Sequential, human-readable application number:
            // LACRA-APP-{year}-{6-digit sequence}, e.g. LACRA-APP-2026-000001.
            // Sequence is scoped per calendar year (count of applications
            // created so far this year + 1), matching the exact example
            // format given in the spec.
            const year = new Date().getFullYear();
            const yearStart = new Date(year, 0, 1);
            const yearEnd = new Date(year + 1, 0, 1);
            const countThisYear = await this.applicationRepository
                .createQueryBuilder("app")
                .where("app.createdAt >= :start AND app.createdAt < :end", { start: yearStart, end: yearEnd })
                .getCount();
            const applicationNumber = `LACRA-APP-${year}-${(countThisYear + 1).toString().padStart(6, "0")}`;

            const now = new Date();
            const submittedByUserId = req.user?.id || null;

            const application = this.applicationRepository.create({
                applicationNumber,
                category,
                commodity: commodity || data.step1?.commodity || undefined,
                channel: resolvedChannel,
                submissionMethod: resolvedChannel === ApplicationChannel.OFFICE_ASSISTED ? "Entered by Commercial" : "Self-Service",
                status: ApplicationStatus.AWAITING_COMMERCIAL_VERIFICATION,
                data,
                officeApplicantName: resolvedChannel === ApplicationChannel.OFFICE_ASSISTED ? officeApplicantName : undefined,
                officeApplicantPhone: resolvedChannel === ApplicationChannel.OFFICE_ASSISTED ? officeApplicantPhone : undefined,
                officeApplicantEmail: resolvedChannel === ApplicationChannel.OFFICE_ASSISTED ? officeApplicantEmail : undefined,
                officeLocation: resolvedChannel === ApplicationChannel.OFFICE_ASSISTED ? officeLocation : undefined,
                enteringOfficerName: resolvedChannel === ApplicationChannel.OFFICE_ASSISTED ? enteringOfficerName : undefined,
                enteringOfficerUserId: resolvedChannel === ApplicationChannel.OFFICE_ASSISTED ? submittedByUserId : undefined,
                assistedEntryReason: resolvedChannel === ApplicationChannel.OFFICE_ASSISTED ? assistedEntryReason : undefined,
                applicantConsentConfirmed: resolvedChannel === ApplicationChannel.OFFICE_ASSISTED ? !!applicantConsentConfirmed : false,
                submittedByUserId: submittedByUserId || undefined,
                submittedAt: now,
            });

            await this.applicationRepository.save(application);

            // Two audit rows, mirroring Stage 1's two distinct events:
            // the applicant's own submission, then the system auto-routing
            // it into the Commercial work queue.
            await this.recordHistory({
                applicationId: application.id,
                action: "SUBMITTED",
                previousStatus: null,
                newStatus: ApplicationStatus.SUBMITTED,
                userId: submittedByUserId,
                userName: resolvedChannel === ApplicationChannel.OFFICE_ASSISTED ? enteringOfficerName : extractApplicantName(category, data) || "Applicant",
                role: resolvedChannel === ApplicationChannel.OFFICE_ASSISTED ? "Commercial and Marketing Officer" : "Applicant",
                comments: resolvedChannel === ApplicationChannel.OFFICE_ASSISTED
                    ? `Office-assisted application entered on behalf of ${officeApplicantName}. Reason: ${assistedEntryReason}`
                    : "Application submitted online by applicant.",
                ipAddress: req.ip,
            });
            await this.recordHistory({
                applicationId: application.id,
                action: "ROUTED_TO_COMMERCIAL",
                previousStatus: ApplicationStatus.SUBMITTED,
                newStatus: ApplicationStatus.AWAITING_COMMERCIAL_VERIFICATION,
                comments: "Automatically routed to the Commercial and Marketing work queue.",
            });

            await this.notifyQueue(
                [UserRole.COMMERCIAL],
                application.applicationNumber,
                "New application awaiting Commercial review",
                `A new ${category} application was submitted and needs Commercial verification.`
            );

            return successResponse(res, application, "Application submitted successfully", 201);
        } catch (error: any) {
            console.error("Error creating application:", error);
            return errorResponse(res, "Error submitting application", [error.message], 500);
        }
    }

    // Same best-effort officer derivation as getAll(), but from a
    // single application's already-loaded history array (used by getOne(),
    // which fetches full history anyway, so no extra query is needed here).
    private deriveAssignedOfficer(history: ApplicationStatusHistory[]): string | undefined {
        const relevant = history
            .filter((h) => h.action === "COMMERCIAL_REVIEW_STARTED" || h.action === "RESUBMITTED")
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        const last = relevant[relevant.length - 1];
        return last?.userName || undefined;
    }

    async getOne(req: any, res: Response) {
        try {
            const { id } = req.params;
            const application = await this.applicationRepository.findOne({ where: { id } });
            if (!application) {
                // Also allow lookup by the human-readable application number,
                // for internal search-by-app-number use cases.
                const byNumber = await this.applicationRepository.findOne({ where: { applicationNumber: id } });
                if (!byNumber) return errorResponse(res, "Application not found", [], 404);
                const history = await this.historyRepository.find({ where: { applicationId: byNumber.id }, order: { createdAt: "ASC" } });
                const warehouseAssessments = await this.warehouseAssessmentRepository.find({ where: { applicationId: byNumber.id }, order: { versionNumber: "ASC" } });
                const invoices = await this.invoiceRepository.find({ where: { applicationId: byNumber.id }, order: { versionNumber: "ASC" } });
                const payments = await this.paymentRepository.find({ where: { applicationId: byNumber.id }, order: { versionNumber: "ASC" } });
                const certificate = await this.certificateRepository.findOne({ where: { applicationId: byNumber.id } });
                const assignedOfficer = this.deriveAssignedOfficer(history);
                return successResponse(res, { ...byNumber, history, warehouseAssessments, invoices, payments, certificate, assignedOfficer });
            }
            const history = await this.historyRepository.find({ where: { applicationId: application.id }, order: { createdAt: "ASC" } });
            const warehouseAssessments = await this.warehouseAssessmentRepository.find({ where: { applicationId: application.id }, order: { versionNumber: "ASC" } });
            const invoices = await this.invoiceRepository.find({ where: { applicationId: application.id }, order: { versionNumber: "ASC" } });
            const payments = await this.paymentRepository.find({ where: { applicationId: application.id }, order: { versionNumber: "ASC" } });
            const certificate = await this.certificateRepository.findOne({ where: { applicationId: application.id } });
            const assignedOfficer = this.deriveAssignedOfficer(history);
            return successResponse(res, { ...application, history, warehouseAssessments, invoices, payments, certificate, assignedOfficer });
        } catch (error: any) {
            return errorResponse(res, "Error fetching application", [error.message], 500);
        }
    }

    // -----------------------------------------------------------------
    // Stage 2: Commercial and Marketing verification + First DG Approval.
    // Each action below loads the application, checks it is currently in
    // the expected pre-condition status (returns 409 if not — guards
    // against a stale queue UI double-firing an action, or two staff
    // members acting on the same application at once), applies the
    // transition, and records exactly one audit row via recordHistory().
    // -----------------------------------------------------------------

    private async loadApplicationOr404(id: string, res: Response): Promise<Application | null> {
        const application = await this.applicationRepository.findOne({ where: { id } });
        if (!application) {
            errorResponse(res, "Application not found", [], 404);
            return null;
        }
        return application;
    }

    private requireStatus(application: Application, expected: ApplicationStatus[], res: Response): boolean {
        if (!expected.includes(application.status)) {
            errorResponse(
                res,
                `This action cannot be performed while the application is in status "${application.status}".`,
                [],
                409
            );
            return false;
        }
        return true;
    }

    /**
     * Commercial officer opens an application and starts working on it.
     * Also accepts RETURNED_TO_COMMERCIAL (the DG sent it back for more
     * work) — this was previously a dead end with no way back into an
     * active review, even though dgReturn() already routes it into this
     * exact queue. No new status/stage is introduced; this just lets an
     * existing status actually be acted on.
     */
    async startCommercialReview(req: any, res: Response) {
        try {
            const { id } = req.params;
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(
                application,
                [ApplicationStatus.AWAITING_COMMERCIAL_VERIFICATION, ApplicationStatus.RETURNED_TO_COMMERCIAL],
                res
            )) return;

            const previousStatus = application.status;
            application.status = ApplicationStatus.COMMERCIAL_REVIEW_IN_PROGRESS;
            await this.applicationRepository.save(application);

            await this.recordHistory({
                applicationId: application.id,
                action: "COMMERCIAL_REVIEW_STARTED",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Commercial and Marketing Officer",
                comments: "Commercial and Marketing review started.",
                ipAddress: req.ip,
            });

            return successResponse(res, application, "Review started");
        } catch (error: any) {
            return errorResponse(res, "Error starting commercial review", [error.message], 500);
        }
    }

    /** Commercial officer sends the application back to the applicant for correction. */
    async requestCorrection(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { reason } = req.body || {};
            if (!reason || !String(reason).trim()) {
                return errorResponse(res, "A reason is required when requesting a correction", [], 400);
            }
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(
                application,
                [
                    ApplicationStatus.AWAITING_COMMERCIAL_VERIFICATION,
                    ApplicationStatus.COMMERCIAL_REVIEW_IN_PROGRESS,
                    ApplicationStatus.RETURNED_TO_COMMERCIAL,
                ],
                res
            )) return;

            const previousStatus = application.status;
            application.status = ApplicationStatus.APPLICANT_CORRECTION_REQUIRED;
            await this.applicationRepository.save(application);

            await this.recordHistory({
                applicationId: application.id,
                action: "CORRECTION_REQUESTED",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Commercial and Marketing Officer",
                reason,
                comments: `Correction requested from applicant: ${reason}`,
                ipAddress: req.ip,
            });

            return successResponse(res, application, "Correction requested from applicant");
        } catch (error: any) {
            return errorResponse(res, "Error requesting correction", [error.message], 500);
        }
    }

    /** Commercial officer marks the application as verified and routes it to the DG for first approval. */
    async verifyCommercial(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { comments } = req.body || {};
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(
                application,
                [
                    ApplicationStatus.AWAITING_COMMERCIAL_VERIFICATION,
                    ApplicationStatus.COMMERCIAL_REVIEW_IN_PROGRESS,
                    ApplicationStatus.RETURNED_TO_COMMERCIAL,
                ],
                res
            )) return;

            // Server-side enforcement of the forwarding requirements — the
            // frontend's own "Verify & Forward" gating is only a UX
            // convenience and must never be the sole guard. Every required
            // document for this category must be marked VERIFIED in the
            // saved commercialReview.documents bag, and the verification
            // checklist (one item per required document plus the final
            // "information matches documents" check) must be fully ticked.
            const requiredKeys = REQUIRED_DOCUMENT_KEYS[application.category] || [];
            const savedDocs = application.commercialReview?.documents || {};
            const unverifiedDocs = requiredKeys.filter((k) => savedDocs[k]?.status !== "VERIFIED");
            const savedChecklist = application.commercialReview?.checklist || {};
            const checklistKeys = [...requiredKeys.map((k) => `doc:${k}`), "info-match"];
            const incompleteChecklist = checklistKeys.filter((k) => !savedChecklist[k]);
            if (unverifiedDocs.length > 0 || incompleteChecklist.length > 0) {
                return errorResponse(
                    res,
                    "This application cannot be forwarded yet — all required documents must be verified and the verification checklist completed.",
                    [
                        ...unverifiedDocs.map((k) => `Document not verified: ${k}`),
                        ...incompleteChecklist.map((k) => `Checklist item not completed: ${k}`),
                    ],
                    409
                );
            }

            let previousStatus: ApplicationStatus = application.status;
            application.status = ApplicationStatus.COMMERCIALLY_VERIFIED;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "COMMERCIALLY_VERIFIED",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Commercial and Marketing Officer",
                comments: comments || "Application verified by Commercial and Marketing.",
                ipAddress: req.ip,
            });

            previousStatus = application.status;
            application.status = ApplicationStatus.AWAITING_FIRST_DG_APPROVAL;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "ROUTED_TO_DG",
                previousStatus,
                newStatus: application.status,
                comments: "Automatically routed to the Director-General for first approval.",
            });

            await this.notifyQueue(
                [UserRole.DG],
                application.applicationNumber,
                "Application awaiting your first approval",
                "Commercial has verified an application and it now needs your decision."
            );

            return successResponse(res, application, "Application verified and routed to the Director-General");
        } catch (error: any) {
            return errorResponse(res, "Error verifying application", [error.message], 500);
        }
    }

    /**
     * Commercial officer resubmits an application after the applicant has
     * addressed a requested correction (office receives the updated
     * information/documents and re-enters/confirms them — the same
     * office-assisted-staff-acting-on-the-applicant's-behalf pattern
     * already used for OFFICE_ASSISTED intake elsewhere in this
     * controller). This does not add a new approval stage: it simply
     * closes the previously-unreachable APPLICANT_CORRECTION_REQUIRED
     * status by returning the application to the exact same Commercial
     * queue status it left (AWAITING_COMMERCIAL_VERIFICATION), while
     * stamping `resubmittedAt` separately so the original `submittedAt`
     * is never overwritten.
     */
    async resubmitAfterCorrection(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { comments } = req.body || {};
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(application, [ApplicationStatus.APPLICANT_CORRECTION_REQUIRED], res)) return;

            const previousStatus = application.status;
            application.status = ApplicationStatus.AWAITING_COMMERCIAL_VERIFICATION;
            application.resubmittedAt = new Date();
            await this.applicationRepository.save(application);

            await this.recordHistory({
                applicationId: application.id,
                action: "RESUBMITTED",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Commercial and Marketing Officer",
                comments: comments || "Applicant's correction received and resubmitted for Commercial review.",
                ipAddress: req.ip,
            });

            return successResponse(res, application, "Application resubmitted for review");
        } catch (error: any) {
            return errorResponse(res, "Error resubmitting application", [error.message], 500);
        }
    }

    /**
     * Saves in-progress Commercial-stage review work (per-document
     * verification status/comments, checklist, internal notes, draft
     * applicant-visible message) WITHOUT changing the application's
     * status. Purely additive bookkeeping on top of the existing
     * workflow — read back by the review UI's "Save Progress" action, and
     * never consulted by any other stage's transition logic.
     */
    async saveCommercialReviewProgress(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { documents, checklist, internalNotes, applicantMessageDraft } = req.body || {};
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(
                application,
                [
                    ApplicationStatus.AWAITING_COMMERCIAL_VERIFICATION,
                    ApplicationStatus.COMMERCIAL_REVIEW_IN_PROGRESS,
                ],
                res
            )) return;

            // Enforce "a correction reason is required when a document is
            // marked Needs Correction" server-side too — mirrors the
            // frontend's own validation but must not depend on it alone.
            if (documents && typeof documents === "object") {
                const missingReasons = Object.entries(documents as Record<string, { status?: string; comment?: string }>)
                    .filter(([, v]) => v?.status === "NEEDS_CORRECTION" && !String(v?.comment || "").trim())
                    .map(([key]) => key);
                if (missingReasons.length > 0) {
                    return errorResponse(
                        res,
                        "A correction reason is required for every document marked 'Needs Correction'.",
                        missingReasons.map((k) => `Missing reason for: ${k}`),
                        400
                    );
                }
            }

            application.commercialReview = {
                ...(application.commercialReview || {}),
                ...(documents !== undefined ? { documents } : {}),
                ...(checklist !== undefined ? { checklist } : {}),
                ...(internalNotes !== undefined ? { internalNotes } : {}),
                ...(applicantMessageDraft !== undefined ? { applicantMessageDraft } : {}),
            };
            await this.applicationRepository.save(application);

            return successResponse(res, application, "Review progress saved");
        } catch (error: any) {
            return errorResponse(res, "Error saving review progress", [error.message], 500);
        }
    }

    /**
     * Commercial officer (or, in practice, the system acting on the
     * applicant's behalf during office-assisted resubmission) replaces one
     * uploaded document with a newly-uploaded file. The previous file's URL
     * and the decision made about it (status/comment) are archived into
     * commercialReview.documentHistory rather than discarded, so a prior
     * verification/correction decision is never silently lost. The new
     * document's verification status is reset to PENDING so Commercial
     * must explicitly re-review it — it cannot inherit the old file's
     * VERIFIED status. Purely additive to the data model; does not change
     * `data.documents` shape beyond swapping one entry's value, and does
     * not touch application status.
     */
    async replaceDocument(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { documentKey, url, name, size, type } = req.body || {};
            if (!documentKey || !url) {
                return errorResponse(res, "documentKey and url are required", [], 400);
            }
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(
                application,
                [
                    ApplicationStatus.AWAITING_COMMERCIAL_VERIFICATION,
                    ApplicationStatus.COMMERCIAL_REVIEW_IN_PROGRESS,
                    ApplicationStatus.APPLICANT_CORRECTION_REQUIRED,
                ],
                res
            )) return;

            const previousDoc = application.data?.documents?.[documentKey] || null;
            const previousDecision = application.commercialReview?.documents?.[documentKey] || null;

            application.data = {
                ...application.data,
                documents: {
                    ...(application.data?.documents || {}),
                    [documentKey]: { url, name, size, type, status: "done" },
                },
            };

            const existingHistory = application.commercialReview?.documentHistory || {};
            const keyHistory = Array.isArray(existingHistory[documentKey]) ? existingHistory[documentKey] : [];
            application.commercialReview = {
                ...(application.commercialReview || {}),
                documents: {
                    ...(application.commercialReview?.documents || {}),
                    // Resets this document's verification status — the
                    // officer must explicitly re-verify the replacement.
                    [documentKey]: { status: "PENDING" },
                },
                documentHistory: {
                    ...existingHistory,
                    [documentKey]: [
                        ...keyHistory,
                        {
                            url: previousDoc?.url,
                            name: previousDoc?.name,
                            decision: previousDecision,
                            replacedAt: new Date().toISOString(),
                        },
                    ],
                },
            };
            await this.applicationRepository.save(application);

            await this.recordHistory({
                applicationId: application.id,
                action: "DOCUMENT_REPLACED",
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Commercial and Marketing Officer",
                comments: `Document replaced: ${documentKey}${previousDoc?.name ? ` (previously: ${previousDoc.name})` : ""}.`,
                ipAddress: req.ip,
            });

            return successResponse(res, application, "Document replaced");
        } catch (error: any) {
            return errorResponse(res, "Error replacing document", [error.message], 500);
        }
    }

    /** DG approves the commercial stage and routes the application to Technical Review. */
    async dgApprove(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { comments } = req.body || {};
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(application, [ApplicationStatus.AWAITING_FIRST_DG_APPROVAL], res)) return;

            let previousStatus: ApplicationStatus = application.status;
            application.status = ApplicationStatus.COMMERCIAL_STAGE_APPROVED;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "DG_FIRST_APPROVAL",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Director-General",
                comments: comments || "Approved by the Director-General (commercial stage).",
                ipAddress: req.ip,
            });

            previousStatus = application.status;
            application.status = ApplicationStatus.AWAITING_TECHNICAL_REVIEW;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "ROUTED_TO_TECHNICAL",
                previousStatus,
                newStatus: application.status,
                comments: "Automatically routed to Technical Services for review.",
            });

            await this.notifyQueue(
                [UserRole.TECHNICAL],
                application.applicationNumber,
                "Application awaiting Technical review",
                "The Director-General approved an application and it now needs Technical Services review."
            );

            return successResponse(res, application, "Application approved and routed to Technical Review");
        } catch (error: any) {
            return errorResponse(res, "Error approving application", [error.message], 500);
        }
    }

    /** DG returns the application to Commercial for further work. */
    async dgReturn(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { reason } = req.body || {};
            if (!reason || !String(reason).trim()) {
                return errorResponse(res, "A reason is required when returning an application", [], 400);
            }
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(application, [ApplicationStatus.AWAITING_FIRST_DG_APPROVAL], res)) return;

            const previousStatus = application.status;
            application.status = ApplicationStatus.RETURNED_TO_COMMERCIAL;
            await this.applicationRepository.save(application);

            await this.recordHistory({
                applicationId: application.id,
                action: "DG_RETURNED_TO_COMMERCIAL",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Director-General",
                reason,
                comments: `Returned to Commercial by the Director-General: ${reason}`,
                ipAddress: req.ip,
            });

            await this.notifyQueue(
                [UserRole.COMMERCIAL],
                application.applicationNumber,
                "Application returned by the Director-General",
                `The DG returned an application to Commercial: ${reason}`
            );

            return successResponse(res, application, "Application returned to Commercial");
        } catch (error: any) {
            return errorResponse(res, "Error returning application", [error.message], 500);
        }
    }

    // -----------------------------------------------------------------
    // Stage 3: Technical Review + Inspector Assignment + Warehouse
    // Assessment + Second DG Approval. Same load->requireStatus->
    // transition->recordHistory() pattern as Stage 2 above. Every
    // "current" WarehouseAssessment row for an application is the most
    // recently-created one (highest versionNumber) for that
    // applicationId — a reinspection loop creates a new row rather than
    // mutating the previous cycle's row, preserving full history.
    // -----------------------------------------------------------------

    /** Lists staff accounts with the INSPECTOR role, for the assignment dropdown. */
    async listInspectors(req: any, res: Response) {
        try {
            const inspectors = await this.userRepository.find({ where: { role: UserRole.INSPECTOR } });
            const list = inspectors.map((u) => ({ id: u.id, name: u.name, email: u.email }));
            return successResponse(res, list);
        } catch (error: any) {
            return errorResponse(res, "Error fetching inspectors", [error.message], 500);
        }
    }

    private async getCurrentWarehouseAssessment(applicationId: string): Promise<WarehouseAssessment | null> {
        const rows = await this.warehouseAssessmentRepository.find({
            where: { applicationId },
            order: { versionNumber: "DESC", createdAt: "DESC" },
        });
        return rows[0] || null;
    }

    /** Technical Services opens an application and starts the inspector-assignment step. */
    async startTechnicalAssignment(req: any, res: Response) {
        try {
            const { id } = req.params;
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(application, [ApplicationStatus.AWAITING_TECHNICAL_REVIEW], res)) return;

            const previousStatus = application.status;
            application.status = ApplicationStatus.INSPECTOR_ASSIGNMENT_PENDING;
            await this.applicationRepository.save(application);

            await this.recordHistory({
                applicationId: application.id,
                action: "TECHNICAL_ASSIGNMENT_STARTED",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Technical Services Officer",
                comments: "Technical Services review started; awaiting inspector assignment.",
                ipAddress: req.ip,
            });

            return successResponse(res, application, "Technical review started");
        } catch (error: any) {
            return errorResponse(res, "Error starting technical assignment", [error.message], 500);
        }
    }

    /** Technical Services assigns a specific inspector to carry out the warehouse assessment. */
    async assignInspector(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { inspectorId } = req.body || {};
            if (!inspectorId || !String(inspectorId).trim()) {
                return errorResponse(res, "An inspectorId is required", [], 400);
            }
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(
                application,
                [ApplicationStatus.AWAITING_TECHNICAL_REVIEW, ApplicationStatus.INSPECTOR_ASSIGNMENT_PENDING],
                res
            )) return;

            const inspector = await this.userRepository.findOne({ where: { id: inspectorId, role: UserRole.INSPECTOR } });
            if (!inspector) {
                return errorResponse(res, "Inspector not found", [], 404);
            }

            const previous = await this.getCurrentWarehouseAssessment(application.id);
            const nextVersion = previous ? previous.versionNumber + 1 : 1;

            const assessment = this.warehouseAssessmentRepository.create({
                applicationId: application.id,
                versionNumber: nextVersion,
                inspectorId: inspector.id,
                inspectorName: inspector.name,
                assignedByUserId: req.user?.id,
                assignedByName: req.user?.name,
            });
            await this.warehouseAssessmentRepository.save(assessment);

            const previousStatus = application.status;
            application.status = ApplicationStatus.INSPECTOR_ASSIGNED;
            await this.applicationRepository.save(application);

            await this.recordHistory({
                applicationId: application.id,
                action: "INSPECTOR_ASSIGNED",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Technical Services Officer",
                comments: `Inspector assigned: ${inspector.name || inspector.email}.`,
                ipAddress: req.ip,
            });

            try {
                await NotificationService.createForUser(
                    inspector.id,
                    "APPLICATION_WORKFLOW",
                    "Warehouse assessment assigned to you",
                    `You have been assigned to carry out a warehouse assessment (${application.applicationNumber}).`
                );
            } catch (error) {
                console.error("Error notifying assigned inspector", error);
            }

            return successResponse(res, { application, assessment }, "Inspector assigned");
        } catch (error: any) {
            return errorResponse(res, "Error assigning inspector", [error.message], 500);
        }
    }

    /** Inspector schedules the warehouse inspection date. Also used to (re)schedule after a reinspection request. */
    async scheduleInspection(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { scheduledDate } = req.body || {};
            if (!scheduledDate) {
                return errorResponse(res, "A scheduledDate is required", [], 400);
            }
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(
                application,
                [ApplicationStatus.INSPECTOR_ASSIGNED, ApplicationStatus.WAREHOUSE_REINSPECTION_REQUIRED],
                res
            )) return;

            const assessment = await this.getCurrentWarehouseAssessment(application.id);
            if (!assessment) {
                return errorResponse(res, "No warehouse assessment record found for this application", [], 409);
            }
            assessment.scheduledDate = new Date(scheduledDate);
            await this.warehouseAssessmentRepository.save(assessment);

            const previousStatus = application.status;
            application.status = ApplicationStatus.WAREHOUSE_INSPECTION_SCHEDULED;
            await this.applicationRepository.save(application);

            await this.recordHistory({
                applicationId: application.id,
                action: "INSPECTION_SCHEDULED",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Inspector",
                comments: `Warehouse inspection scheduled for ${new Date(scheduledDate).toDateString()}.`,
                ipAddress: req.ip,
            });

            return successResponse(res, application, "Inspection scheduled");
        } catch (error: any) {
            return errorResponse(res, "Error scheduling inspection", [error.message], 500);
        }
    }

    /** Inspector marks the on-site warehouse assessment as started. */
    async startAssessment(req: any, res: Response) {
        try {
            const { id } = req.params;
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(application, [ApplicationStatus.WAREHOUSE_INSPECTION_SCHEDULED], res)) return;

            const assessment = await this.getCurrentWarehouseAssessment(application.id);
            if (!assessment) {
                return errorResponse(res, "No warehouse assessment record found for this application", [], 409);
            }
            assessment.startedAt = new Date();
            await this.warehouseAssessmentRepository.save(assessment);

            const previousStatus = application.status;
            application.status = ApplicationStatus.WAREHOUSE_ASSESSMENT_IN_PROGRESS;
            await this.applicationRepository.save(application);

            await this.recordHistory({
                applicationId: application.id,
                action: "ASSESSMENT_STARTED",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Inspector",
                comments: "Warehouse assessment started on-site.",
                ipAddress: req.ip,
            });

            return successResponse(res, application, "Assessment started");
        } catch (error: any) {
            return errorResponse(res, "Error starting assessment", [error.message], 500);
        }
    }

    /** Inspector submits assessment findings; auto-routes to Technical Services for verification. */
    async submitAssessment(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { outcome, checklistData, notes } = req.body || {};
            if (!outcome || !Object.values(WarehouseAssessmentOutcome).includes(outcome)) {
                return errorResponse(res, "A valid outcome (PASS, PASS_WITH_CONDITIONS, or FAIL) is required", [], 400);
            }
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(application, [ApplicationStatus.WAREHOUSE_ASSESSMENT_IN_PROGRESS], res)) return;

            const assessment = await this.getCurrentWarehouseAssessment(application.id);
            if (!assessment) {
                return errorResponse(res, "No warehouse assessment record found for this application", [], 409);
            }
            assessment.outcome = outcome;
            assessment.checklistData = checklistData || undefined;
            assessment.notes = notes || undefined;
            assessment.submittedAt = new Date();
            await this.warehouseAssessmentRepository.save(assessment);

            let previousStatus: ApplicationStatus = application.status;
            application.status = ApplicationStatus.WAREHOUSE_ASSESSMENT_SUBMITTED;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "ASSESSMENT_SUBMITTED",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Inspector",
                comments: `Assessment submitted with outcome: ${outcome}.${notes ? ` Notes: ${notes}` : ""}`,
                ipAddress: req.ip,
            });

            previousStatus = application.status;
            application.status = ApplicationStatus.AWAITING_TECHNICAL_VERIFICATION;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "ROUTED_TO_TECHNICAL_VERIFICATION",
                previousStatus,
                newStatus: application.status,
                comments: "Automatically routed to Technical Services for verification.",
            });

            await this.notifyQueue(
                [UserRole.TECHNICAL],
                application.applicationNumber,
                "Warehouse assessment ready for verification",
                `The inspector submitted a warehouse assessment (outcome: ${outcome}) for your review.`
            );

            return successResponse(res, application, "Assessment submitted");
        } catch (error: any) {
            return errorResponse(res, "Error submitting assessment", [error.message], 500);
        }
    }

    /** Technical Services verifies the inspector's findings and routes to the DG for second approval. */
    async verifyTechnical(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { comments } = req.body || {};
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(application, [ApplicationStatus.AWAITING_TECHNICAL_VERIFICATION], res)) return;

            let previousStatus: ApplicationStatus = application.status;
            application.status = ApplicationStatus.TECHNICALLY_VERIFIED;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "TECHNICALLY_VERIFIED",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Technical Services Officer",
                comments: comments || "Warehouse assessment findings verified by Technical Services.",
                ipAddress: req.ip,
            });

            previousStatus = application.status;
            application.status = ApplicationStatus.AWAITING_SECOND_DG_APPROVAL;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "ROUTED_TO_DG_SECOND",
                previousStatus,
                newStatus: application.status,
                comments: "Automatically routed to the Director-General for second approval.",
            });

            await this.notifyQueue(
                [UserRole.DG],
                application.applicationNumber,
                "Application awaiting your second approval",
                "Technical Services verified the warehouse assessment and it now needs your decision."
            );

            return successResponse(res, application, "Verified and routed to the Director-General");
        } catch (error: any) {
            return errorResponse(res, "Error verifying technical findings", [error.message], 500);
        }
    }

    /** Technical Services sends the application back for a re-inspection cycle. */
    async requireReinspection(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { reason } = req.body || {};
            if (!reason || !String(reason).trim()) {
                return errorResponse(res, "A reason is required when requiring a reinspection", [], 400);
            }
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(application, [ApplicationStatus.AWAITING_TECHNICAL_VERIFICATION], res)) return;

            // Create a new versioned WarehouseAssessment row for the next
            // inspection cycle, carrying over the same assigned inspector,
            // rather than reusing/overwriting the previous cycle's row —
            // this is what actually preserves the failed/conditional
            // outcome and notes from THIS cycle as permanent audit history
            // once the next cycle's scheduleInspection()/submitAssessment()
            // start writing to the new row instead.
            const previous = await this.getCurrentWarehouseAssessment(application.id);
            const nextAssessment = this.warehouseAssessmentRepository.create({
                applicationId: application.id,
                versionNumber: previous ? previous.versionNumber + 1 : 1,
                inspectorId: previous?.inspectorId,
                inspectorName: previous?.inspectorName,
                assignedByUserId: previous?.assignedByUserId,
                assignedByName: previous?.assignedByName,
            });
            await this.warehouseAssessmentRepository.save(nextAssessment);

            const previousStatus = application.status;
            application.status = ApplicationStatus.WAREHOUSE_REINSPECTION_REQUIRED;
            await this.applicationRepository.save(application);

            await this.recordHistory({
                applicationId: application.id,
                action: "REINSPECTION_REQUIRED",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Technical Services Officer",
                reason,
                comments: `Reinspection required: ${reason}`,
                ipAddress: req.ip,
            });

            if (nextAssessment.inspectorId) {
                try {
                    await NotificationService.createForUser(
                        nextAssessment.inspectorId,
                        "APPLICATION_WORKFLOW",
                        "Reinspection required",
                        `Technical Services requires a reinspection (${application.applicationNumber}): ${reason}`
                    );
                } catch (error) {
                    console.error("Error notifying inspector of reinspection", error);
                }
            }

            return successResponse(res, application, "Reinspection required; returned to the inspector for scheduling");
        } catch (error: any) {
            return errorResponse(res, "Error requiring reinspection", [error.message], 500);
        }
    }

    /** DG approves the technical stage and routes the application to Billing. */
    async dgApproveSecond(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { comments } = req.body || {};
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(application, [ApplicationStatus.AWAITING_SECOND_DG_APPROVAL], res)) return;

            let previousStatus: ApplicationStatus = application.status;
            application.status = ApplicationStatus.TECHNICAL_STAGE_APPROVED;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "DG_SECOND_APPROVAL",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Director-General",
                comments: comments || "Approved by the Director-General (technical stage).",
                ipAddress: req.ip,
            });

            previousStatus = application.status;
            application.status = ApplicationStatus.AWAITING_BILLING_REVIEW;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "ROUTED_TO_BILLING",
                previousStatus,
                newStatus: application.status,
                comments: "Automatically routed to Billing for invoice preparation.",
            });

            await this.notifyQueue(
                [UserRole.FINANCE],
                application.applicationNumber,
                "Application awaiting billing review",
                "The Director-General approved the technical stage and it now needs an invoice prepared."
            );

            return successResponse(res, application, "Application approved and routed to Billing");
        } catch (error: any) {
            return errorResponse(res, "Error approving application", [error.message], 500);
        }
    }

    /** DG returns the application to Technical Services for further work. */
    async dgReturnToTechnical(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { reason } = req.body || {};
            if (!reason || !String(reason).trim()) {
                return errorResponse(res, "A reason is required when returning an application", [], 400);
            }
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(application, [ApplicationStatus.AWAITING_SECOND_DG_APPROVAL], res)) return;

            const previousStatus = application.status;
            application.status = ApplicationStatus.RETURNED_TO_TECHNICAL_SERVICES;
            await this.applicationRepository.save(application);

            await this.recordHistory({
                applicationId: application.id,
                action: "DG_RETURNED_TO_TECHNICAL",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Director-General",
                reason,
                comments: `Returned to Technical Services by the Director-General: ${reason}`,
                ipAddress: req.ip,
            });

            await this.notifyQueue(
                [UserRole.TECHNICAL],
                application.applicationNumber,
                "Application returned by the Director-General",
                `The DG returned an application to Technical Services: ${reason}`
            );

            return successResponse(res, application, "Application returned to Technical Services");
        } catch (error: any) {
            return errorResponse(res, "Error returning application", [error.message], 500);
        }
    }

    // -----------------------------------------------------------------
    // Stage 4: Billing Review + Payment Verification + Final DG Approval
    // + IT Certificate Printing/Issuance. Same load->requireStatus->
    // transition->recordHistory() pattern as Stages 2 and 3. There is no
    // applicant-facing payment portal in this phase — Finance receives
    // proof of payment out-of-band (bank slip, mobile money receipt,
    // cheque presented at the counter) and records it on the applicant's
    // behalf via /payment/submit, mirroring the existing "Office-Assisted"
    // pattern used for application intake. This still produces the full
    // two-step PAYMENT_SUBMITTED -> PAYMENT_VERIFICATION_PENDING ->
    // PAYMENT_VERIFIED audit trail the spec requires, even though Finance
    // is the actor for both steps.
    // -----------------------------------------------------------------

    private async getCurrentInvoice(applicationId: string): Promise<Invoice | null> {
        const rows = await this.invoiceRepository.find({
            where: { applicationId },
            order: { versionNumber: "DESC", createdAt: "DESC" },
        });
        return rows[0] || null;
    }

    private async getCurrentPayment(applicationId: string): Promise<PaymentSubmission | null> {
        const rows = await this.paymentRepository.find({
            where: { applicationId },
            order: { versionNumber: "DESC", createdAt: "DESC" },
        });
        return rows[0] || null;
    }

    // Sequential, human-readable numbers, matching create()'s
    // applicationNumber pattern exactly: LACRA-{PREFIX}-{year}-{6-digit}.
    private async nextSequentialNumber(prefix: string, repo: { createQueryBuilder: (alias: string) => any }): Promise<string> {
        const year = new Date().getFullYear();
        const yearStart = new Date(year, 0, 1);
        const yearEnd = new Date(year + 1, 0, 1);
        const count = await repo
            .createQueryBuilder("row")
            .where("row.createdAt >= :start AND row.createdAt < :end", { start: yearStart, end: yearEnd })
            .getCount();
        return `LACRA-${prefix}-${year}-${(count + 1).toString().padStart(6, "0")}`;
    }

    /** Finance opens an application and starts the billing review. */
    async startBillingReview(req: any, res: Response) {
        try {
            const { id } = req.params;
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(application, [ApplicationStatus.AWAITING_BILLING_REVIEW], res)) return;

            const previousStatus = application.status;
            application.status = ApplicationStatus.BILLING_REVIEW_IN_PROGRESS;
            await this.applicationRepository.save(application);

            await this.recordHistory({
                applicationId: application.id,
                action: "BILLING_REVIEW_STARTED",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Finance Officer",
                comments: "Billing review started.",
                ipAddress: req.ip,
            });

            return successResponse(res, application, "Billing review started");
        } catch (error: any) {
            return errorResponse(res, "Error starting billing review", [error.message], 500);
        }
    }

    /** Finance creates and approves the invoice; auto-routes to the applicant for payment. */
    async createInvoice(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { amount, currency, feeBreakdown, notes } = req.body || {};
            const parsedAmount = Number(amount);
            if (!amount || Number.isNaN(parsedAmount) || parsedAmount <= 0) {
                return errorResponse(res, "A valid invoice amount greater than 0 is required", [], 400);
            }
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(
                application,
                [ApplicationStatus.BILLING_REVIEW_IN_PROGRESS, ApplicationStatus.AWAITING_BILLING_REVIEW, ApplicationStatus.RETURNED_TO_FINANCE],
                res
            )) return;

            const previousInvoice = await this.getCurrentInvoice(application.id);
            const invoiceNumber = await this.nextSequentialNumber("INV", this.invoiceRepository);
            const invoice = this.invoiceRepository.create({
                applicationId: application.id,
                versionNumber: previousInvoice ? previousInvoice.versionNumber + 1 : 1,
                invoiceNumber,
                currency: currency || "USD",
                amount: parsedAmount,
                feeBreakdown: Array.isArray(feeBreakdown) ? feeBreakdown : undefined,
                notes: notes || undefined,
                createdByUserId: req.user?.id,
                createdByName: req.user?.name,
                approvedAt: new Date(),
            });
            await this.invoiceRepository.save(invoice);

            let previousStatus: ApplicationStatus = application.status;
            application.status = ApplicationStatus.INVOICE_APPROVED;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "INVOICE_APPROVED",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Finance Officer",
                comments: `Invoice ${invoiceNumber} approved for ${invoice.currency} ${invoice.amount}.`,
                ipAddress: req.ip,
            });

            previousStatus = application.status;
            application.status = ApplicationStatus.AWAITING_APPLICANT_PAYMENT;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "ROUTED_TO_PAYMENT",
                previousStatus,
                newStatus: application.status,
                comments: "Awaiting payment from the applicant.",
            });

            return successResponse(res, { application, invoice }, "Invoice approved and routed to the applicant for payment");
        } catch (error: any) {
            return errorResponse(res, "Error creating invoice", [error.message], 500);
        }
    }

    /** Finance records a payment received from the applicant (proof submitted out-of-band). */
    async submitPayment(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { method, referenceNumber, amountPaid, proofDocumentUrl, proofDocumentName, notes } = req.body || {};
            if (!method || !Object.values(PaymentMethod).includes(method)) {
                return errorResponse(res, "A valid payment method is required", [], 400);
            }
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(
                application,
                [ApplicationStatus.AWAITING_APPLICANT_PAYMENT, ApplicationStatus.PAYMENT_CORRECTION_REQUIRED],
                res
            )) return;

            const invoice = await this.getCurrentInvoice(application.id);
            if (!invoice) {
                return errorResponse(res, "No approved invoice found for this application", [], 409);
            }

            const previousPayment = await this.getCurrentPayment(application.id);
            const payment = this.paymentRepository.create({
                applicationId: application.id,
                versionNumber: previousPayment ? previousPayment.versionNumber + 1 : 1,
                invoiceId: invoice.id,
                method,
                referenceNumber: referenceNumber || undefined,
                amountPaid: amountPaid !== undefined ? Number(amountPaid) : undefined,
                proofDocumentUrl: proofDocumentUrl || undefined,
                proofDocumentName: proofDocumentName || undefined,
                notes: notes || undefined,
                submittedAt: new Date(),
            });
            await this.paymentRepository.save(payment);

            let previousStatus: ApplicationStatus = application.status;
            application.status = ApplicationStatus.PAYMENT_SUBMITTED;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "PAYMENT_SUBMITTED",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Finance Officer",
                comments: `Payment recorded via ${method}${referenceNumber ? ` (ref: ${referenceNumber})` : ""}.`,
                ipAddress: req.ip,
            });

            previousStatus = application.status;
            application.status = ApplicationStatus.PAYMENT_VERIFICATION_PENDING;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "ROUTED_TO_PAYMENT_VERIFICATION",
                previousStatus,
                newStatus: application.status,
                comments: "Automatically routed for payment verification.",
            });

            return successResponse(res, { application, payment }, "Payment recorded and pending verification");
        } catch (error: any) {
            return errorResponse(res, "Error recording payment", [error.message], 500);
        }
    }

    /**
     * Finance verifies the recorded payment. Cheque payments route to
     * PENDING_CHEQUE_CLEARANCE (a further clearCheque() action is
     * required); all other methods route straight through to
     * PAYMENT_VERIFIED -> AWAITING_FINAL_DG_APPROVAL.
     */
    async verifyPayment(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { comments } = req.body || {};
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(application, [ApplicationStatus.PAYMENT_VERIFICATION_PENDING], res)) return;

            const payment = await this.getCurrentPayment(application.id);
            if (!payment) {
                return errorResponse(res, "No payment submission found for this application", [], 409);
            }

            if (payment.method === PaymentMethod.CHEQUE) {
                const previousStatus = application.status;
                application.status = ApplicationStatus.PENDING_CHEQUE_CLEARANCE;
                await this.applicationRepository.save(application);
                await this.recordHistory({
                    applicationId: application.id,
                    action: "PENDING_CHEQUE_CLEARANCE",
                    previousStatus,
                    newStatus: application.status,
                    userId: req.user?.id,
                    userName: req.user?.name,
                    role: "Finance Officer",
                    comments: comments || "Payment verified as a cheque; awaiting clearance.",
                    ipAddress: req.ip,
                });
                return successResponse(res, application, "Awaiting cheque clearance");
            }

            payment.verifiedByUserId = req.user?.id;
            payment.verifiedByName = req.user?.name;
            payment.verifiedAt = new Date();
            await this.paymentRepository.save(payment);

            let previousStatus: ApplicationStatus = application.status;
            application.status = ApplicationStatus.PAYMENT_VERIFIED;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "PAYMENT_VERIFIED",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Finance Officer",
                comments: comments || "Payment verified.",
                ipAddress: req.ip,
            });

            previousStatus = application.status;
            application.status = ApplicationStatus.AWAITING_FINAL_DG_APPROVAL;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "ROUTED_TO_FINAL_DG_APPROVAL",
                previousStatus,
                newStatus: application.status,
                comments: "Automatically routed to the Director-General for final approval.",
            });

            await this.notifyQueue(
                [UserRole.DG],
                application.applicationNumber,
                "Application awaiting your final approval",
                "Finance verified payment and it now needs your final decision."
            );

            return successResponse(res, application, "Payment verified and routed to the Director-General");
        } catch (error: any) {
            return errorResponse(res, "Error verifying payment", [error.message], 500);
        }
    }

    /** Finance clears a previously-verified cheque payment; routes to Final DG Approval. */
    async clearCheque(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { comments } = req.body || {};
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(application, [ApplicationStatus.PENDING_CHEQUE_CLEARANCE], res)) return;

            const payment = await this.getCurrentPayment(application.id);
            if (payment) {
                payment.verifiedByUserId = req.user?.id;
                payment.verifiedByName = req.user?.name;
                payment.verifiedAt = payment.verifiedAt || new Date();
                payment.chequeClearedAt = new Date();
                await this.paymentRepository.save(payment);
            }

            let previousStatus: ApplicationStatus = application.status;
            application.status = ApplicationStatus.PAYMENT_VERIFIED;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "CHEQUE_CLEARED",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Finance Officer",
                comments: comments || "Cheque cleared; payment verified.",
                ipAddress: req.ip,
            });

            previousStatus = application.status;
            application.status = ApplicationStatus.AWAITING_FINAL_DG_APPROVAL;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "ROUTED_TO_FINAL_DG_APPROVAL",
                previousStatus,
                newStatus: application.status,
                comments: "Automatically routed to the Director-General for final approval.",
            });

            await this.notifyQueue(
                [UserRole.DG],
                application.applicationNumber,
                "Application awaiting your final approval",
                "Finance cleared the cheque and it now needs your final decision."
            );

            return successResponse(res, application, "Cheque cleared and routed to the Director-General");
        } catch (error: any) {
            return errorResponse(res, "Error clearing cheque", [error.message], 500);
        }
    }

    /** Finance sends a payment submission back to the applicant for correction. */
    async requirePaymentCorrection(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { reason } = req.body || {};
            if (!reason || !String(reason).trim()) {
                return errorResponse(res, "A reason is required when requiring a payment correction", [], 400);
            }
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(application, [ApplicationStatus.PAYMENT_VERIFICATION_PENDING], res)) return;

            const previousStatus = application.status;
            application.status = ApplicationStatus.PAYMENT_CORRECTION_REQUIRED;
            await this.applicationRepository.save(application);

            await this.recordHistory({
                applicationId: application.id,
                action: "PAYMENT_CORRECTION_REQUIRED",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Finance Officer",
                reason,
                comments: `Payment correction required: ${reason}`,
                ipAddress: req.ip,
            });

            return successResponse(res, application, "Payment correction required");
        } catch (error: any) {
            return errorResponse(res, "Error requiring payment correction", [error.message], 500);
        }
    }

    /** DG gives final approval; auto-routes to IT for certificate printing. */
    async dgApproveFinal(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { comments } = req.body || {};
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(application, [ApplicationStatus.AWAITING_FINAL_DG_APPROVAL], res)) return;

            let previousStatus: ApplicationStatus = application.status;
            application.status = ApplicationStatus.APPROVED_FOR_ISSUANCE;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "DG_FINAL_APPROVAL",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Director-General",
                comments: comments || "Final approval granted by the Director-General.",
                ipAddress: req.ip,
            });

            // Create the (initially blank) Certificate record now, so IT
            // has a row to fill in at the printing step, rather than
            // creating it implicitly inside printCertificate().
            const existing = await this.certificateRepository.findOne({ where: { applicationId: application.id } });
            if (!existing) {
                const certificate = this.certificateRepository.create({
                    applicationId: application.id,
                    permitOrLicenceType: application.category,
                });
                await this.certificateRepository.save(certificate);
            }

            previousStatus = application.status;
            application.status = ApplicationStatus.AWAITING_IT_CERTIFICATE_PRINTING;
            await this.applicationRepository.save(application);
            await this.recordHistory({
                applicationId: application.id,
                action: "ROUTED_TO_IT",
                previousStatus,
                newStatus: application.status,
                comments: "Automatically routed to IT for certificate printing.",
            });

            await this.notifyQueue(
                [UserRole.IT],
                application.applicationNumber,
                "Certificate ready for printing",
                "The Director-General gave final approval and the certificate now needs to be printed and issued."
            );

            return successResponse(res, application, "Application approved for issuance and routed to IT");
        } catch (error: any) {
            return errorResponse(res, "Error giving final approval", [error.message], 500);
        }
    }

    /** DG returns the application to Finance for further work at the final-approval stage. */
    async dgReturnToFinance(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { reason } = req.body || {};
            if (!reason || !String(reason).trim()) {
                return errorResponse(res, "A reason is required when returning an application", [], 400);
            }
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(application, [ApplicationStatus.AWAITING_FINAL_DG_APPROVAL], res)) return;

            const previousStatus = application.status;
            application.status = ApplicationStatus.RETURNED_TO_FINANCE;
            await this.applicationRepository.save(application);

            await this.recordHistory({
                applicationId: application.id,
                action: "DG_RETURNED_TO_FINANCE",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "Director-General",
                reason,
                comments: `Returned to Finance by the Director-General: ${reason}`,
                ipAddress: req.ip,
            });

            await this.notifyQueue(
                [UserRole.FINANCE],
                application.applicationNumber,
                "Application returned by the Director-General",
                `The DG returned an application to Finance: ${reason}`
            );

            return successResponse(res, application, "Application returned to Finance");
        } catch (error: any) {
            return errorResponse(res, "Error returning application", [error.message], 500);
        }
    }

    /** IT marks the certificate as printed. */
    async printCertificate(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { validityMonths } = req.body || {};
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(application, [ApplicationStatus.AWAITING_IT_CERTIFICATE_PRINTING], res)) return;

            const certificate = await this.certificateRepository.findOne({ where: { applicationId: application.id } });
            if (!certificate) {
                return errorResponse(res, "No certificate record found for this application", [], 409);
            }

            const months = Number(validityMonths) > 0 ? Number(validityMonths) : 12;
            const now = new Date();
            const expiry = new Date(now);
            expiry.setMonth(expiry.getMonth() + months);

            certificate.certificateNumber = certificate.certificateNumber || await this.nextSequentialNumber("CERT", this.certificateRepository);
            certificate.issueDate = now;
            certificate.expiryDate = expiry;
            certificate.printedByUserId = req.user?.id;
            certificate.printedByName = req.user?.name;
            certificate.printedAt = now;
            await this.certificateRepository.save(certificate);

            const previousStatus = application.status;
            application.status = ApplicationStatus.CERTIFICATE_PRINTED;
            await this.applicationRepository.save(application);

            await this.recordHistory({
                applicationId: application.id,
                action: "CERTIFICATE_PRINTED",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "IT Officer",
                comments: `Certificate ${certificate.certificateNumber} printed, valid until ${expiry.toDateString()}.`,
                ipAddress: req.ip,
            });

            return successResponse(res, { application, certificate }, "Certificate printed");
        } catch (error: any) {
            return errorResponse(res, "Error printing certificate", [error.message], 500);
        }
    }

    /** IT issues the printed certificate to the applicant — the final step of the workflow. */
    async issueCertificate(req: any, res: Response) {
        try {
            const { id } = req.params;
            const application = await this.loadApplicationOr404(id, res);
            if (!application) return;
            if (!this.requireStatus(application, [ApplicationStatus.CERTIFICATE_PRINTED], res)) return;

            const certificate = await this.certificateRepository.findOne({ where: { applicationId: application.id } });
            if (certificate) {
                certificate.issuedAt = new Date();
                await this.certificateRepository.save(certificate);
            }

            const previousStatus = application.status;
            application.status = ApplicationStatus.ISSUED;
            await this.applicationRepository.save(application);

            await this.recordHistory({
                applicationId: application.id,
                action: "ISSUED",
                previousStatus,
                newStatus: application.status,
                userId: req.user?.id,
                userName: req.user?.name,
                role: "IT Officer",
                comments: `Certificate ${certificate?.certificateNumber || ""} issued to the applicant.`,
                ipAddress: req.ip,
            });

            return successResponse(res, { application, certificate }, "Certificate issued — workflow complete");
        } catch (error: any) {
            return errorResponse(res, "Error issuing certificate", [error.message], 500);
        }
    }

    /**
     * Public QR-verification lookup: given a certificateNumber printed on
     * the certificate (embedded in the QR code), returns just enough
     * information to confirm authenticity, without exposing the full
     * application record. No auth required — this is the whole point of
     * a QR-scan verification page.
     */
    async verifyCertificate(req: any, res: Response) {
        try {
            const { certificateNumber } = req.params;
            const certificate = await this.certificateRepository.findOne({ where: { certificateNumber } });
            if (!certificate) {
                return errorResponse(res, "Certificate not found. This certificate number could not be verified.", [], 404);
            }
            const application = await this.applicationRepository.findOne({ where: { id: certificate.applicationId } });
            if (!application) {
                return errorResponse(res, "Certificate not found. This certificate number could not be verified.", [], 404);
            }

            return successResponse(res, {
                certificateNumber: certificate.certificateNumber,
                permitOrLicenceType: certificate.permitOrLicenceType,
                issueDate: certificate.issueDate,
                expiryDate: certificate.expiryDate,
                status: application.status,
                valid: application.status === ApplicationStatus.ISSUED && !!certificate.expiryDate && new Date(certificate.expiryDate) > new Date(),
                applicantName: extractApplicantName(application.category, application.data),
                applicationNumber: application.applicationNumber,
                commodity: application.commodity,
                category: application.category,
            });
        } catch (error: any) {
            return errorResponse(res, "Error verifying certificate", [error.message], 500);
        }
    }

    async getAll(req: any, res: Response) {
        try {
            const { category, channel, status } = req.query;
            const qb = this.applicationRepository.createQueryBuilder("app").orderBy("app.createdAt", "DESC");
            if (category) qb.andWhere("app.category = :category", { category });
            if (channel) qb.andWhere("app.channel = :channel", { channel });
            if (status) qb.andWhere("app.status = :status", { status });

            const applications = await qb.getMany();

            // Best-effort "assigned officer" derivation for the Commercial
            // queue: the most recent COMMERCIAL_REVIEW_STARTED/RESUBMITTED
            // history row's userName for each application, fetched in one
            // batched query rather than per-row N+1 lookups. Purely a
            // display convenience — no column or new business rule is
            // introduced; applications with no such history row simply
            // show as unassigned on the frontend.
            const appIds = applications.map((a) => a.id);
            const assignedOfficerByAppId: Record<string, string | undefined> = {};
            if (appIds.length > 0) {
                const assignmentRows = await this.historyRepository
                    .createQueryBuilder("h")
                    .where("h.applicationId IN (:...appIds)", { appIds })
                    .andWhere("h.action IN (:...actions)", { actions: ["COMMERCIAL_REVIEW_STARTED", "RESUBMITTED"] })
                    .orderBy("h.createdAt", "ASC")
                    .getMany();
                for (const row of assignmentRows) {
                    // Later rows overwrite earlier ones since we ordered ASC,
                    // leaving the most recent officer per application.
                    assignedOfficerByAppId[row.applicationId] = row.userName || undefined;
                }
            }

            // Lightweight list projection (no full `data` blob) for
            // dashboard/queue tables — full detail is fetched via getOne()
            // when an "Open Application" action is taken.
            const list = applications.map((a) => ({
                id: a.id,
                applicationNumber: a.applicationNumber,
                category: a.category,
                commodity: a.commodity,
                channel: a.channel,
                submissionMethod: a.submissionMethod,
                status: a.status,
                applicantName: extractApplicantName(a.category, a.data),
                county: a.data?.buyer?.county || a.data?.agency?.county || a.data?.cooperative?.county || a.data?.exporter?.county || a.data?.warehouse?.county,
                tin: a.data?.buyer?.tin || a.data?.agency?.tin || a.data?.cooperative?.tin || a.data?.exporter?.tin,
                businessName: a.data?.buyer?.businessName || a.data?.agency?.legalName || a.data?.cooperative?.legalName || a.data?.exporter?.legalName,
                submittedAt: a.submittedAt,
                resubmittedAt: a.resubmittedAt,
                createdAt: a.createdAt,
                assignedOfficer: assignedOfficerByAppId[a.id],
            }));

            return successResponse(res, list);
        } catch (error: any) {
            return errorResponse(res, "Error fetching applications", [error.message], 500);
        }
    }
}
