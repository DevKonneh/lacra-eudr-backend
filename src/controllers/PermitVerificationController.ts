/**
 * PermitVerificationController — public, unauthenticated QR verification
 * for Local Produce Buyer permits.
 *
 * GET /api/public/permits/verify/:token
 *
 * This is what the QR code printed on (and downloadable from the register
 * for) a Local Produce Buyer certificate resolves to. Mirrors
 * FarmScanController's "intentionally unauthenticated, no farmer/business
 * PII beyond an approved whitelist" pattern. Status is ALWAYS computed
 * live at request time (never read from a value baked into the QR/PNG
 * itself) via PermitVerificationService, so the same printed QR keeps
 * resolving correctly forever — including after the permit expires, after
 * a renewal creates a new certificate+token (the OLD token keeps
 * resolving to the OLD, now-likely-expired record), and if the permit is
 * later suspended/revoked.
 */

import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Certificate } from "../entities/Certificate";
import { Application } from "../entities/Application";
import { AgentPersonnel } from "../entities/AgentPersonnel";
import { toPublicPermitView, hasIssuedPermitNumber, toPublicAgentView, hasIssuedAgentPermitNumber } from "../services/PermitVerificationService";
import { COOPERATIVE_PERMIT_TYPE } from "../services/ManualLicenseEntryService";

export class PermitVerificationController {
    private certificateRepository = AppDataSource.getRepository(Certificate);
    private applicationRepository = AppDataSource.getRepository(Application);
    private agentPersonnelRepository = AppDataSource.getRepository(AgentPersonnel);

    async verifyByToken(req: Request, res: Response) {
        try {
            const { token } = req.params;
            if (!token) {
                return res.status(400).json({ success: false, message: "Missing verification token" });
            }

            const certificate = await this.certificateRepository.findOne({ where: { verificationToken: token } });

            // Deliberately identical 404 response whether the token is
            // simply unknown, belongs to a held/blocked record, OR belongs
            // to a record with no actual issued permit number — a blocked
            // record's existence must not be revealed to an
            // unauthenticated scanner, and the response shape must not
            // let a caller distinguish "never existed" from "blocked
            // pending staff review" from "has a token but no permit
            // number was ever issued" (a state that should never occur in
            // normal operation, but which a mishandled rollback/re-import
            // could otherwise produce — see hasIssuedPermitNumber()).
            if (!certificate || certificate.isPubliclyBlocked || !hasIssuedPermitNumber(certificate)) {
                return res.status(404).json({
                    success: false,
                    message: "This permit could not be verified. The QR code may be invalid or the record is not yet published.",
                });
            }

            const application = await this.applicationRepository.findOne({ where: { id: certificate.applicationId } });
            if (!application) {
                return res.status(404).json({
                    success: false,
                    message: "This permit could not be verified. The QR code may be invalid or the record is not yet published.",
                });
            }

            // toPublicPermitView() is the single source of truth for the
            // approved field whitelist (buyer name, county, permit
            // number, issue date, expiry date, status) — no other field
            // from either entity is ever spread into this response.
            const view = toPublicPermitView(certificate, application);
            return res.status(200).json({ success: true, data: view });
        } catch (error: any) {
            return res.status(500).json({ success: false, message: "Error verifying permit", errors: [error.message] });
        }
    }

    /**
     * GET /api/public/agencies/verify/:token
     *
     * What an Agency's own printed/downloadable QR code resolves to.
     * Certificate.verificationToken is already a single unique column
     * across every permitOrLicenceType, so this is functionally
     * equivalent to verifyByToken() above — kept as its own named method
     * (rather than just pointing the route at verifyByToken) so the
     * public-facing URL and the response shape are allowed to diverge
     * for Agencies in the future (e.g. a staffing-completeness badge)
     * without touching the Local Produce Buyer route's contract.
     */
    async verifyAgencyToken(req: Request, res: Response) {
        try {
            const { token } = req.params;
            if (!token) {
                return res.status(400).json({ success: false, message: "Missing verification token" });
            }

            const certificate = await this.certificateRepository.findOne({ where: { verificationToken: token, permitOrLicenceType: "AGENCY" } });
            if (!certificate || certificate.isPubliclyBlocked || !hasIssuedPermitNumber(certificate)) {
                return res.status(404).json({
                    success: false,
                    message: "This permit could not be verified. The QR code may be invalid or the record is not yet published.",
                });
            }

            const application = await this.applicationRepository.findOne({ where: { id: certificate.applicationId } });
            if (!application) {
                return res.status(404).json({
                    success: false,
                    message: "This permit could not be verified. The QR code may be invalid or the record is not yet published.",
                });
            }

            const view = toPublicPermitView(certificate, application);
            return res.status(200).json({ success: true, data: view });
        } catch (error: any) {
            return res.status(500).json({ success: false, message: "Error verifying agency permit", errors: [error.message] });
        }
    }

    /**
     * GET /api/public/exporters/verify/:token
     *
     * What an Exporter's own printed/downloadable QR code resolves to.
     * Certificate.verificationToken is already a single unique column
     * across every permitOrLicenceType, so this is functionally
     * equivalent to verifyByToken() above — kept as its own named method
     * (mirrors verifyAgencyToken()) so the public-facing URL and response
     * shape are allowed to diverge for Exporters in the future without
     * touching any other register's route contract. A held/blocked record
     * (e.g. Meridian Commodity Inc., pending county confirmation) and a
     * genuinely nonexistent token return the exact same 404, matching
     * every other register's existence-hiding behavior.
     */
    async verifyExporterToken(req: Request, res: Response) {
        try {
            const { token } = req.params;
            if (!token) {
                return res.status(400).json({ success: false, message: "Missing verification token" });
            }

            const certificate = await this.certificateRepository.findOne({ where: { verificationToken: token, permitOrLicenceType: "EXPORTER" } });
            if (!certificate || certificate.isPubliclyBlocked || !hasIssuedPermitNumber(certificate)) {
                return res.status(404).json({
                    success: false,
                    message: "This export license could not be verified. The QR code may be invalid or the record is not yet published.",
                });
            }

            const application = await this.applicationRepository.findOne({ where: { id: certificate.applicationId } });
            if (!application) {
                return res.status(404).json({
                    success: false,
                    message: "This export license could not be verified. The QR code may be invalid or the record is not yet published.",
                });
            }

            const view = toPublicPermitView(certificate, application);
            return res.status(200).json({ success: true, data: view });
        } catch (error: any) {
            return res.status(500).json({ success: false, message: "Error verifying export license", errors: [error.message] });
        }
    }

    /**
     * GET /api/public/cooperatives/verify/:token
     *
     * What a Cooperative's own printed/downloadable QR code resolves to.
     * Certificate.verificationToken is already a single unique column
     * across every permitOrLicenceType, so this is functionally
     * equivalent to verifyByToken() above — kept as its own named method
     * (mirrors verifyAgencyToken()/verifyExporterToken()) so the
     * public-facing URL and response shape are allowed to diverge for
     * Cooperatives in the future without touching any other register's
     * route contract. Identical 404 for unknown/blocked/no-permit-number
     * tokens, matching every other register's existence-hiding behavior.
     */
    async verifyCooperativeToken(req: Request, res: Response) {
        try {
            const { token } = req.params;
            if (!token) {
                return res.status(400).json({ success: false, message: "Missing verification token" });
            }

            const certificate = await this.certificateRepository.findOne({ where: { verificationToken: token, permitOrLicenceType: COOPERATIVE_PERMIT_TYPE } });
            if (!certificate || certificate.isPubliclyBlocked || !hasIssuedPermitNumber(certificate)) {
                return res.status(404).json({
                    success: false,
                    message: "This permit could not be verified. The QR code may be invalid or the record is not yet published.",
                });
            }

            const application = await this.applicationRepository.findOne({ where: { id: certificate.applicationId } });
            if (!application) {
                return res.status(404).json({
                    success: false,
                    message: "This permit could not be verified. The QR code may be invalid or the record is not yet published.",
                });
            }

            const view = toPublicPermitView(certificate, application);
            return res.status(200).json({ success: true, data: view });
        } catch (error: any) {
            return res.status(500).json({ success: false, message: "Error verifying cooperative permit", errors: [error.message] });
        }
    }

    /**
     * GET /api/public/agents/verify/:token
     *
     * What an individual Agent's own printed/downloadable QR code resolves
     * to — distinct from the Agency's own token so a scanner can always
     * verify the specific person, even when several Agents share the same
     * Agency permit number printed on their card. Returns the Agent's
     * name, role, parent Agency name, and the shared permit number, plus
     * a live status that additionally checks the Agent's own current
     * authorization (see computeAgentPublicStatus()'s doc comment).
     * Identical 404 for unknown/blocked/no-permit-number tokens, matching
     * verifyByToken()'s existence-hiding behavior.
     */
    async verifyAgentToken(req: Request, res: Response) {
        try {
            const { token } = req.params;
            if (!token) {
                return res.status(400).json({ success: false, message: "Missing verification token" });
            }

            const agent = await this.agentPersonnelRepository.findOne({ where: { verificationToken: token } });
            if (!agent || agent.isPubliclyBlocked || !hasIssuedAgentPermitNumber(agent)) {
                return res.status(404).json({
                    success: false,
                    message: "This permit could not be verified. The QR code may be invalid or the record is not yet published.",
                });
            }

            let agencyCertificate: Certificate | null = null;
            let agencyApplication: Application | null = null;
            if (agent.agencyCertificateId) {
                agencyCertificate = await this.certificateRepository.findOne({ where: { id: agent.agencyCertificateId } });
                if (agencyCertificate) {
                    agencyApplication = await this.applicationRepository.findOne({ where: { id: agencyCertificate.applicationId } });
                }
            }

            if (!agencyCertificate || !agencyApplication) {
                // An Agent with no confirmed parent Agency (or whose parent
                // Agency record is itself missing) has nothing to verify
                // against — identical 404 rather than partial data.
                return res.status(404).json({
                    success: false,
                    message: "This permit could not be verified. The QR code may be invalid or the record is not yet published.",
                });
            }

            const view = toPublicAgentView(agent, agencyCertificate, agencyApplication);
            return res.status(200).json({ success: true, data: view });
        } catch (error: any) {
            return res.status(500).json({ success: false, message: "Error verifying agent permit", errors: [error.message] });
        }
    }
}
