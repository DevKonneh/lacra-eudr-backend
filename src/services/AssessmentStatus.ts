/**
 * Assessment status for the PUBLIC API.
 *
 * WHY THIS EXISTS
 * ---------------
 * `Farm.riskLevel` is a database column with a DEFAULT of `'Low'`. That means a
 * farm that has NEVER been assessed still carries `riskLevel = 'Low'` in every
 * response — and the public profile rendered it in green as though a satellite
 * assessment had produced a Low-risk verdict.
 *
 * Two further cases make the raw column untrustworthy on its own:
 *
 *   - Historical rows may have been produced by the old mock path or the
 *     name heuristic, and 2033 deliberately marks such rows unverified.
 *   - `farm.lastRiskAssessmentDate` proves *an* assessment happened, but not
 *     that it was a verified one.
 *
 * The public API therefore reports an explicit status rather than leaving
 * consumers to guess from `riskLevel`:
 *
 *   'verified'             -> a live Whisp result, verified, not flagged.
 *   'unverified_historical'-> a result exists, but it cannot be trusted as a
 *                             verified assessment (legacy, mock, or flagged).
 *   'never_assessed'       -> no assessment has been recorded at all.
 *
 * Only 'verified' may ever carry a risk level. In the other two states the
 * level is `null`, so an unverified or absent result can never be rendered as
 * a rating — regardless of what the `riskLevel` column happens to contain.
 */

export type AssessmentStatus = "verified" | "unverified_historical" | "never_assessed";

/** The subset of a RiskAssessment row this module needs. */
export interface AssessmentSnapshot {
    overallRisk?: string | null;
    createdAt?: Date | string | null;
    source?: string | null;
    whispVerified?: boolean | null;
    flaggedForReassessment?: boolean | null;
    flagReason?: string | null;
}

/** The subset of a Farm row this module needs. */
export interface FarmSnapshot {
    riskLevel?: string | null;
    lastRiskAssessmentDate?: Date | string | null;
}

export interface AssessmentStatusResult {
    status: AssessmentStatus;
    /**
     * The risk level, but ONLY when `status === 'verified'`. `null` otherwise,
     * so a default 'Low' or a legacy mock cannot be shown as a rating.
     */
    level: string | null;
    /** When the verified assessment was produced, or null. */
    assessedAt: string | null;
    /** Provenance of the verified result ('whisp_live'), or null. */
    source: string | null;
    /** Human-readable explanation, safe to show publicly. */
    reason: string;
}

const isVerified = (a: AssessmentSnapshot | null | undefined): boolean => {
    if (!a) return false;
    return a.source === "whisp_live" && a.whispVerified === true && a.flaggedForReassessment !== true;
};

const toIso = (value: Date | string | null | undefined): string | null => {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Derives the public assessment status for one farm.
 *
 * @param farm  the farm row (for the legacy `riskLevel` / last date)
 * @param latest the most recent RiskAssessment row for that farm, if any
 */
export function deriveAssessmentStatus(
    farm: FarmSnapshot,
    latest?: AssessmentSnapshot | null
): AssessmentStatusResult {
    if (isVerified(latest)) {
        return {
            status: "verified",
            // Prefer the assessment's own verdict; fall back to the farm column
            // only because this branch is already proven verified.
            level: latest!.overallRisk ?? farm.riskLevel ?? null,
            assessedAt: toIso(latest!.createdAt) ?? toIso(farm.lastRiskAssessmentDate),
            source: latest!.source ?? null,
            reason: "Verified against a completed live satellite (Open Foris Whisp) analysis.",
        };
    }

    // A row exists (or the farm records an assessment date) but it is not a
    // verified result — legacy, mock-derived, or explicitly flagged.
    const hasAnyAssessment = !!latest || !!farm.lastRiskAssessmentDate;
    if (hasAnyAssessment) {
        const reason = latest?.flaggedForReassessment
            ? (latest.flagReason
                || "This result predates provenance tracking and cannot be verified. It must be reassessed before it is relied on.")
            : "A previous result exists but could not be verified as a live satellite assessment. It is shown for reference only and is not a compliance rating.";
        return {
            status: "unverified_historical",
            level: null,
            assessedAt: toIso(latest?.createdAt) ?? toIso(farm.lastRiskAssessmentDate),
            source: latest?.source ?? null,
            reason,
        };
    }

    return {
        status: "never_assessed",
        level: null,
        assessedAt: null,
        source: null,
        reason: "This farm has not been assessed. No compliance rating exists yet.",
    };
}

/**
 * True only when the status permits a level to be shown as a rating.
 * Kept as a named predicate so callers read as intent, not as a string compare.
 */
export function isVerifiedStatus(status: AssessmentStatus): boolean {
    return status === "verified";
}
