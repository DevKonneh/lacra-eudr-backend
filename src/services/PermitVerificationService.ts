/**
 * PermitVerificationService — shared live status computation for public
 * permit/certificate verification endpoints.
 *
 * Used by BOTH:
 *   - the pre-existing GET /api/applications/verify/:certificateNumber
 *     (ApplicationController.verifyCertificate)
 *   - the new GET /api/public/permits/verify/:token
 *     (PermitVerificationController.verifyByToken)
 * so the two endpoints can never disagree about whether a given
 * certificate is currently valid/expired, and so the isPubliclyBlocked
 * check (held records pending staff resolution of a shared-permit-number
 * or disputed-date conflict) is enforced identically by both — a blocked
 * record must not be retrievable through either route.
 */

import { Certificate } from "../entities/Certificate";
import { Application, ApplicationStatus } from "../entities/Application";

export type PublicPermitStatus = "VALID" | "EXPIRED" | "SUSPENDED" | "REVOKED" | "NOT_YET_ISSUED" | "PENDING";

/**
 * Returns today's calendar date in the Africa/Monrovia timezone as a
 * yyyy-mm-dd string — deliberately a civil-date comparison, not a UTC
 * instant comparison, so "expires at midnight Liberia time on the
 * recorded expiration date" is computed correctly regardless of the
 * server's own timezone (sandbox/CI/production may all differ).
 */
export function liberiaToday(now: Date = new Date()): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Monrovia",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(now);
    const values: Record<string, string> = {};
    for (const { type, value } of parts) values[type] = value;
    return `${values.year}-${values.month}-${values.day}`;
}

function toLiberiaDateString(d: Date | string | null | undefined): string | null {
    if (!d) return null;
    const date = typeof d === "string" ? new Date(d) : d;
    if (Number.isNaN(date.getTime())) return null;
    return liberiaToday(date);
}

/**
 * Computes the live, server-side status of a certificate for public
 * display. Suspension/revocation (recorded on the underlying Application)
 * ALWAYS override the normal issued -> expired timeline, per spec — a
 * suspended/revoked permit shows that status even if its recorded
 * expiration date is still in the future.
 */
export function computePublicStatus(certificate: Certificate, application: Application, now: Date = new Date()): PublicPermitStatus {
    if (application.status === ApplicationStatus.SUSPENDED) return "SUSPENDED";
    if (application.status === ApplicationStatus.REVOKED) return "REVOKED";

    if (application.status !== ApplicationStatus.ISSUED) {
        // Not yet reached ISSUED (still mid-workflow) or terminal
        // non-issuance (REJECTED/CANCELLED) — nothing to show as a valid
        // permit yet.
        return "PENDING";
    }

    const today = liberiaToday(now);
    const expiresDay = toLiberiaDateString(certificate.expiryDate);
    if (expiresDay && today >= expiresDay) {
        // A permit becomes Expired at 00:00 Africa/Monrovia on its recorded
        // expiration date — the expiration date itself is the FIRST
        // Expired day, not the last valid day. The last valid day is the
        // calendar day immediately before expiryDate. Verified directly:
        // expiryDate = tomorrow (Liberia) -> VALID; expiryDate = today
        // (Liberia, i.e. the expiration date itself) -> EXPIRED. Matches
        // the source register's own permitStatus() logic exactly
        // (`if (day >= expires) return 'Expired'`).
        return "EXPIRED";
    }

    return "VALID";
}

/**
 * True only for a certificate that is safe to resolve through EITHER
 * public verification route (token-based or certificateNumber-based).
 * Guards against publishing a record that technically has a live
 * verification token but no actual issued permit number to show —
 * a state that must never occur in normal operation, but which a
 * mishandled post-import rollback-and-reimport could otherwise produce
 * (an orphaned pre-rollback row silently retains the real
 * certificateNumber, forcing a freshly re-imported row for the same
 * buyer into stagedPermitNumber while still being eligible for a fresh,
 * non-blocked verificationToken). Checked in addition to, not instead
 * of, the existing isPubliclyBlocked check.
 */
export function hasIssuedPermitNumber(certificate: Certificate): boolean {
    return !!certificate.certificateNumber && certificate.certificateNumber.trim().length > 0;
}

export interface PublicPermitView {
    permitNumber: string;
    buyerName: string;
    county: string | null;
    issueDate: Date | null;
    expiryDate: Date | null;
    status: PublicPermitStatus;
}

/**
 * Builds the exact, approved field-whitelist public projection — buyer
 * name, county, permit number, issue date, expiry date, and current
 * status. NOTHING else from the underlying Certificate/Application
 * record is ever included here, regardless of what new internal fields
 * either entity gains in the future (callers must not spread the raw
 * entities into a response — they must go through this function).
 */
export function toPublicPermitView(certificate: Certificate, application: Application, now: Date = new Date()): PublicPermitView {
    return {
        permitNumber: certificate.certificateNumber,
        buyerName: certificate.buyerDisplayName || "",
        county: certificate.county,
        issueDate: certificate.issueDate,
        expiryDate: certificate.expiryDate,
        status: computePublicStatus(certificate, application, now),
    };
}
