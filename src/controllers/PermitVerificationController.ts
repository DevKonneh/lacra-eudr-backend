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
import { toPublicPermitView, hasIssuedPermitNumber } from "../services/PermitVerificationService";

export class PermitVerificationController {
    private certificateRepository = AppDataSource.getRepository(Certificate);
    private applicationRepository = AppDataSource.getRepository(Application);

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
}
