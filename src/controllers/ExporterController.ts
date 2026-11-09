/**
 * ExporterController — admin-facing (authenticated) endpoints for the
 * Exporter Register page: searchable/paginated listing with county/status
 * filters, exporter profile, downloadable QR PNG per issuance, the
 * dry-run/apply historical import workflow, and conflict resolution
 * (Meridian's county discrepancy).
 *
 * Mirrors LocalProduceBuyerController's / AgencyController's structure
 * closely. The public, unauthenticated QR-scan verification endpoint
 * lives separately in PermitVerificationController (mounted under
 * /api/public/exporters/verify/:token) — this controller is the internal
 * CMIS-side view and management surface only.
 */

import { Request, Response } from "express";
import QRCode from "qrcode";
import { AppDataSource } from "../data-source";
import { Certificate } from "../entities/Certificate";
import { Application } from "../entities/Application";
import { successResponse, errorResponse } from "../utils/response";
import { computePublicStatus } from "../services/PermitVerificationService";
import { ExporterImportService, ExporterImportIntegrityError, EXPORTER_PERMIT_TYPE } from "../services/ExporterImportService";

// Base URL the printed/downloaded QR encodes. Mirrors the existing
// FRONTEND_URL-based pattern used by every prior register.
function exporterVerificationUrl(token: string): string {
    const base = process.env.FRONTEND_URL || "http://localhost:5173";
    return `${base}/verify/exporters/${token}`;
}

export class ExporterController {
    private certificateRepository = AppDataSource.getRepository(Certificate);
    private applicationRepository = AppDataSource.getRepository(Application);

    /**
     * GET /api/exporters
     * Searchable/paginated register listing. Query params:
     *   search   — matches company name or license number (case-insensitive)
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
                .where("cert.permitOrLicenceType = :type", { type: EXPORTER_PERMIT_TYPE });

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
            const applications = applicationIds.length
                ? await this.applicationRepository.findByIds(applicationIds)
                : [];
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
                exporterName: cert.buyerDisplayName,
                county: cert.county,
                disputedCounty: cert.disputedCounty,
                locality: cert.locality,
                licenseNumber: cert.certificateNumber || null,
                stagedPermitNumber: cert.stagedPermitNumber || null,
                issuanceDate: cert.issueDate,
                expirationDate: cert.expiryDate,
                status: computedStatus,
                isPubliclyBlocked: cert.isPubliclyBlocked,
                publicBlockReason: cert.publicBlockReason,
                isHistoricalImport: cert.isHistoricalImport,
                hasVerificationToken: !!cert.verificationToken,
                applicationId: cert.applicationId,
                logoUrl: cert.logoUrl || null,
            }));

            return successResponse(res, { records: data, total, page, pageSize });
        } catch (error: any) {
            return errorResponse(res, "Error fetching Exporter register", [error.message], 500);
        }
    }

    /** GET /api/exporters/counties — distinct county list for the filter dropdown. */
    async getCounties(req: Request, res: Response) {
        try {
            const rows = await this.certificateRepository
                .createQueryBuilder("cert")
                .select("DISTINCT cert.county", "county")
                .where("cert.permitOrLicenceType = :type", { type: EXPORTER_PERMIT_TYPE })
                .andWhere("cert.county IS NOT NULL")
                .orderBy("cert.county", "ASC")
                .getRawMany();
            return successResponse(res, rows.map((r) => r.county));
        } catch (error: any) {
            return errorResponse(res, "Error fetching counties", [error.message], 500);
        }
    }

    /** GET /api/exporters/:id — full exporter profile / license details. */
    async getOne(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const certificate = await this.certificateRepository.findOne({ where: { id, permitOrLicenceType: EXPORTER_PERMIT_TYPE } });
            if (!certificate) return errorResponse(res, "Exporter not found", [], 404);

            const application = await this.applicationRepository.findOne({ where: { id: certificate.applicationId } });
            const computedStatus = application ? computePublicStatus(certificate, application) : "PENDING";

            return successResponse(res, {
                id: certificate.id,
                exporterName: certificate.buyerDisplayName,
                county: certificate.county,
                disputedCounty: certificate.disputedCounty,
                locality: certificate.locality,
                licenseNumber: certificate.certificateNumber || null,
                stagedPermitNumber: certificate.stagedPermitNumber || null,
                issuanceDate: certificate.issueDate,
                expirationDate: certificate.expiryDate,
                status: computedStatus,
                isPubliclyBlocked: certificate.isPubliclyBlocked,
                publicBlockReason: certificate.publicBlockReason,
                isHistoricalImport: certificate.isHistoricalImport,
                hasVerificationToken: !!certificate.verificationToken,
                applicationId: certificate.applicationId,
                logoUrl: certificate.logoUrl || null,
            });
        } catch (error: any) {
            return errorResponse(res, "Error fetching Exporter profile", [error.message], 500);
        }
    }

    /** GET /api/exporters/:id/qr-code — downloadable PNG of this certificate's verification QR. */
    async downloadQrCode(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const certificate = await this.certificateRepository.findOne({ where: { id, permitOrLicenceType: EXPORTER_PERMIT_TYPE } });
            if (!certificate) return errorResponse(res, "Exporter not found", [], 404);
            if (certificate.isPubliclyBlocked || !certificate.verificationToken) {
                return errorResponse(
                    res,
                    "This record is held pending staff resolution and does not yet have a publishable QR code.",
                    [],
                    409
                );
            }

            const url = exporterVerificationUrl(certificate.verificationToken);
            const pngBuffer = await QRCode.toBuffer(url, { type: "png", width: 600 });

            const filename = `${(certificate.buyerDisplayName || "exporter").replace(/[^a-zA-Z0-9]+/g, "_")}_Export_License_${certificate.certificateNumber}_QR.png`;
            res.setHeader("Content-Type", "image/png");
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            return res.send(pngBuffer);
        } catch (error: any) {
            return errorResponse(res, "Error generating QR code", [error.message], 500);
        }
    }

    /** GET /api/exporters/import/preview — ADMIN-only dry run (writes only the audit run row). */
    async previewImport(req: any, res: Response) {
        try {
            const summary = await ExporterImportService.preview({
                performedByUserId: req.user?.id,
                performedByName: req.user?.name,
                recordRun: true,
            });
            return successResponse(res, summary);
        } catch (error: any) {
            if (error instanceof ExporterImportIntegrityError) {
                return errorResponse(res, error.message, [], 409);
            }
            return errorResponse(res, "Error previewing Exporter import", [error.message], 500);
        }
    }

    /** POST /api/exporters/import/apply — ADMIN-only, idempotent live import. */
    async applyImport(req: any, res: Response) {
        try {
            const summary = await ExporterImportService.apply({
                performedByUserId: req.user?.id,
                performedByName: req.user?.name,
            });
            return successResponse(res, summary, "Import applied");
        } catch (error: any) {
            if (error instanceof ExporterImportIntegrityError) {
                return errorResponse(res, error.message, [], 409);
            }
            return errorResponse(res, "Error applying Exporter import", [error.message], 500);
        }
    }

    /** GET /api/exporters/import/runs — ADMIN-only import run history. */
    async getImportRuns(req: Request, res: Response) {
        try {
            const runs = await ExporterImportService.getImportRuns();
            return successResponse(res, runs);
        } catch (error: any) {
            return errorResponse(res, "Error fetching import run history", [error.message], 500);
        }
    }

    /**
     * PATCH /api/exporters/:id/resolve-conflict — ADMIN-only.
     * Staff resolution for a held (isPubliclyBlocked) record — e.g.
     * Meridian's county discrepancy: staff pick the correct county
     * (defaulting to the currently-held `county` value if not overridden),
     * generates its verification token, and clears the block.
     * `disputedCounty` is left in place as a permanent audit record of the
     * alternate value that was considered, even after resolution.
     */
    async resolveConflict(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { county, resolutionNotes } = req.body || {};
            const certificate = await this.certificateRepository.findOne({ where: { id, permitOrLicenceType: EXPORTER_PERMIT_TYPE } });
            if (!certificate) return errorResponse(res, "Exporter not found", [], 404);
            if (!certificate.isPubliclyBlocked) {
                return errorResponse(res, "This record is not currently held for review", [], 400);
            }

            if (county) {
                certificate.county = county;
            }
            certificate.isPubliclyBlocked = false;
            certificate.publicBlockReason = resolutionNotes ? `Resolved: ${resolutionNotes}` : null;
            if (!certificate.verificationToken) {
                certificate.verificationToken = require("crypto").randomUUID();
            }
            await this.certificateRepository.save(certificate);

            return successResponse(res, certificate, "Conflict resolved");
        } catch (error: any) {
            return errorResponse(res, "Error resolving conflict", [error.message], 500);
        }
    }
}
