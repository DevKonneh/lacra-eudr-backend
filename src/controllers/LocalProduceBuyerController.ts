/**
 * LocalProduceBuyerController — admin-facing (authenticated) endpoints for
 * the Local Produce Buyer Register page: searchable/paginated listing with
 * county/status filters, downloadable QR PNG per issuance, and the
 * dry-run/apply historical import workflow.
 *
 * The public, unauthenticated QR-scan verification endpoint lives
 * separately in PermitVerificationController (mounted under
 * /api/public/permits/verify/:token) — this controller is the internal
 * CMIS-side view and management surface only.
 */

import { Request, Response } from "express";
import QRCode from "qrcode";
import { AppDataSource } from "../data-source";
import { Certificate } from "../entities/Certificate";
import { Application, ApplicationCategory } from "../entities/Application";
import { successResponse, errorResponse } from "../utils/response";
import { computePublicStatus, liberiaToday } from "../services/PermitVerificationService";
import { LocalProduceBuyerImportService, LocalProduceBuyerImportIntegrityError } from "../services/LocalProduceBuyerImportService";

// Base URL the printed/downloaded QR encodes. Mirrors the existing
// FRONTEND_URL-based pattern used for farmer/farm QR codes
// (AuthController/FarmController), so the admin panel's public verify
// page and the printed-certificate QR always resolve to the same host.
function verificationUrl(token: string): string {
    const base = process.env.FRONTEND_URL || "http://localhost:5173";
    return `${base}/verify/local-produce-buyers/${token}`;
}

export class LocalProduceBuyerController {
    private certificateRepository = AppDataSource.getRepository(Certificate);
    private applicationRepository = AppDataSource.getRepository(Application);

    /**
     * GET /api/local-produce-buyers
     * Searchable/paginated register listing. Query params:
     *   search   — matches buyer name or permit number (case-insensitive)
     *   county   — exact county filter
     *   status   — VALID | EXPIRED | SUSPENDED | REVOKED | PENDING (computed live, not a stored column)
     *   page, pageSize
     */
    async getAll(req: Request, res: Response) {
        try {
            const { search, county, status } = req.query as Record<string, string | undefined>;
            const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
            const pageSize = Math.min(100, Math.max(1, parseInt((req.query.pageSize as string) || "20", 10)));

            const qb = this.certificateRepository
                .createQueryBuilder("cert")
                .where("cert.permitOrLicenceType = :type", { type: "LOCAL_BUYER" });

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

            // Status is computed live (not a stored column), so it is
            // filtered in-memory after fetch rather than in SQL — the
            // register's row count is small enough (low hundreds) that
            // this is simpler and safer than keeping a denormalised
            // status column in sync with the Africa/Monrovia clock.
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
                buyerName: cert.buyerDisplayName,
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
                isRenewal: !!cert.predecessorCertificateId,
                isAgent: !!cert.agencyCertificateId,
                agencyCertificateId: cert.agencyCertificateId,
                hasVerificationToken: !!cert.verificationToken,
                applicationId: cert.applicationId,
            }));

            return successResponse(res, { records: data, total, page, pageSize });
        } catch (error: any) {
            return errorResponse(res, "Error fetching Local Produce Buyer register", [error.message], 500);
        }
    }

    /** GET /api/local-produce-buyers/counties — distinct county list for the filter dropdown. */
    async getCounties(req: Request, res: Response) {
        try {
            const rows = await this.certificateRepository
                .createQueryBuilder("cert")
                .select("DISTINCT cert.county", "county")
                .where("cert.permitOrLicenceType = :type", { type: "LOCAL_BUYER" })
                .andWhere("cert.county IS NOT NULL")
                .orderBy("cert.county", "ASC")
                .getRawMany();
            return successResponse(res, rows.map((r) => r.county));
        } catch (error: any) {
            return errorResponse(res, "Error fetching counties", [error.message], 500);
        }
    }

    /** GET /api/local-produce-buyers/:id/qr-code — downloadable PNG of this certificate's verification QR. */
    async downloadQrCode(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const certificate = await this.certificateRepository.findOne({ where: { id } });
            if (!certificate) return errorResponse(res, "Certificate not found", [], 404);
            if (certificate.isPubliclyBlocked || !certificate.verificationToken) {
                return errorResponse(
                    res,
                    "This record is held pending staff resolution and does not yet have a publishable QR code.",
                    [],
                    409
                );
            }

            const url = verificationUrl(certificate.verificationToken);
            const pngBuffer = await QRCode.toBuffer(url, { type: "png", width: 600 });

            const filename = `${(certificate.buyerDisplayName || "permit").replace(/[^a-zA-Z0-9]+/g, "_")}_Permit_${certificate.certificateNumber}_QR.png`;
            res.setHeader("Content-Type", "image/png");
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            return res.send(pngBuffer);
        } catch (error: any) {
            return errorResponse(res, "Error generating QR code", [error.message], 500);
        }
    }

    /** GET /api/local-produce-buyers/import/preview — ADMIN-only dry run (writes only the audit run row). */
    async previewImport(req: any, res: Response) {
        try {
            const summary = await LocalProduceBuyerImportService.preview({
                performedByUserId: req.user?.id,
                performedByName: req.user?.name,
                recordRun: true,
            });
            return successResponse(res, summary);
        } catch (error: any) {
            if (error instanceof LocalProduceBuyerImportIntegrityError) {
                return errorResponse(res, error.message, [], 409);
            }
            return errorResponse(res, "Error previewing Local Produce Buyer import", [error.message], 500);
        }
    }

    /** POST /api/local-produce-buyers/import/apply — ADMIN-only, idempotent live import. */
    async applyImport(req: any, res: Response) {
        try {
            const summary = await LocalProduceBuyerImportService.apply({
                performedByUserId: req.user?.id,
                performedByName: req.user?.name,
            });
            return successResponse(res, summary, "Import applied");
        } catch (error: any) {
            if (error instanceof LocalProduceBuyerImportIntegrityError) {
                return errorResponse(res, error.message, [], 409);
            }
            return errorResponse(res, "Error applying Local Produce Buyer import", [error.message], 500);
        }
    }

    /** GET /api/local-produce-buyers/import/runs — ADMIN-only import run history. */
    async getImportRuns(req: Request, res: Response) {
        try {
            const runs = await LocalProduceBuyerImportService.getImportRuns();
            return successResponse(res, runs);
        } catch (error: any) {
            return errorResponse(res, "Error fetching import run history", [error.message], 500);
        }
    }

    /**
     * PATCH /api/local-produce-buyers/:id/resolve-conflict — ADMIN-only.
     * Staff resolution for a held (isPubliclyBlocked) record: assigns a
     * corrected certificateNumber (required when the record is currently
     * holding a stagedPermitNumber rather than a real certificateNumber),
     * generates its verification token, and clears the block. The OTHER
     * side of a shared-number conflict is NOT auto-resolved by this call —
     * each held record must be explicitly resolved on its own.
     */
    async resolveConflict(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { certificateNumber, resolutionNotes } = req.body || {};
            const certificate = await this.certificateRepository.findOne({ where: { id } });
            if (!certificate) return errorResponse(res, "Certificate not found", [], 404);
            if (!certificate.isPubliclyBlocked) {
                return errorResponse(res, "This record is not currently held for review", [], 400);
            }

            const finalNumber = certificateNumber || certificate.certificateNumber;
            if (!finalNumber) {
                return errorResponse(res, "A certificateNumber is required to resolve this conflict", [], 400);
            }

            const clash = await this.certificateRepository.findOne({ where: { certificateNumber: finalNumber } });
            if (clash && clash.id !== certificate.id) {
                return errorResponse(res, `Certificate number ${finalNumber} is already assigned to another record`, [], 409);
            }

            certificate.certificateNumber = finalNumber;
            certificate.stagedPermitNumber = null;
            certificate.isPubliclyBlocked = false;
            certificate.publicBlockReason = resolutionNotes
                ? `Resolved: ${resolutionNotes}`
                : null;
            if (!certificate.verificationToken) {
                certificate.verificationToken = require("crypto").randomUUID();
            }
            await this.certificateRepository.save(certificate);

            return successResponse(res, certificate, "Conflict resolved");
        } catch (error: any) {
            return errorResponse(res, "Error resolving conflict", [error.message], 500);
        }
    }

    /**
     * POST /api/local-produce-buyers/:id/link-agency — ADMIN-only.
     * Explicit, validated go-forward link from a buyer's certificate to an
     * agency's certificate, so the register displays this buyer as an
     * "Agent" under the named agency rather than as an independent Local
     * Produce Buyer. Requires the target to be an actual AGENCY-category
     * certificate — never inferred/guessed.
     */
    async linkAgency(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { agencyCertificateId } = req.body || {};
            if (!agencyCertificateId) return errorResponse(res, "agencyCertificateId is required", [], 400);

            const certificate = await this.certificateRepository.findOne({ where: { id } });
            if (!certificate) return errorResponse(res, "Certificate not found", [], 404);

            const agencyCertificate = await this.certificateRepository.findOne({ where: { id: agencyCertificateId } });
            if (!agencyCertificate) return errorResponse(res, "Agency certificate not found", [], 404);
            if (agencyCertificate.permitOrLicenceType !== ApplicationCategory.AGENCY) {
                return errorResponse(res, "Target certificate is not an Agency-category certificate", [], 400);
            }

            certificate.agencyCertificateId = agencyCertificate.id;
            await this.certificateRepository.save(certificate);

            return successResponse(res, certificate, "Buyer linked to agency as Agent");
        } catch (error: any) {
            return errorResponse(res, "Error linking buyer to agency", [error.message], 500);
        }
    }
}
