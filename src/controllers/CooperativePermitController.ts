/**
 * CooperativePermitController — admin-facing (authenticated) endpoints for
 * the NEW Cooperative (Certificate-based) Register page: searchable/
 * paginated listing with county/status filters, profile, and downloadable
 * QR PNG per issuance.
 *
 * Deliberately named "CooperativePermitController" (not
 * "CooperativeController", which already exists for the unrelated CDA
 * Cooperative directory — membership/location reference data with no
 * Certificate linkage — mounted at /api/cooperatives). This controller
 * mirrors ExporterController's / LocalProduceBuyerController's structure
 * closely, reusing the shared Certificate entity with
 * permitOrLicenceType = "COOPERATIVE" (see
 * ManualLicenseEntryService.COOPERATIVE_PERMIT_TYPE) — no new Certificate
 * columns were needed, exactly like the Exporter Register reused every
 * generic column the Local Produce Buyer/Agency registers already added.
 *
 * There is no bulk historical import for Cooperative (unlike Local Buyer/
 * Agency/Exporter, which each have an authorized historical batch) — every
 * Cooperative Certificate record today is created one at a time via
 * ManualLicenseEntryService (manual backfill) or, in the future, a live
 * Application reaching ISSUED through the normal /apply workflow.
 *
 * The public, unauthenticated QR-scan verification endpoint lives
 * separately in PermitVerificationController (mounted under
 * /api/public/cooperatives/verify/:token) — this controller is the
 * internal CMIS-side view and management surface only.
 */

import { Request, Response } from "express";
import QRCode from "qrcode";
import { AppDataSource } from "../data-source";
import { Certificate } from "../entities/Certificate";
import { Application } from "../entities/Application";
import { successResponse, errorResponse } from "../utils/response";
import { computePublicStatus } from "../services/PermitVerificationService";
import { COOPERATIVE_PERMIT_TYPE } from "../services/ManualLicenseEntryService";

function cooperativeVerificationUrl(token: string): string {
    const base = process.env.FRONTEND_URL || "http://localhost:5173";
    return `${base}/verify/cooperatives/${token}`;
}

export class CooperativePermitController {
    private certificateRepository = AppDataSource.getRepository(Certificate);
    private applicationRepository = AppDataSource.getRepository(Application);

    /**
     * GET /api/cooperative-permits
     * Searchable/paginated register listing. Query params:
     *   search   — matches cooperative name or permit number (case-insensitive)
     *   county   — exact county filter
     *   status   — VALID | EXPIRED | SUSPENDED | REVOKED | PENDING (computed live)
     *   page, pageSize
     */
    async getAll(req: Request, res: Response) {
        try {
            const { search, county, status } = req.query as Record<string, string | undefined>;
            const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
            const pageSize = Math.min(100, Math.max(1, parseInt((req.query.pageSize as string) || "20", 10)));

            const qb = this.certificateRepository
                .createQueryBuilder("cert")
                .where("cert.permitOrLicenceType = :type", { type: COOPERATIVE_PERMIT_TYPE });

            if (search) {
                qb.andWhere("(cert.buyerDisplayName ILIKE :search OR cert.certificateNumber ILIKE :search OR cert.stagedPermitNumber ILIKE :search)", {
                    search: `%${search}%`,
                });
            }
            if (county) {
                qb.andWhere("cert.county = :county", { county });
            }

            qb.orderBy("cert.buyerDisplayName", "ASC");
            const allMatching = await qb.getMany();

            const applicationIds = [...new Set(allMatching.map((c) => c.applicationId))];
            const applications = applicationIds.length ? await this.applicationRepository.findByIds(applicationIds) : [];
            const applicationById = new Map(applications.map((a) => [a.id, a]));

            let rows = allMatching.map((cert) => {
                const application = applicationById.get(cert.applicationId);
                const computedStatus = application ? computePublicStatus(cert, application) : "PENDING";
                return { certificate: cert, computedStatus };
            });

            if (status) {
                rows = rows.filter((r) => r.computedStatus === status);
            }

            const total = rows.length;
            const start = (page - 1) * pageSize;
            const paged = rows.slice(start, start + pageSize);

            const data = paged.map(({ certificate: cert, computedStatus }) => ({
                id: cert.id,
                cooperativeName: cert.buyerDisplayName,
                county: cert.county,
                locality: cert.locality,
                permitNumber: cert.certificateNumber || null,
                stagedPermitNumber: cert.stagedPermitNumber || null,
                issuanceDate: cert.issueDate,
                expirationDate: cert.expiryDate,
                status: computedStatus,
                isPubliclyBlocked: cert.isPubliclyBlocked,
                publicBlockReason: cert.publicBlockReason,
                isHistoricalImport: cert.isHistoricalImport,
                hasVerificationToken: !!cert.verificationToken,
                applicationId: cert.applicationId,
            }));

            return successResponse(res, { records: data, total, page, pageSize });
        } catch (error: any) {
            return errorResponse(res, "Error fetching Cooperative register", [error.message], 500);
        }
    }

    /** GET /api/cooperative-permits/counties — distinct county list for the filter dropdown. */
    async getCounties(req: Request, res: Response) {
        try {
            const rows = await this.certificateRepository
                .createQueryBuilder("cert")
                .select("DISTINCT cert.county", "county")
                .where("cert.permitOrLicenceType = :type", { type: COOPERATIVE_PERMIT_TYPE })
                .andWhere("cert.county IS NOT NULL")
                .orderBy("cert.county", "ASC")
                .getRawMany();
            return successResponse(res, rows.map((r) => r.county));
        } catch (error: any) {
            return errorResponse(res, "Error fetching counties", [error.message], 500);
        }
    }

    /** GET /api/cooperative-permits/:id — full Cooperative profile / permit details. */
    async getOne(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const certificate = await this.certificateRepository.findOne({ where: { id, permitOrLicenceType: COOPERATIVE_PERMIT_TYPE } });
            if (!certificate) return errorResponse(res, "Cooperative permit not found", [], 404);

            const application = await this.applicationRepository.findOne({ where: { id: certificate.applicationId } });
            const computedStatus = application ? computePublicStatus(certificate, application) : "PENDING";

            return successResponse(res, {
                id: certificate.id,
                cooperativeName: certificate.buyerDisplayName,
                county: certificate.county,
                locality: certificate.locality,
                permitNumber: certificate.certificateNumber || null,
                stagedPermitNumber: certificate.stagedPermitNumber || null,
                issuanceDate: certificate.issueDate,
                expirationDate: certificate.expiryDate,
                status: computedStatus,
                isPubliclyBlocked: certificate.isPubliclyBlocked,
                publicBlockReason: certificate.publicBlockReason,
                isHistoricalImport: certificate.isHistoricalImport,
                hasVerificationToken: !!certificate.verificationToken,
                applicationId: certificate.applicationId,
            });
        } catch (error: any) {
            return errorResponse(res, "Error fetching Cooperative profile", [error.message], 500);
        }
    }

    /** GET /api/cooperative-permits/:id/qr-code — downloadable PNG of this certificate's verification QR. */
    async downloadQrCode(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const certificate = await this.certificateRepository.findOne({ where: { id, permitOrLicenceType: COOPERATIVE_PERMIT_TYPE } });
            if (!certificate) return errorResponse(res, "Cooperative permit not found", [], 404);
            if (certificate.isPubliclyBlocked || !certificate.verificationToken) {
                return errorResponse(
                    res,
                    "This record is held pending staff resolution and does not yet have a publishable QR code.",
                    [],
                    409
                );
            }

            const url = cooperativeVerificationUrl(certificate.verificationToken);
            const pngBuffer = await QRCode.toBuffer(url, { type: "png", width: 600 });

            const filename = `${(certificate.buyerDisplayName || "cooperative").replace(/[^a-zA-Z0-9]+/g, "_")}_Cooperative_Permit_${certificate.certificateNumber}_QR.png`;
            res.setHeader("Content-Type", "image/png");
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            return res.send(pngBuffer);
        } catch (error: any) {
            return errorResponse(res, "Error generating QR code", [error.message], 500);
        }
    }
}
