import "reflect-metadata";

/**
 * EUDR review permissions — who may decide, and who may only recommend.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The delivery spec requires that "only holders of a dedicated EUDR review
 * permission issue final decisions", enforced on the BACKEND. That is a
 * security requirement, so it gets a test rather than a code review:
 *
 *   1. An inspector can submit evidence and recommend an outcome.
 *   2. An inspector CANNOT issue a final decision, even by sending
 *      `final: true` in the request body.
 *   3. A refusal is a 403, never a silent downgrade to a recommendation -
 *      telling someone their decision was recorded when it was not is worse
 *      than an error.
 *   4. The initial grant (CMIS admins) works, and an explicit
 *      `eudr:review:decide` permission works for a non-admin role.
 *   5. `isFinal` is derived from the caller's permissions, never trusted
 *      from the body.
 *
 * HOW IT IS HERMETIC
 * ------------------
 * The review service singleton is mocked so no database is touched, and the
 * controller is driven with plain fake req/res objects (this project has no
 * supertest dependency). The permission logic under test - `canIssueFinalEudrDecision`
 * and the controller's 403 branch - is the real implementation.
 */

jest.mock("../EudrReviewService", () => {
    const recordReview = jest.fn();
    const forFarm = jest.fn();
    return { eudrReviewService: { recordReview, forFarm }, EudrReviewService: jest.fn() };
});

import { EudrReviewController } from "../../controllers/EudrReviewController";
import { eudrReviewService } from "../EudrReviewService";
import {
    canIssueFinalEudrDecision,
    EUDR_REVIEW_PERMISSION,
    EUDR_RECOMMEND_ROLES,
} from "../../middleware/eudrReview.middleware";
import { UserRole } from "../../entities/User";

const svc = eudrReviewService as unknown as {
    recordReview: jest.Mock;
    forFarm: jest.Mock;
};

/** Minimal Express response double that records what the controller sent. */
function makeRes() {
    const res: any = {};
    res.statusCode = 200;
    res.body = undefined;
    res.status = jest.fn((code: number) => {
        res.statusCode = code;
        return res;
    });
    res.json = jest.fn((payload: any) => {
        res.body = payload;
        return res;
    });
    return res;
}

const INSPECTOR = { id: "u-insp", name: "Insp. Kollie", role: UserRole.INSPECTOR, __permissions: [] };
const ADMIN = { id: "u-adm", name: "Admin Freeman", role: UserRole.ADMIN, __permissions: [] };
const DESIGNATED = {
    id: "u-rev",
    name: "Designated Reviewer",
    role: UserRole.TECHNICAL,
    __permissions: [EUDR_REVIEW_PERMISSION],
};

function callRecordReview(reviewer: any, body: any) {
    const controller = new EudrReviewController();
    const req: any = { params: { plotId: "plot-1" }, body, reviewer };
    const res = makeRes();
    return { promise: controller.recordReview(req, res), res };
}

beforeEach(() => {
    jest.clearAllMocks();
    svc.forFarm.mockResolvedValue({ farmId: "farm-1", farmName: "Gola Farm", plots: [], farm: null });
    svc.recordReview.mockImplementation(async (params: any) => ({
        review: {
            id: "rev-1",
            plotId: params.plotId,
            decision: params.decision,
            isFinal: params.isFinal,
            reason: params.reason,
            riskAssessmentId: null,
            geometryHash: null,
            geometryVersion: null,
            reviewedByName: params.reviewer.name,
            reviewedByRole: params.reviewer.role,
            createdAt: new Date(),
        },
        plot: { id: params.plotId, farmId: "farm-1" },
    }));
});

// ════════════════════════════════════════════════════════════════════════════
// 1. THE PERMISSION PREDICATE
// ════════════════════════════════════════════════════════════════════════════
describe("canIssueFinalEudrDecision", () => {
    it("refuses an inspector who carries no explicit permission", () => {
        expect(canIssueFinalEudrDecision(INSPECTOR)).toBe(false);
    });

    it("refuses an unauthenticated / missing reviewer", () => {
        expect(canIssueFinalEudrDecision(null)).toBe(false);
        expect(canIssueFinalEudrDecision(undefined)).toBe(false);
    });

    it("grants an admin as the initial grant", () => {
        expect(canIssueFinalEudrDecision(ADMIN)).toBe(true);
    });

    it("grants any non-admin role that was explicitly given the permission", () => {
        expect(canIssueFinalEudrDecision(DESIGNATED)).toBe(true);
    });

    it("does not let an ad-hoc client-supplied role claim sneak past the check", () => {
        // The permission list is what matters; a random role string is not enough.
        expect(canIssueFinalEudrDecision({ role: "SomethingElse", __permissions: [] })).toBe(false);
    });
});

describe("EUDR_RECOMMEND_ROLES", () => {
    it("lets inspectors and admins submit evidence", () => {
        expect(EUDR_RECOMMEND_ROLES).toContain(UserRole.INSPECTOR);
        expect(EUDR_RECOMMEND_ROLES).toContain(UserRole.ADMIN);
    });

    it("does not let a buyer or exporter submit review evidence", () => {
        expect(EUDR_RECOMMEND_ROLES).not.toContain(UserRole.BUYER);
        expect(EUDR_RECOMMEND_ROLES).not.toContain(UserRole.EXPORTER);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. THE CONTROLLER'S ENFORCEMENT POINT
// ════════════════════════════════════════════════════════════════════════════
describe("recordReview — final decisions are permission-gated", () => {
    it("refuses an inspector who asks for a FINAL decision, with 403", async () => {
        const { promise, res } = callRecordReview(INSPECTOR, {
            decision: "cleared",
            reason: "Verified on site with the community land committee.",
            final: true,
        });
        await promise;

        expect(res.statusCode).toBe(403);
        expect(res.body.status).toBe(false);
        expect(res.body.message).toMatch(/Forbidden/i);
        // The refusal must be explicit, not a silent downgrade.
        expect(svc.recordReview).not.toHaveBeenCalled();
    });

    it("ALLOWS the same inspector to record a RECOMMENDATION (final omitted)", async () => {
        const { promise, res } = callRecordReview(INSPECTOR, {
            decision: "cleared",
            reason: "Inspected; no post-2020 clearance observed.",
        });
        await promise;

        expect(res.statusCode).toBe(201);
        expect(res.body.status).toBe(true);
        expect(svc.recordReview).toHaveBeenCalledTimes(1);
        expect(svc.recordReview.mock.calls[0][0].isFinal).toBe(false);
        expect(res.body.message).toMatch(/recommendation/i);
    });

    it("ALLOWS an inspector to record a recommendation with explicit final: false", async () => {
        const { promise, res } = callRecordReview(INSPECTOR, {
            decision: "needs_review",
            reason: "Boundary disputed by a neighbouring household.",
            final: false,
        });
        await promise;

        expect(res.statusCode).toBe(201);
        expect(svc.recordReview.mock.calls[0][0].isFinal).toBe(false);
    });

    it("lets an admin issue a FINAL decision", async () => {
        const { promise, res } = callRecordReview(ADMIN, {
            decision: "cleared",
            reason: "Reviewed the inspector's evidence and cleared the plot.",
            final: true,
        });
        await promise;

        expect(res.statusCode).toBe(201);
        expect(svc.recordReview.mock.calls[0][0].isFinal).toBe(true);
        expect(res.body.message).toMatch(/Final EUDR decision recorded/i);
    });

    it("lets a non-admin with the explicit permission issue a FINAL decision", async () => {
        const { promise, res } = callRecordReview(DESIGNATED, {
            decision: "non_compliant",
            reason: "Confirmed conversion of 2020 forest to cocoa after January 2021.",
            final: true,
        });
        await promise;

        expect(res.statusCode).toBe(201);
        expect(svc.recordReview.mock.calls[0][0].isFinal).toBe(true);
    });

    it("does not treat a truthy non-boolean as a final request (no privilege escalation)", async () => {
        // A client sending final: "yes" or final: 1 must not be read as a decision.
        const { promise, res } = callRecordReview(INSPECTOR, {
            decision: "cleared",
            reason: "Inspected; nothing outstanding.",
            final: "yes",
        });
        await promise;

        expect(res.statusCode).toBe(201);
        expect(svc.recordReview.mock.calls[0][0].isFinal).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. VALIDATION THAT PROTECTS THE AUDIT TRAIL
// ════════════════════════════════════════════════════════════════════════════
describe("recordReview — input validation", () => {
    it("rejects a missing decision", async () => {
        const { promise, res } = callRecordReview(ADMIN, { reason: "no decision given here" });
        await promise;
        expect(res.statusCode).toBe(400);
        expect(svc.recordReview).not.toHaveBeenCalled();
    });

    it("rejects a blank reason", async () => {
        const { promise, res } = callRecordReview(ADMIN, { decision: "cleared", reason: "   " });
        await promise;
        expect(res.statusCode).toBe(400);
        expect(svc.recordReview).not.toHaveBeenCalled();
    });
});
