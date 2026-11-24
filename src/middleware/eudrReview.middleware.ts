import { Response, NextFunction } from "express";
import { AppDataSource } from "../data-source";
import { User, UserRole } from "../entities/User";
import { AuthRequest } from "./auth.middleware";

/**
 * The dedicated EUDR review permission.
 *
 * WHY A NAMED PERMISSION RATHER THAN JUST "ADMIN"
 * -----------------------------------------------
 * Clearing a plot for EUDR purposes - or condemning it as non-compliant - is a
 * regulatory judgement with legal consequence. It must be grantable to specific
 * people and revocable without changing their whole account role, which is what
 * a named permission gives us. The existing Role.permissions mechanism already
 * supports this shape (simple-array of strings), so it is reused rather than
 * inventing a second permission system.
 */
export const EUDR_REVIEW_PERMISSION = "eudr:review:decide";

/**
 * Roles that may RECOMMEND a decision and submit evidence.
 *
 * Inspectors gather the field facts; they do not issue the verdict. An admin can
 * also recommend (they see the same evidence), but issuing the final decision
 * still requires the permission below.
 */
export const EUDR_RECOMMEND_ROLES: string[] = [UserRole.INSPECTOR, UserRole.ADMIN];

/** True when this user may issue a FINAL EUDR decision. */
export function canIssueFinalEudrDecision(user: any): boolean {
    if (!user) return false;

    // Explicit grant wins, wherever it came from.
    const permissions: string[] = Array.isArray(user.__permissions) ? user.__permissions : [];
    if (permissions.includes(EUDR_REVIEW_PERMISSION)) return true;

    // INITIAL GRANT (per the delivery spec): CMIS admins hold this permission
    // from day one so the workflow is usable before Role rows are populated.
    // Narrow this to the explicit grant above once designated reviewers are
    // assigned their own Role - at that point remove the ADMIN fallback, not the
    // permission check.
    return user.role === UserRole.ADMIN;
}

/**
 * Loads the caller's CURRENT permissions from the database.
 *
 * WHY NOT FROM THE JWT: the token carries only id/email/role/name. Permissions
 * are returned at login for the UI to hide buttons, but authorization must never
 * depend on a stale token claim - revoking the permission has to take effect on
 * the next request, not 24 hours later when the token expires.
 */
export async function loadReviewerContext(req: AuthRequest): Promise<any> {
    const user = (req as any).user;
    if (!user?.id) return null;

    const userRepo = AppDataSource.getRepository(User);
    const row = await userRepo.findOne({
        where: { id: user.id },
        relations: ["assignedRole"],
    });
    if (!row) return null;

    // Never trust a client-supplied role claim for authorization decisions.
    return {
        id: row.id,
        name: row.name || row.email,
        role: row.role,
        __permissions: row.assignedRole?.permissions ?? [],
    };
}

/**
 * Gate: the caller may RECORD A RECOMMENDATION (evidence + suggested outcome).
 * Inspectors and admins qualify; everyone else is rejected.
 */
export const requireRecommendationRights = () => {
    return async (req: AuthRequest, res: Response, next: NextFunction) => {
        try {
            const ctx = await loadReviewerContext(req);
            if (!ctx) {
                return res.status(401).json({ status: false, message: "Unauthorized: reviewer account not found", errors: [], data: [] });
            }
            if (!EUDR_RECOMMEND_ROLES.includes(ctx.role)) {
                return res.status(403).json({
                    status: false,
                    message: "Forbidden: your role cannot submit EUDR review evidence.",
                    errors: ["Inspectors and administrators may submit evidence and recommend a decision."],
                    data: [],
                });
            }
            (req as any).reviewer = ctx;
            next();
        } catch (err: any) {
            return res.status(500).json({ status: false, message: "Error checking review permissions", errors: [err.message], data: [] });
        }
    };
};

/**
 * Gate: the caller may ISSUE A FINAL DECISION.
 *
 * Enforced on the backend, not just hidden in the UI - a recommendation endpoint
 * that trusted the client to say "this is final" would make the permission
 * decorative.
 */
export const requireFinalDecisionRights = () => {
    return async (req: AuthRequest, res: Response, next: NextFunction) => {
        try {
            const ctx = await loadReviewerContext(req);
            if (!ctx) {
                return res.status(401).json({ status: false, message: "Unauthorized: reviewer account not found", errors: [], data: [] });
            }
            if (!canIssueFinalEudrDecision(ctx)) {
                return res.status(403).json({
                    status: false,
                    message: "Forbidden: you do not hold the EUDR review permission required to issue a final decision.",
                    errors: [
                        `Recording a final EUDR decision requires the "${EUDR_REVIEW_PERMISSION}" permission. ` +
                        "You may still submit evidence and recommend an outcome.",
                    ],
                    data: [],
                });
            }
            (req as any).reviewer = ctx;
            next();
        } catch (err: any) {
            return res.status(500).json({ status: false, message: "Error checking review permissions", errors: [err.message], data: [] });
        }
    };
};
