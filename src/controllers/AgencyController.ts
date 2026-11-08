/**
 * AgencyController — admin-facing (authenticated) endpoints for the
 * Agency Register page and Agency profile: searchable/paginated listing
 * with county/status/staffing filters, per-Agency and per-Agent
 * downloadable QR PNGs, Agents/Clerk roster management (appointment,
 * replacement, deactivation), and the dry-run/apply historical import
 * workflow.
 *
 * Mirrors LocalProduceBuyerController's structure closely. The public,
 * unauthenticated QR-scan verification endpoints live separately in
 * PermitVerificationController (mounted under
 * /api/public/agencies/verify/:token and /api/public/agents/verify/:token)
 * — this controller is the internal CMIS-side view and management
 * surface only.
 */

import { Request, Response } from "express";
import QRCode from "qrcode";
import * as crypto from "crypto";
import { AppDataSource } from "../data-source";
import { Certificate } from "../entities/Certificate";
import { Application, ApplicationCategory } from "../entities/Application";
import { AgentPersonnel, AgentPersonnelRole, AgentPersonnelStatus } from "../entities/AgentPersonnel";
import { successResponse, errorResponse } from "../utils/response";
import { computePublicStatus } from "../services/PermitVerificationService";
import { computeAgencyStaffing, computeAndRefreshStaffingFlag } from "../services/AgencyStaffingService";
import { AgencyImportService, AgencyImportIntegrityError } from "../services/AgencyImportService";

function agencyVerificationUrl(token: string): string {
    const base = process.env.FRONTEND_URL || "http://localhost:5173";
    return `${base}/verify/agencies/${token}`;
}

function agentVerificationUrl(token: string): string {
    const base = process.env.FRONTEND_URL || "http://localhost:5173";
    return `${base}/verify/agents/${token}`;
}

export class AgencyController {
    private certificateRepository = AppDataSource.getRepository(Certificate);
    private applicationRepository = AppDataSource.getRepository(Application);
    private personnelRepository = AppDataSource.getRepository(AgentPersonnel);

    /**
     * GET /api/agencies
     * Searchable/paginated register listing. Query params:
     *   search    — matches agency name or permit number (case-insensitive)
     *   county    — exact county filter
     *   status    — VALID | EXPIRED | SUSPENDED | REVOKED | PENDING (computed live)
     *   staffing  — COMPLETE | INCOMPLETE (staffing-completeness filter, new
     *               filter dimension not present on the Local Produce Buyer
     *               register, per the spec's "filters for staffing
     *               completeness" requirement)
     *   page, pageSize
     */
    async getAll(req: Request, res: Response) {
        try {
            const { search, county, status, staffing } = req.query as Record<string, string | undefined>;
            const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
            const pageSize = Math.min(100, Math.max(1, parseInt((req.query.pageSize as string) || "20", 10)));

            const qb = this.certificateRepository
                .createQueryBuilder("cert")
                .where("cert.permitOrLicenceType = :type", { type: ApplicationCategory.AGENCY });

            if (search) {
                qb.andWhere("(cert.buyerDisplayName ILIKE :search OR cert.certificateNumber ILIKE :search OR cert.stagedPermitNumber ILIKE :search)", {
                    search: `%${search}%`,
                });
            }
            if (county) {
                qb.andWhere("cert.county = :county", { county });
            }
            if (staffing === "INCOMPLETE") {
                qb.andWhere("cert.staffingFlagged = true");
            } else if (staffing === "COMPLETE") {
                qb.andWhere("cert.staffingFlagged = false");
            }

            qb.orderBy("cert.buyerDisplayName", "ASC");
            const allMatching = await qb.getMany();

            const applicationIds = [...new Set(allMatching.map((c) => c.applicationId))];
            const applications = applicationIds.length ? await this.applicationRepository.findByIds(applicationIds) : [];
            const applicationById = new Map(applications.map((a) => [a.id, a]));

            // Staffing summary per agency — small result set (11 historical
            // + whatever live agencies exist), so N+1-style per-row
            // computeAgencyStaffing() calls are acceptable here exactly like
            // LocalProduceBuyerController's in-memory status computation.
            const staffingByCertId = new Map<string, Awaited<ReturnType<typeof computeAgencyStaffing>>>();
            for (const cert of allMatching) {
                staffingByCertId.set(cert.id, await computeAgencyStaffing(AppDataSource, cert.id));
            }

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

            const data = paged.map(({ certificate: cert, computedStatus }) => {
                const staffingSummary = staffingByCertId.get(cert.id)!;
                return {
                    id: cert.id,
                    agencyName: cert.buyerDisplayName,
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
                    staffing: {
                        activeAgents: staffingSummary.activeAgents,
                        activeClerks: staffingSummary.activeClerks,
                        requiredAgents: staffingSummary.requiredAgents,
                        requiredClerks: staffingSummary.requiredClerks,
                        meetsRequirement: staffingSummary.meetsRequirement,
                        flagged: cert.staffingFlagged,
                        flagReason: cert.staffingFlagReason,
                    },
                };
            });

            return successResponse(res, { records: data, total, page, pageSize });
        } catch (error: any) {
            return errorResponse(res, "Error fetching Agency register", [error.message], 500);
        }
    }

    /** GET /api/agencies/counties — distinct county list for the filter dropdown. */
    async getCounties(req: Request, res: Response) {
        try {
            const rows = await this.certificateRepository
                .createQueryBuilder("cert")
                .select("DISTINCT cert.county", "county")
                .where("cert.permitOrLicenceType = :type", { type: ApplicationCategory.AGENCY })
                .andWhere("cert.county IS NOT NULL")
                .orderBy("cert.county", "ASC")
                .getRawMany();
            return successResponse(res, rows.map((r) => r.county));
        } catch (error: any) {
            return errorResponse(res, "Error fetching counties", [error.message], 500);
        }
    }

    /**
     * GET /api/agencies/:id — full Agency profile: certificate record,
     * live status, staffing summary, and the separate Agents / Clerk
     * roster sections (each person's full appointment/replacement/
     * deactivation history included).
     */
    async getOne(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const certificate = await this.certificateRepository.findOne({ where: { id, permitOrLicenceType: ApplicationCategory.AGENCY } });
            if (!certificate) return errorResponse(res, "Agency not found", [], 404);

            const application = await this.applicationRepository.findOne({ where: { id: certificate.applicationId } });
            const computedStatus = application ? computePublicStatus(certificate, application) : "PENDING";

            const personnel = await this.personnelRepository.find({ where: { agencyCertificateId: id }, order: { createdAt: "ASC" } });
            const agents = personnel.filter((p) => p.role === AgentPersonnelRole.AGENT);
            const clerks = personnel.filter((p) => p.role === AgentPersonnelRole.CLERK);
            const staffingSummary = await computeAgencyStaffing(AppDataSource, id);

            return successResponse(res, {
                id: certificate.id,
                agencyName: certificate.buyerDisplayName,
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
                staffing: {
                    activeAgents: staffingSummary.activeAgents,
                    activeClerks: staffingSummary.activeClerks,
                    requiredAgents: staffingSummary.requiredAgents,
                    requiredClerks: staffingSummary.requiredClerks,
                    meetsRequirement: staffingSummary.meetsRequirement,
                    flagged: certificate.staffingFlagged,
                    flagReason: certificate.staffingFlagReason,
                    summaryLabel: `${staffingSummary.activeAgents} of ${staffingSummary.requiredAgents} required Agents · ${staffingSummary.activeClerks} of ${staffingSummary.requiredClerks} Clerk`,
                },
                agents,
                clerks,
            });
        } catch (error: any) {
            return errorResponse(res, "Error fetching Agency profile", [error.message], 500);
        }
    }

    /** GET /api/agencies/:id/qr-code — downloadable PNG of this Agency's verification QR. */
    async downloadQrCode(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const certificate = await this.certificateRepository.findOne({ where: { id, permitOrLicenceType: ApplicationCategory.AGENCY } });
            if (!certificate) return errorResponse(res, "Agency not found", [], 404);
            if (certificate.isPubliclyBlocked || !certificate.verificationToken) {
                return errorResponse(res, "This record is held pending staff resolution and does not yet have a publishable QR code.", [], 409);
            }

            const url = agencyVerificationUrl(certificate.verificationToken);
            const pngBuffer = await QRCode.toBuffer(url, { type: "png", width: 600 });
            const filename = `${(certificate.buyerDisplayName || "agency").replace(/[^a-zA-Z0-9]+/g, "_")}_Agency_Permit_${certificate.certificateNumber}_QR.png`;
            res.setHeader("Content-Type", "image/png");
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            return res.send(pngBuffer);
        } catch (error: any) {
            return errorResponse(res, "Error generating QR code", [error.message], 500);
        }
    }

    /** GET /api/agencies/:id/personnel/:personnelId/qr-code — downloadable PNG of an Agent's own verification QR (Clerks have no QR). */
    async downloadPersonnelQrCode(req: Request, res: Response) {
        try {
            const { id, personnelId } = req.params;
            const person = await this.personnelRepository.findOne({ where: { id: personnelId, agencyCertificateId: id } });
            if (!person) return errorResponse(res, "Personnel record not found", [], 404);
            if (person.role !== AgentPersonnelRole.AGENT) {
                return errorResponse(res, "Only Agents have an individual verification QR code — Clerks are internal staffing records only.", [], 400);
            }
            if (person.isPubliclyBlocked || !person.verificationToken) {
                return errorResponse(res, "This record is held pending staff resolution and does not yet have a publishable QR code.", [], 409);
            }

            const url = agentVerificationUrl(person.verificationToken);
            const pngBuffer = await QRCode.toBuffer(url, { type: "png", width: 600 });
            const filename = `${(person.fullName || "agent").replace(/[^a-zA-Z0-9]+/g, "_")}_Agent_${person.permitNumber}_QR.png`;
            res.setHeader("Content-Type", "image/png");
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            return res.send(pngBuffer);
        } catch (error: any) {
            return errorResponse(res, "Error generating QR code", [error.message], 500);
        }
    }

    /**
     * POST /api/agencies/:id/personnel — appoint a new Agent or Clerk to
     * this Agency. Agents are always given the Agency's own CURRENT permit
     * number (certificateNumber, or stagedPermitNumber if the Agency
     * itself is still held pending conflict resolution) at the moment of
     * appointment — per spec, "Every Agent carries the same permit number
     * as their parent Agency". Recomputes and persists the staffing flag
     * immediately after.
     */
    async appointPersonnel(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { role, fullName, county, nationalId, phone } = req.body || {};
            if (!role || !["AGENT", "CLERK"].includes(role)) {
                return errorResponse(res, "role must be 'AGENT' or 'CLERK'", [], 400);
            }
            if (!fullName || !String(fullName).trim()) {
                return errorResponse(res, "fullName is required", [], 400);
            }

            const certificate = await this.certificateRepository.findOne({ where: { id, permitOrLicenceType: ApplicationCategory.AGENCY } });
            if (!certificate) return errorResponse(res, "Agency not found", [], 404);

            const isClerk = role === "CLERK";
            const permitNumber = isClerk ? null : certificate.certificateNumber || certificate.stagedPermitNumber || null;
            const isPubliclyBlocked = !isClerk && (certificate.isPubliclyBlocked || !certificate.verificationToken);

            const person = this.personnelRepository.create({
                agencyCertificateId: certificate.id,
                role: isClerk ? AgentPersonnelRole.CLERK : AgentPersonnelRole.AGENT,
                fullName: String(fullName).trim(),
                permitNumber,
                county: county || null,
                nationalId: nationalId || null,
                phone: phone || null,
                status: AgentPersonnelStatus.ACTIVE,
                appointedAt: new Date(),
                verificationToken: isClerk || isPubliclyBlocked ? null : crypto.randomUUID(),
                isPubliclyBlocked: isClerk ? false : isPubliclyBlocked,
                publicBlockReason: isPubliclyBlocked ? "Parent Agency's permit is currently held pending staff resolution — this Agent cannot be publicly verified until the Agency's conflict is resolved." : null,
                requiresAgencyConfirmation: false,
                historyLog: [
                    {
                        action: "APPOINTED",
                        date: new Date().toISOString(),
                        performedByName: req.user?.name || "Staff",
                    },
                ],
            });
            await this.personnelRepository.save(person);

            const staffingSummary = await computeAndRefreshStaffingFlag(AppDataSource, certificate.id);

            return successResponse(res, { person, staffing: staffingSummary }, `${isClerk ? "Clerk" : "Agent"} appointed`);
        } catch (error: any) {
            return errorResponse(res, "Error appointing personnel", [error.message], 500);
        }
    }

    /**
     * POST /api/agencies/:id/personnel/:personnelId/replace — replaces an
     * existing Agent/Clerk with a new appointee in the same role. The OLD
     * person's record is preserved (status=REPLACED, never deleted) with
     * a history entry naming the replacement; a brand-new AgentPersonnel
     * row is created for the new appointee with its own fresh
     * verification token (Agents) — the new person is a distinct
     * individual with their own identity, not a renamed continuation of
     * the old record, per spec's "unique internal record" requirement.
     */
    async replacePersonnel(req: any, res: Response) {
        try {
            const { id, personnelId } = req.params;
            const { fullName, county, nationalId, phone, reason } = req.body || {};
            if (!fullName || !String(fullName).trim()) {
                return errorResponse(res, "fullName is required for the replacement appointee", [], 400);
            }

            const certificate = await this.certificateRepository.findOne({ where: { id, permitOrLicenceType: ApplicationCategory.AGENCY } });
            if (!certificate) return errorResponse(res, "Agency not found", [], 404);

            const outgoing = await this.personnelRepository.findOne({ where: { id: personnelId, agencyCertificateId: id } });
            if (!outgoing) return errorResponse(res, "Personnel record not found", [], 404);
            if (outgoing.status !== AgentPersonnelStatus.ACTIVE) {
                return errorResponse(res, "Only an active personnel record can be replaced", [], 400);
            }

            const isClerk = outgoing.role === AgentPersonnelRole.CLERK;
            const permitNumber = isClerk ? null : certificate.certificateNumber || certificate.stagedPermitNumber || null;
            const isPubliclyBlocked = !isClerk && (certificate.isPubliclyBlocked || !certificate.verificationToken);

            const incoming = this.personnelRepository.create({
                agencyCertificateId: certificate.id,
                role: outgoing.role,
                fullName: String(fullName).trim(),
                permitNumber,
                county: county || outgoing.county,
                nationalId: nationalId || null,
                phone: phone || null,
                status: AgentPersonnelStatus.ACTIVE,
                appointedAt: new Date(),
                verificationToken: isClerk || isPubliclyBlocked ? null : crypto.randomUUID(),
                isPubliclyBlocked: isClerk ? false : isPubliclyBlocked,
                publicBlockReason: isPubliclyBlocked ? "Parent Agency's permit is currently held pending staff resolution — this Agent cannot be publicly verified until the Agency's conflict is resolved." : null,
                requiresAgencyConfirmation: false,
                historyLog: [
                    {
                        action: "APPOINTED",
                        date: new Date().toISOString(),
                        note: `Appointed to replace ${outgoing.fullName} (record ${outgoing.id}).`,
                        performedByName: req.user?.name || "Staff",
                    },
                ],
            });
            await this.personnelRepository.save(incoming);

            outgoing.status = AgentPersonnelStatus.REPLACED;
            outgoing.deactivatedAt = new Date();
            outgoing.deactivationReason = reason || `Replaced by ${incoming.fullName}.`;
            outgoing.historyLog = [
                ...(outgoing.historyLog || []),
                {
                    action: "REPLACED",
                    date: new Date().toISOString(),
                    note: `Replaced by ${incoming.fullName} (record ${incoming.id}).${reason ? ` Reason: ${reason}` : ""}`,
                    performedByName: req.user?.name || "Staff",
                },
            ];
            await this.personnelRepository.save(outgoing);

            const staffingSummary = await computeAndRefreshStaffingFlag(AppDataSource, certificate.id);

            return successResponse(res, { outgoing, incoming, staffing: staffingSummary }, "Personnel replaced");
        } catch (error: any) {
            return errorResponse(res, "Error replacing personnel", [error.message], 500);
        }
    }

    /**
     * PATCH /api/agencies/:id/personnel/:personnelId/deactivate —
     * deactivates an Agent/Clerk without appointing a replacement.
     * Preserves the record (status=INACTIVE, never deleted); the
     * person's verification token (if any) is left in place on the row
     * but computeAgentPublicStatus() will now report AGENT_NOT_ACTIVE for
     * any future scan, per PermitVerificationService's doc comment.
     */
    async deactivatePersonnel(req: any, res: Response) {
        try {
            const { id, personnelId } = req.params;
            const { reason } = req.body || {};

            const certificate = await this.certificateRepository.findOne({ where: { id, permitOrLicenceType: ApplicationCategory.AGENCY } });
            if (!certificate) return errorResponse(res, "Agency not found", [], 404);

            const person = await this.personnelRepository.findOne({ where: { id: personnelId, agencyCertificateId: id } });
            if (!person) return errorResponse(res, "Personnel record not found", [], 404);
            if (person.status !== AgentPersonnelStatus.ACTIVE) {
                return errorResponse(res, "This personnel record is not currently active", [], 400);
            }

            person.status = AgentPersonnelStatus.INACTIVE;
            person.deactivatedAt = new Date();
            person.deactivationReason = reason || null;
            person.historyLog = [
                ...(person.historyLog || []),
                {
                    action: "DEACTIVATED",
                    date: new Date().toISOString(),
                    note: reason || undefined,
                    performedByName: req.user?.name || "Staff",
                },
            ];
            await this.personnelRepository.save(person);

            const staffingSummary = await computeAndRefreshStaffingFlag(AppDataSource, certificate.id);

            return successResponse(res, { person, staffing: staffingSummary }, "Personnel deactivated");
        } catch (error: any) {
            return errorResponse(res, "Error deactivating personnel", [error.message], 500);
        }
    }

    /**
     * POST /api/agencies/:id/personnel/:personnelId/link — ADMIN-only.
     * Explicit staff action confirming the parent Agency for a
     * historically-imported Agent whose candidateAgencySourceRecordId was
     * null (requiresAgencyConfirmation=true) — e.g. Ousmane Sow, Larry
     * Clark, Sekou K. Sheriff. :id is the TARGET Agency's certificate id;
     * :personnelId is the unassigned person being linked. Also used to
     * (re-)link one of the five people excluded from the Local Produce
     * Buyer import once LACRA confirms their Agency, should staff choose
     * to create an AgentPersonnel record for them through this same
     * mechanism in the future.
     */
    async linkPersonnelToAgency(req: any, res: Response) {
        try {
            const { id, personnelId } = req.params;
            const certificate = await this.certificateRepository.findOne({ where: { id, permitOrLicenceType: ApplicationCategory.AGENCY } });
            if (!certificate) return errorResponse(res, "Target agency not found", [], 404);

            const person = await this.personnelRepository.findOne({ where: { id: personnelId } });
            if (!person) return errorResponse(res, "Personnel record not found", [], 404);

            const isClerk = person.role === AgentPersonnelRole.CLERK;
            const permitNumber = isClerk ? null : certificate.certificateNumber || certificate.stagedPermitNumber || null;
            const isPubliclyBlocked = !isClerk && (certificate.isPubliclyBlocked || !certificate.verificationToken);

            person.agencyCertificateId = certificate.id;
            person.permitNumber = permitNumber;
            person.requiresAgencyConfirmation = false;
            person.isPubliclyBlocked = isClerk ? false : isPubliclyBlocked;
            person.publicBlockReason = isPubliclyBlocked ? "Parent Agency's permit is currently held pending staff resolution — this Agent cannot be publicly verified until the Agency's conflict is resolved." : null;
            if (!isClerk && !isPubliclyBlocked && !person.verificationToken) {
                person.verificationToken = crypto.randomUUID();
            }
            person.historyLog = [
                ...(person.historyLog || []),
                {
                    action: "AGENCY_CONFIRMED",
                    date: new Date().toISOString(),
                    note: `Parent Agency confirmed as ${certificate.buyerDisplayName} by staff.`,
                    performedByName: req.user?.name || "Staff",
                },
            ];
            await this.personnelRepository.save(person);

            const staffingSummary = await computeAndRefreshStaffingFlag(AppDataSource, certificate.id);

            return successResponse(res, { person, staffing: staffingSummary }, "Personnel linked to Agency");
        } catch (error: any) {
            return errorResponse(res, "Error linking personnel to agency", [error.message], 500);
        }
    }

    /**
     * GET /api/agencies/personnel/unassigned — ADMIN-only. Lists every
     * AgentPersonnel row with requiresAgencyConfirmation=true (the three
     * historical Agents with no candidateAgencySourceRecordId), for the
     * "pending staff confirmation" admin worklist.
     */
    async getUnassignedPersonnel(req: Request, res: Response) {
        try {
            const rows = await this.personnelRepository
                .createQueryBuilder("p")
                .where("p.requiresAgencyConfirmation = true")
                .andWhere("p.agencyCertificateId IS NULL")
                .orderBy("p.createdAt", "ASC")
                .getMany();
            return successResponse(res, rows);
        } catch (error: any) {
            return errorResponse(res, "Error fetching unassigned personnel", [error.message], 500);
        }
    }

    /** GET /api/agencies/import/preview — ADMIN-only dry run (writes only the audit run row). */
    async previewImport(req: any, res: Response) {
        try {
            const summary = await AgencyImportService.preview({
                performedByUserId: req.user?.id,
                performedByName: req.user?.name,
                recordRun: true,
            });
            return successResponse(res, summary);
        } catch (error: any) {
            if (error instanceof AgencyImportIntegrityError) {
                return errorResponse(res, error.message, [], 409);
            }
            return errorResponse(res, "Error previewing Agency import", [error.message], 500);
        }
    }

    /** POST /api/agencies/import/apply — ADMIN-only, idempotent live import. */
    async applyImport(req: any, res: Response) {
        try {
            const summary = await AgencyImportService.apply({
                performedByUserId: req.user?.id,
                performedByName: req.user?.name,
            });
            return successResponse(res, summary, "Import applied");
        } catch (error: any) {
            if (error instanceof AgencyImportIntegrityError) {
                return errorResponse(res, error.message, [], 409);
            }
            return errorResponse(res, "Error applying Agency import", [error.message], 500);
        }
    }

    /** GET /api/agencies/import/runs — ADMIN-only import run history. */
    async getImportRuns(req: Request, res: Response) {
        try {
            const runs = await AgencyImportService.getImportRuns();
            return successResponse(res, runs);
        } catch (error: any) {
            return errorResponse(res, "Error fetching import run history", [error.message], 500);
        }
    }

    /**
     * PATCH /api/agencies/:id/resolve-conflict — ADMIN-only. Staff
     * resolution for a held (isPubliclyBlocked) Agency record: assigns a
     * corrected certificateNumber, generates its verification token,
     * clears the block, and propagates the corrected permit number onto
     * every currently-ACTIVE Agent under this Agency (so "Agents share the
     * Agency's permit number" remains true after a conflict correction,
     * per spec) — each affected Agent also gets a fresh verification
     * token if the Agency's own block being cleared is what was stopping
     * them from having one.
     */
    async resolveConflict(req: any, res: Response) {
        try {
            const { id } = req.params;
            const { certificateNumber, resolutionNotes } = req.body || {};
            const certificate = await this.certificateRepository.findOne({ where: { id, permitOrLicenceType: ApplicationCategory.AGENCY } });
            if (!certificate) return errorResponse(res, "Agency not found", [], 404);
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
            certificate.publicBlockReason = resolutionNotes ? `Resolved: ${resolutionNotes}` : null;
            if (!certificate.verificationToken) {
                certificate.verificationToken = crypto.randomUUID();
            }
            await this.certificateRepository.save(certificate);

            const activeAgents = await this.personnelRepository.find({
                where: { agencyCertificateId: certificate.id, role: AgentPersonnelRole.AGENT, status: AgentPersonnelStatus.ACTIVE },
            });
            for (const agent of activeAgents) {
                agent.permitNumber = finalNumber;
                agent.isPubliclyBlocked = false;
                agent.publicBlockReason = null;
                if (!agent.verificationToken) agent.verificationToken = crypto.randomUUID();
                agent.historyLog = [
                    ...(agent.historyLog || []),
                    {
                        action: "AGENCY_CONFLICT_RESOLVED",
                        date: new Date().toISOString(),
                        note: `Parent Agency's permit number corrected to ${finalNumber}; this Agent's record updated to match.`,
                        performedByName: req.user?.name || "Staff",
                    },
                ];
                await this.personnelRepository.save(agent);
            }

            return successResponse(res, { certificate, updatedAgentCount: activeAgents.length }, "Conflict resolved");
        } catch (error: any) {
            return errorResponse(res, "Error resolving conflict", [error.message], 500);
        }
    }
}
