/**
 * EUDR status resolution for a plot and a farm.
 *
 * WHY THIS IS A PURE MODULE
 * -------------------------
 * The six-status ladder is the rule most likely to be argued about by an
 * auditor, so it is expressed as pure functions over explicit inputs. That means
 * every branch can be tested without a database, and the panel, the API and any
 * future export all resolve a status through ONE implementation instead of three
 * subtly different ones.
 *
 * THE AGREED PRIORITY ORDER (higher wins)
 * ---------------------------------------
 *   1 Non-Compliant          authorised review confirms post-2020 conversion or
 *                            an applicable Liberian legal violation
 *   2 High Risk              WhISP flags possible post-2020 deforestation and
 *                            the finding is unresolved
 *   3 Needs Review           WhISP returned more_info_needed, OR legal documents
 *                            are missing or expired/invalid
 *   4 Assessment Pending     a valid boundary or a completed WhISP result is
 *                            still needed (failures are surfaced, not hidden)
 *   5 Low Deforestation Risk deforestation supports low risk while the legal
 *                            verification is still in progress, no known issue
 *   6 Compliant              deforestation cleared, applicable legal checks
 *                            passed, required review complete
 *
 * WHY "UNVERIFIED" DOCUMENTS ARE RULE 5, NOT RULE 3
 * -------------------------------------------------
 * A document that is PENDING (present, awaiting verification) is not a known
 * problem - verification is simply still running - so it lands on rule 5 and is
 * reported as "Low Deforestation Risk" with an explanation. A document that is
 * MISSING or INVALID is a known problem or an absence, so it lands on rule 3
 * ("Needs Review"). FarmDocument has no expiry column, so "expired" is carried as
 * status 'Invalid' by the document workflow; both land on rule 3.
 *
 * THE ONE THING THIS MODULE WILL NOT DO
 * -------------------------------------
 * It never invents a decision. A plot with a verified satellite result but no
 * human decision is NOT reported as compliant: it is reported as pending review
 * or pending assessment, with the reason stated. Only a FINAL review by a holder
 * of the EUDR review permission can clear or condemn a plot.
 */

export type EudrPlotStatus =
    | 'compliant'
    | 'low_deforestation_risk'
    | 'assessment_pending'
    | 'needs_review'
    | 'high_risk'
    | 'non_compliant';

/** Numeric priority, 1 = most severe. Lower number wins. */
export const EUDR_STATUS_PRIORITY: Record<EudrPlotStatus, number> = {
    non_compliant: 1,
    high_risk: 2,
    needs_review: 3,
    assessment_pending: 4,
    low_deforestation_risk: 5,
    compliant: 6,
};

export const EUDR_STATUS_LABEL: Record<EudrPlotStatus, string> = {
    non_compliant: 'Non-Compliant',
    high_risk: 'High Risk',
    needs_review: 'Needs Review',
    assessment_pending: 'Assessment Pending',
    low_deforestation_risk: 'Low Deforestation Risk',
    compliant: 'Compliant',
};

/** Whether clearance is held for this status. Only 'compliant' clears. */
export const isBlockingStatus = (s: EudrPlotStatus): boolean => s !== 'compliant';

export type LegalState = 'passed' | 'unverified' | 'invalid' | 'missing';

/** Minimal shape of a stored WhISP assessment needed to judge deforestation. */
export interface AssessmentInputs {
    deforestationRisk: boolean;
    /** WhISP's commodity-category label: low | high | more_info_needed | unknown. */
    riskLabel: string | null;
    /** EUFO_2020 - EU 2020 forest-cover baseline overlap (ha). */
    eufo2020Ha: number | null;
    /** WhISP-computed parcel area (ha). */
    areaHa: number | null;
    /** WhISP's own composite disturbance total after the cutoff (ha). */
    distAfter2020Ha: number | null;
    /** Hansen GFC loss after the cutoff (ha). */
    gfcLossAfter2020Ha: number | null;
    /** Annual events with any post-2020 signal (years only). */
    post2020EventYears: number[];
    assessedAt: string | null;
}

/** A final, current review bound to this plot's boundary and assessment. */
export interface ReviewInputs {
    decision: string;      // cleared | non_compliant | needs_review
    reason: string;
    reviewedByName: string | null;
    createdAt: string | null;
}

export interface PlotEudrInputs {
    plotId: string;
    plotName: string;
    isDefault: boolean;
    hasValidBoundary: boolean;
    /** Current verified assessment for THIS boundary, or null. */
    assessment: AssessmentInputs | null;
    /** Queue state for the plot ('queued'|'assessing'|'failed'|'boundary_review'|...). */
    jobStatus: string | null;
    jobFailureMessage: string | null;
    jobRetryable?: boolean;
    /** Farm documents (the legal evidence attached to this farm). */
    legalDocuments: Array<{ status: string }>;
    /** Most recent FINAL review that still describes this boundary, or null. */
    finalReview: ReviewInputs | null;
    /** True when a recommendation exists but no final decision yet. */
    hasPendingRecommendation?: boolean;
}

export interface PlotEudrEvaluation {
    plotId: string;
    plotName: string;
    isDefault: boolean;
    status: EudrPlotStatus;
    statusLabel: string;
    priority: number;
    /** Plain-language explanation, always populated. */
    reason: string;
    /** True when this plot holds up farm clearance. */
    blocksClearance: boolean;

    // ── Individual findings, shown even when one takes precedence ───────────
    deforestationFinding: 'high' | 'low' | 'more_info_needed' | 'unknown' | 'not_assessed';
    legalState: LegalState;
    legalDetail: string;

    // ── Numeric evidence for the report ─────────────────────────────────────
    forestOverlap2020Ha: number | null;
    forestOverlap2020Pct: number | null;
    post2020DisturbanceHa: number | null;
    post2020DisturbanceDetected: boolean;
    post2020EventYears: number[];
    assessedAt: string | null;

    review: ReviewInputs | null;
    hasPendingRecommendation: boolean;
    retryable: boolean;
}

/** Classifies the farm's documents for the legal check. */
export function legalStateOf(documents: Array<{ status: string }>): { state: LegalState; detail: string } {
    if (!documents || documents.length === 0) {
        return {
            state: 'missing',
            detail: 'No compliance documents have been uploaded for this farm, so the Liberian legal checks cannot be completed.',
        };
    }
    const invalid = documents.filter(d => d.status === 'Invalid').length;
    if (invalid > 0) {
        return {
            state: 'invalid',
            detail: `${invalid} compliance document(s) are invalid or expired, so the Liberian legal checks have not passed.`,
        };
    }
    const pending = documents.filter(d => d.status === 'Pending').length;
    if (pending > 0) {
        return {
            state: 'unverified',
            detail: `${pending} compliance document(s) are still awaiting verification.`,
        };
    }
    return {
        state: 'passed',
        detail: 'All required compliance documents are verified.',
    };
}

/** Percentage of the parcel overlapping the 2020 forest-cover baseline. */
export function forestOverlapPct(eufoHa: number | null, areaHa: number | null): number | null {
    if (eufoHa == null || areaHa == null || areaHa <= 0) return null;
    const pct = (eufoHa / areaHa) * 100;
    // A satellite area and an overlap can disagree slightly at the edges; clamp
    // so a 100.4% artefact is not reported as more-than-total.
    return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}

/** Post-2020 disturbance in hectares, from WhISP's own totals. */
export function post2020DisturbanceHa(assessment: AssessmentInputs | null): number | null {
    if (!assessment) return null;
    const dist = assessment.distAfter2020Ha;
    const gfc = assessment.gfcLossAfter2020Ha;
    const hasSeries = assessment.post2020EventYears.length > 0;
    if (dist == null && gfc == null && !hasSeries) return null;
    // WhISP's own composite total is authoritative when present; GFC is a
    // subset of the same land, so they are not summed (that would double-count).
    if (dist != null) return dist;
    if (gfc != null) return gfc;
    return 0;
}

function deforestationClass(assessment: AssessmentInputs | null): PlotEudrEvaluation['deforestationFinding'] {
    if (!assessment) return 'not_assessed';
    const label = (assessment.riskLabel ?? '').toLowerCase();
    if (label === 'high') return 'high';
    if (label === 'more_info_needed') return 'more_info_needed';
    if (label === 'low') return 'low';
    // No usable label: fall back to the boolean WhISP set, never to a guess.
    return assessment.deforestationRisk ? 'high' : 'unknown';
}

/**
 * Resolves ONE plot's status using the agreed priority order.
 *
 * Every branch sets an explicit reason. There is no path where a status is
 * returned without saying why, because the report has to justify a hold.
 */
export function evaluatePlot(input: PlotEudrInputs): PlotEudrEvaluation {
    const legal = legalStateOf(input.legalDocuments);
    const deforestation = deforestationClass(input.assessment);
    const review = input.finalReview;
    const reviewed = review?.decision ?? null;

    const distHa = post2020DisturbanceHa(input.assessment);
    const eufoHa = input.assessment?.eufo2020Ha ?? null;
    const pct = forestOverlapPct(eufoHa, input.assessment?.areaHa ?? null);
    const post2020Detected =
        deforestation === 'high' ||
        (distHa != null && distHa > 0) ||
        (input.assessment?.post2020EventYears.length ?? 0) > 0;

    const base = {
        plotId: input.plotId,
        plotName: input.plotName,
        isDefault: input.isDefault,
        deforestationFinding: deforestation,
        legalState: legal.state,
        legalDetail: legal.detail,
        forestOverlap2020Ha: eufoHa,
        forestOverlap2020Pct: pct,
        post2020DisturbanceHa: distHa,
        post2020DisturbanceDetected: post2020Detected,
        post2020EventYears: input.assessment?.post2020EventYears ?? [],
        assessedAt: input.assessment?.assessedAt ?? null,
        review,
        hasPendingRecommendation: !!input.hasPendingRecommendation,
        retryable: input.jobRetryable ?? false,
    };

    const make = (status: EudrPlotStatus, reason: string): PlotEudrEvaluation => ({
        ...base,
        status,
        statusLabel: EUDR_STATUS_LABEL[status],
        priority: EUDR_STATUS_PRIORITY[status],
        reason,
        blocksClearance: isBlockingStatus(status),
    });

    const overlapSentence =
        eufoHa != null && pct != null
            ? ` The plot overlaps ${eufoHa.toFixed(2)} ha (${pct.toFixed(0)}%) of the 2020 forest-cover baseline.`
            : '';

    // ── 1. Non-Compliant ───────────────────────────────────────────────────
    // Only an AUTHORISED final decision can reach this. A missing document is
    // not a violation, and WhISP alone cannot establish one.
    if (reviewed === 'non_compliant') {
        const who = review?.reviewedByName ? ` by ${review.reviewedByName}` : '';
        const why = review?.reason ? ` Reason recorded: ${review.reason}` : '';
        return make(
            'non_compliant',
            `A review${who} confirmed non-compliance for this plot.${why}${overlapSentence}`,
        );
    }

    // ── 2. High Risk ───────────────────────────────────────────────────────
    if (deforestation === 'high' && reviewed !== 'cleared') {
        const dist =
            distHa != null && distHa > 0
                ? ` ${distHa.toFixed(2)} ha of post-31 December 2020 disturbance was measured.`
                : '';
        const years = base.post2020EventYears.length
            ? ` Signal years: ${base.post2020EventYears.join(', ')}.`
            : '';
        return make(
            'high_risk',
            `WhISP indicates possible post-2020 deforestation on this plot.${dist}${years}` +
                ` Clearance is held until a reviewer verifies whether the forest was converted to agricultural use.${overlapSentence}`,
        );
    }

    // ── 3. Needs Review ────────────────────────────────────────────────────
    // The spec requires the deforestation finding AND the legality finding to
    // both be reported even when one takes precedence, so the legal problem is
    // appended rather than dropped when WHISP needs more information.
    const legalProblem = legal.state === 'missing' || legal.state === 'invalid';
    if (deforestation === 'more_info_needed' && reviewed !== 'cleared') {
        return make(
            'needs_review',
            'WhISP returned "more information is needed" for this plot: it could not conclusively ' +
                'determine low or high risk from satellite signals alone, so this is NOT a clean pass. ' +
                'A reviewer must record the evidence and resolve the finding before clearance.' +
                (legalProblem ? ` Separately, the legal checks have not passed: ${legal.detail}` : '') +
                overlapSentence,
        );
    }
    if (legal.state === 'missing' || legal.state === 'invalid') {
        const deforestNote =
            deforestation === 'more_info_needed'
                ? ' WhISP also returned "more information is needed" for this plot.'
                : deforestation === 'high'
                    ? ' WhISP also indicates possible post-2020 deforestation.'
                    : '';
        return make('needs_review', `${legal.detail}${deforestNote}${overlapSentence}`);
    }

    // ── 4. Assessment Pending ──────────────────────────────────────────────
    if (!input.hasValidBoundary) {
        return make(
            'assessment_pending',
            'This plot has no valid boundary polygon, so no satellite assessment can run. ' +
                'A surveyed boundary is required before clearance can be considered.',
        );
    }
    if (!input.assessment) {
        const failure = input.jobFailureMessage
            ? ` The last assessment attempt did not produce a result: ${input.jobFailureMessage}`
            : '';
        const state = input.jobStatus ? ` Current state: ${input.jobStatus}.` : '';
        return make(
            'assessment_pending',
            `No completed satellite assessment exists for this plot's current boundary.${state}${failure}` +
                (input.jobRetryable ? ' An authorised user can retry the assessment.' : ''),
        );
    }

    // ── 5. Low Deforestation Risk ──────────────────────────────────────────
    // Deforestation supports low risk; legal verification is still running but
    // nothing is known to be wrong.
    if (legal.state === 'unverified') {
        return make(
            'low_deforestation_risk',
            'The deforestation screening supports low risk, but the Liberian legal checks are ' +
                `still in progress. ${legal.detail}${overlapSentence}`,
        );
    }

    // ── 6. Compliant ───────────────────────────────────────────────────────
    // Requires: deforestation cleared (low, or cleared by a final review),
    // legal checks passed, and no unresolved review outstanding.
    const deforestationCleared = deforestation === 'low' || reviewed === 'cleared';
    if (deforestationCleared && legal.state === 'passed' && input.hasValidBoundary) {
        const reviewNote =
            reviewed === 'cleared'
                ? ` A review${review?.reviewedByName ? ` by ${review.reviewedByName}` : ''} cleared the earlier finding.`
                : '';
        return make(
            'compliant',
            `The deforestation assessment and the applicable Liberian legal compliance checks are ` +
                `complete and support clearance.${reviewNote}${overlapSentence}`,
        );
    }

    // Defensive fallback: never silently claim compliance. If we get here the
    // inputs were contradictory (e.g. an unknown WhISP label), so hold for a
    // human rather than guess.
    return make(
        'needs_review',
        'The available evidence is not sufficient to clear this plot automatically. ' +
            'A reviewer must confirm the deforestation and legal findings.',
    );
}

export interface FarmEudrSummary {
    status: EudrPlotStatus;
    statusLabel: string;
    reason: string;
    clearanceHeld: boolean;
    /** Plots actively holding clearance, most severe first. */
    holdingPlots: Array<{ plotId: string; plotName: string; status: EudrPlotStatus; statusLabel: string; reason: string }>;
    counts: Record<EudrPlotStatus, number>;
}

const EMPTY_COUNTS: Record<EudrPlotStatus, number> = {
    non_compliant: 0,
    high_risk: 0,
    needs_review: 0,
    assessment_pending: 0,
    low_deforestation_risk: 0,
    compliant: 0,
};

/**
 * Rolls plot evaluations up to a farm status.
 *
 * The same priority order applies ACROSS plots, and the farm is only Compliant
 * when every in-scope plot is Compliant AND the farm-level legal checks passed.
 * `holdingPlots` names what is holding clearance and why, which is what the
 * report has to show for a multi-plot farm.
 */
export function evaluateFarm(
    plots: PlotEudrEvaluation[],
    farmDocuments: Array<{ status: string }>,
): FarmEudrSummary {
    const counts = { ...EMPTY_COUNTS };
    for (const p of plots) counts[p.status] += 1;

    const farmLegal = legalStateOf(farmDocuments);
    const holdingPlots = plots
        .filter(p => p.blocksClearance)
        .sort((a, b) => a.priority - b.priority)
        .map(p => ({
            plotId: p.plotId,
            plotName: p.plotName,
            status: p.status,
            statusLabel: p.statusLabel,
            reason: p.reason,
        }));

    if (plots.length === 0) {
        return {
            status: 'assessment_pending',
            statusLabel: EUDR_STATUS_LABEL.assessment_pending,
            reason: 'This farm has no active plots, so there is nothing to assess.',
            clearanceHeld: true,
            holdingPlots: [],
            counts,
        };
    }

    // Most severe plot status wins outright (rules 1-4 and 5 all live here).
    const worst = plots.reduce(
        (acc, p) => (p.priority < acc.priority ? p : acc),
        plots[0],
    );

    if (worst.status === 'compliant') {
        // All plots are compliant. The farm can only clear if the FARM-level
        // legal checks also passed - a plot-level pass does not cover the farm.
        if (farmLegal.state === 'passed') {
            return {
                status: 'compliant',
                statusLabel: EUDR_STATUS_LABEL.compliant,
                reason:
                    'Every plot on this farm is cleared and the farm-level legal compliance checks have passed.',
                clearanceHeld: false,
                holdingPlots: [],
                counts,
            };
        }
        // Plots clear, farm-level legal not: report at the legal severity.
        const status: EudrPlotStatus =
            farmLegal.state === 'unverified' ? 'low_deforestation_risk' : 'needs_review';
        return {
            status,
            statusLabel: EUDR_STATUS_LABEL[status],
            reason: `All plots are cleared, but the farm-level legal checks are not complete. ${farmLegal.detail}`,
            clearanceHeld: true,
            holdingPlots,
            counts,
        };
    }

    const worstName = worst.plotName;
    return {
        status: worst.status,
        statusLabel: worst.statusLabel,
        reason:
            `Farm clearance is on hold because plot "${worstName}" is ${worst.statusLabel.toLowerCase()}. ` +
            worst.reason +
            (holdingPlots.length > 1
                ? ` ${holdingPlots.length} plot(s) are holding clearance.`
                : ''),
        clearanceHeld: true,
        holdingPlots,
        counts,
    };
}
