import {
    evaluatePlot,
    evaluateFarm,
    forestOverlapPct,
    legalStateOf,
    PlotEudrInputs,
    EUDR_STATUS_PRIORITY,
    EUDR_STATUS_LABEL,
    isBlockingStatus,
} from "../EudrStatusService";

/**
 * EUDR six-status ladder — behavioural tests.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The status shown on a Farmer Profile Report is a compliance statement. If it
 * is wrong in the permissive direction, a parcel that should be held is cleared;
 * if it is wrong the other way, field teams re-inspect land that was already fine.
 * Both cost real money, and the permissive error is a regulatory exposure.
 *
 * So the rules are pinned here, including the three cases the delivery spec
 * named explicitly:
 *
 *   1. The Gola Forest edge parcel -> 24.42 ha (100%) overlap and Needs Review.
 *   2. more_info_needed PLUS a confirmed legal violation -> Non-Compliant
 *      (precedence), not Needs Review.
 *   3. Missing/expired documents with no confirmed violation -> Needs Review,
 *      with BOTH issues listed.
 *
 * Every assertion also checks the REASON text, because a status with no
 * explanation is not usable in a due-diligence file.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * The live Gola Forest (West) response, 2026-11-21, reduced to the fields that
 * drive status. EUFO_2020 and Area are both 24.416 ha, i.e. the parcel sits
 * entirely inside the 2020 forest-cover baseline, and WhISP returned
 * more_info_needed because tree cover was still present after 2020 with no
 * unambiguous later disturbance.
 */
const GOLA_ASSESSMENT = {
    deforestationRisk: false,
    riskLabel: "more_info_needed",
    eufo2020Ha: 24.416000366210938,
    areaHa: 24.416000366210938,
    distAfter2020Ha: 0,
    gfcLossAfter2020Ha: 0,
    post2020EventYears: [] as number[],
    assessedAt: "2026-11-21T12:00:00.000Z",
};

/** A clean parcel: low risk, no 2020 forest overlap, no post-2020 signal. */
const CLEAN_ASSESSMENT = {
    deforestationRisk: false,
    riskLabel: "low",
    eufo2020Ha: 0,
    areaHa: 5,
    distAfter2020Ha: 0,
    gfcLossAfter2020Ha: 0,
    post2020EventYears: [] as number[],
    assessedAt: "2026-11-21T12:00:00.000Z",
};

/** A parcel with a measured post-2020 loss. */
const HIGH_ASSESSMENT = {
    deforestationRisk: true,
    riskLabel: "high",
    eufo2020Ha: 12,
    areaHa: 12,
    distAfter2020Ha: 1.75,
    gfcLossAfter2020Ha: 1.5,
    post2020EventYears: [2022, 2023],
    assessedAt: "2026-11-21T12:00:00.000Z",
};

const VALID_DOCS = [{ status: "Valid" }, { status: "Valid" }];
const PENDING_DOCS = [{ status: "Valid" }, { status: "Pending" }];
const INVALID_DOCS = [{ status: "Valid" }, { status: "Invalid" }];

function inputs(over: Partial<PlotEudrInputs> = {}): PlotEudrInputs {
    return {
        plotId: "plot-1",
        plotName: "Plot A",
        isDefault: false,
        hasValidBoundary: true,
        assessment: CLEAN_ASSESSMENT,
        jobStatus: "completed",
        jobFailureMessage: null,
        jobRetryable: false,
        legalDocuments: VALID_DOCS,
        finalReview: null,
        hasPendingRecommendation: false,
        ...over,
    };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

describe("forest overlap arithmetic", () => {
    it("reports the Gola parcel as 100% of a 24.42 ha polygon", () => {
        // The exact live values, at full float precision.
        expect(forestOverlapPct(24.416000366210938, 24.416000366210938)).toBe(100);
    });

    it("rounds to one decimal place and clamps float artefacts to 100", () => {
        expect(forestOverlapPct(11.11, 24.42)).toBe(45.5);
        // Satellite area and overlap disagree slightly at the edges; 100.4% must
        // not be reported as more than the whole parcel.
        expect(forestOverlapPct(24.5, 24.4)).toBe(100);
    });

    it("returns null rather than 0 when the inputs are unusable", () => {
        // A null overlap is "unknown", not "no forest" - a real distinction.
        expect(forestOverlapPct(null, 10)).toBeNull();
        expect(forestOverlapPct(5, null)).toBeNull();
        expect(forestOverlapPct(5, 0)).toBeNull();
    });
});

describe("legal state classification", () => {
    it("treats no documents as missing, not as unverified", () => {
        expect(legalStateOf([]).state).toBe("missing");
    });
    it("treats an Invalid document as invalid (expired is carried this way)", () => {
        expect(legalStateOf(INVALID_DOCS).state).toBe("invalid");
    });
    it("treats Pending as unverified - a known-good start, not a problem", () => {
        expect(legalStateOf(PENDING_DOCS).state).toBe("unverified");
    });
    it("treats all-Valid as passed", () => {
        expect(legalStateOf(VALID_DOCS).state).toBe("passed");
    });
});

// ── The six statuses ────────────────────────────────────────────────────────

describe("priority ladder - the six statuses in order", () => {
    it("1. Non-Compliant wins over everything, including more_info_needed", () => {
        const r = evaluatePlot(inputs({
            // The spec's exact example: more_info_needed PLUS a confirmed legal
            // violation must be Non-Compliant, not Needs Review.
            assessment: GOLA_ASSESSMENT,
            legalDocuments: INVALID_DOCS,
            finalReview: {
                decision: "non_compliant",
                reason: "Field inspection confirmed the parcel was cleared in 2023 and planted with cocoa.",
                reviewedByName: "Jane Reviewer",
                createdAt: "2026-11-22T09:00:00.000Z",
            },
        }));

        expect(r.status).toBe("non_compliant");
        expect(r.statusLabel).toBe("Non-Compliant");
        expect(r.priority).toBe(1);
        expect(r.blocksClearance).toBe(true);
        expect(r.reason).toMatch(/Jane Reviewer/);
        expect(r.reason).toMatch(/cleared in 2023/i);
    });

    it("1. Non-Compliant is not reachable without an authorised decision", () => {
        // A recommendation (no final review applied) must NOT condemn a plot.
        const r = evaluatePlot(inputs({
            assessment: GOLA_ASSESSMENT,
            legalDocuments: INVALID_DOCS,
            finalReview: null,
            hasPendingRecommendation: true,
        }));
        expect(r.status).not.toBe("non_compliant");
    });

    it("2. High Risk when WhISP flags post-2020 loss and it is unresolved", () => {
        const r = evaluatePlot(inputs({ assessment: HIGH_ASSESSMENT }));
        expect(r.status).toBe("high_risk");
        expect(r.priority).toBe(2);
        expect(r.post2020DisturbanceDetected).toBe(true);
        expect(r.post2020DisturbanceHa).toBe(1.75);
        expect(r.post2020EventYears).toEqual([2022, 2023]);
        expect(r.reason).toMatch(/post-2020 deforestation/i);
        expect(r.reason).toMatch(/converted to agricultural use/i);
    });

    it("2. High Risk outranks a missing document (but the legal issue still shows)", () => {
        const r = evaluatePlot(inputs({
            assessment: HIGH_ASSESSMENT,
            legalDocuments: [], // missing
        }));
        expect(r.status).toBe("high_risk");
        // Individual findings must remain visible even when one takes precedence.
        expect(r.legalState).toBe("missing");
        expect(r.legalDetail).toMatch(/no compliance documents/i);
    });

    it("2. A cleared review resolves High Risk (does not condemn, does not auto-clear)", () => {
        const r = evaluatePlot(inputs({
            assessment: HIGH_ASSESSMENT,
            legalDocuments: PENDING_DOCS,
            finalReview: {
                decision: "cleared",
                reason: "Verified the loss was pre-cutoff regrowth misclassification.",
                reviewedByName: "Jane Reviewer",
                createdAt: "2026-11-22T09:00:00.000Z",
            },
        }));
        // Cleared deforestation + unverified legal => rule 5, not Compliant.
        expect(r.status).toBe("low_deforestation_risk");
    });

    it("3. Needs Review for the Gola parcel: more_info_needed is NOT a pass", () => {
        const r = evaluatePlot(inputs({ assessment: GOLA_ASSESSMENT }));

        expect(r.status).toBe("needs_review");
        expect(r.statusLabel).toBe("Needs Review");
        expect(r.priority).toBe(3);
        expect(r.blocksClearance).toBe(true);

        // The spec's exact wording for this parcel.
        expect(r.forestOverlap2020Ha).toBeCloseTo(24.42, 2);
        expect(r.forestOverlap2020Pct).toBe(100);
        expect(r.reason).toMatch(/24\.42 ha \(100%\)/);

        // And it must say WHY it is not simply a pass.
        expect(r.reason).toMatch(/more information is needed/i);
        expect(r.reason).toMatch(/NOT a clean pass/i);
        expect(r.deforestationFinding).toBe("more_info_needed");
    });

    it("3. Needs Review for missing documents, and lists the deforestation issue too", () => {
        const r = evaluatePlot(inputs({
            assessment: GOLA_ASSESSMENT,
            legalDocuments: [],
        }));
        expect(r.status).toBe("needs_review");
        expect(r.legalState).toBe("missing");
        // Both issues must be named, per the spec.
        expect(r.reason).toMatch(/no compliance documents/i);
        expect(r.reason).toMatch(/more information is needed/i);
    });

    it("3. Needs Review for an invalid/expired document with no confirmed violation", () => {
        const r = evaluatePlot(inputs({ legalDocuments: INVALID_DOCS }));
        expect(r.status).toBe("needs_review");
        expect(r.reason).toMatch(/invalid or expired/i);
    });

    it("4. Assessment Pending when there is no valid boundary", () => {
        const r = evaluatePlot(inputs({ hasValidBoundary: false, assessment: null }));
        expect(r.status).toBe("assessment_pending");
        expect(r.priority).toBe(4);
        expect(r.reason).toMatch(/no valid boundary/i);
    });

    it("4. Assessment Pending when no completed assessment exists yet", () => {
        const r = evaluatePlot(inputs({ assessment: null, jobStatus: "queued" }));
        expect(r.status).toBe("assessment_pending");
        expect(r.reason).toMatch(/no completed satellite assessment/i);
    });

    it("4. Assessment Pending surfaces a failure and marks it retryable", () => {
        const r = evaluatePlot(inputs({
            assessment: null,
            jobStatus: "failed",
            jobFailureMessage: "Whisp service unavailable.",
            jobRetryable: true,
        }));
        expect(r.status).toBe("assessment_pending");
        expect(r.reason).toMatch(/did not produce a result/i);
        expect(r.reason).toMatch(/Whisp service unavailable/i);
        expect(r.retryable).toBe(true);
        expect(r.reason).toMatch(/retry/i);
    });

    it("5. Low Deforestation Risk while legal verification is still in progress", () => {
        const r = evaluatePlot(inputs({ legalDocuments: PENDING_DOCS }));
        expect(r.status).toBe("low_deforestation_risk");
        expect(r.priority).toBe(5);
        // Clearance is still held: verification is not finished.
        expect(r.blocksClearance).toBe(true);
        expect(r.reason).toMatch(/still in progress/i);
    });

    it("6. Compliant when deforestation is low and legal checks passed", () => {
        const r = evaluatePlot(inputs());
        expect(r.status).toBe("compliant");
        expect(r.priority).toBe(6);
        expect(r.blocksClearance).toBe(false);
        expect(r.reason).toMatch(/support clearance/i);
    });

    it("never reports Compliant for an unknown WhISP label", () => {
        // Fail closed: an unrecognised label is not evidence of low risk.
        const r = evaluatePlot(inputs({
            assessment: { ...CLEAN_ASSESSMENT, riskLabel: "some_new_label", deforestationRisk: false },
        }));
        expect(r.status).not.toBe("compliant");
        expect(r.status).toBe("needs_review");
    });

    it("never reports Compliant when the assessment is missing", () => {
        const r = evaluatePlot(inputs({ assessment: null }));
        expect(r.status).not.toBe("compliant");
    });
});

describe("priority mapping is total and ordered", () => {
    it("assigns every status a distinct 1..6 priority", () => {
        const priorities = Object.values(EUDR_STATUS_PRIORITY).sort((a, b) => a - b);
        expect(priorities).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("labels every status", () => {
        for (const s of Object.keys(EUDR_STATUS_PRIORITY)) {
            expect(EUDR_STATUS_LABEL[s as keyof typeof EUDR_STATUS_LABEL]).toBeTruthy();
        }
    });

    it("treats only Compliant as non-blocking", () => {
        expect(isBlockingStatus("compliant")).toBe(false);
        for (const s of ["non_compliant", "high_risk", "needs_review", "assessment_pending", "low_deforestation_risk"] as const) {
            expect(isBlockingStatus(s)).toBe(true);
        }
    });
});

// ── Farm rollup ─────────────────────────────────────────────────────────────

describe("farm rollup - multi-plot clearance", () => {
    const compliantPlot = evaluatePlot(inputs({ plotId: "p1", plotName: "Plot A" }));

    it("marks the farm Compliant only when every plot clears and farm legal passes", () => {
        const farm = evaluateFarm([compliantPlot], VALID_DOCS);
        expect(farm.status).toBe("compliant");
        expect(farm.clearanceHeld).toBe(false);
        expect(farm.holdingPlots).toHaveLength(0);
    });

    it("holds the farm while ANY plot is unresolved, and names it", () => {
        const golaPlot = evaluatePlot(inputs({
            plotId: "p2",
            plotName: "Gola Edge Block",
            assessment: GOLA_ASSESSMENT,
        }));

        const farm = evaluateFarm([compliantPlot, golaPlot], VALID_DOCS);

        expect(farm.status).toBe("needs_review");
        expect(farm.clearanceHeld).toBe(true);
        expect(farm.holdingPlots).toHaveLength(1);
        expect(farm.holdingPlots[0].plotName).toBe("Gola Edge Block");
        expect(farm.holdingPlots[0].status).toBe("needs_review");
        expect(farm.reason).toMatch(/Gola Edge Block/);
        expect(farm.reason).toMatch(/on hold/i);
    });

    it("applies the same priority order ACROSS plots (worst plot wins)", () => {
        const needsReview = evaluatePlot(inputs({
            plotId: "p2", plotName: "Needs Review Plot",
            assessment: GOLA_ASSESSMENT,
        }));
        const highRisk = evaluatePlot(inputs({
            plotId: "p3", plotName: "High Risk Plot",
            assessment: HIGH_ASSESSMENT,
        }));

        const farm = evaluateFarm([needsReview, highRisk], VALID_DOCS);

        // High Risk (2) outranks Needs Review (3).
        expect(farm.status).toBe("high_risk");
        // But both are listed as holding clearance, most severe first.
        expect(farm.holdingPlots.map(p => p.status)).toEqual(["high_risk", "needs_review"]);
    });

    it("does not clear the farm when plots are fine but farm-level legal is not", () => {
        const farm = evaluateFarm([compliantPlot], INVALID_DOCS);
        expect(farm.status).toBe("needs_review");
        expect(farm.clearanceHeld).toBe(true);
        expect(farm.reason).toMatch(/farm-level legal checks/i);
    });

    it("reports Assessment Pending for a farm with no plots", () => {
        const farm = evaluateFarm([], VALID_DOCS);
        expect(farm.status).toBe("assessment_pending");
        expect(farm.reason).toMatch(/no active plots/i);
    });

    it("counts each status for the report summary", () => {
        const farm = evaluateFarm(
            [
                compliantPlot,
                evaluatePlot(inputs({ plotId: "p2", plotName: "B", assessment: GOLA_ASSESSMENT })),
                evaluatePlot(inputs({ plotId: "p3", plotName: "C", assessment: HIGH_ASSESSMENT })),
            ],
            VALID_DOCS,
        );
        expect(farm.counts.compliant).toBe(1);
        expect(farm.counts.needs_review).toBe(1);
        expect(farm.counts.high_risk).toBe(1);
    });
});
