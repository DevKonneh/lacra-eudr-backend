/**
 * ComplianceActionController — admin-facing (ADMIN-only) endpoints for
 * issuing compliance actions (Warning, Fine, Suspend, Revoke, Reinstate)
 * against a Certificate (Agency or Local Produce Buyer permit) or an
 * individual AgentPersonnel record, and for listing a subject's full
 * compliance history. Shared by both the Agency Register and the Local
 * Produce Buyer Register — mounted twice (once under each register's own
 * route prefix) so each page's existing :id param naming stays intact.
 */
import { Request, Response } from "express";
import { successResponse, errorResponse } from "../utils/response";
import { ComplianceActionType, ComplianceSubjectType } from "../entities/ComplianceAction";
import { applyComplianceAction, getComplianceHistory, markFinePaid, ComplianceActionError } from "../services/ComplianceActionService";

const VALID_ACTION_TYPES = Object.values(ComplianceActionType);

export class ComplianceActionController {
    /**
     * POST /api/agencies/:id/compliance-actions
     * POST /api/local-produce-buyers/:id/compliance-actions
     * POST /api/agencies/:agencyId/personnel/:personnelId/compliance-actions
     * Body: { actionType: WARNING|FINE|SUSPEND|REVOKE|REINSTATE, reason: string, fineAmount?: number, fineCurrency?: string }
     */
    async createForCertificate(req: any, res: Response) {
        try {
            const { id } = req.params;
            const result = await this.create(req, ComplianceSubjectType.CERTIFICATE, id);
            return successResponse(res, result, "Compliance action recorded");
        } catch (error: any) {
            if (error instanceof ComplianceActionError) return errorResponse(res, error.message, [], 400);
            return errorResponse(res, "Error recording compliance action", [error.message], 500);
        }
    }

    async createForPersonnel(req: any, res: Response) {
        try {
            const { personnelId } = req.params;
            const result = await this.create(req, ComplianceSubjectType.AGENT_PERSONNEL, personnelId);
            return successResponse(res, result, "Compliance action recorded");
        } catch (error: any) {
            if (error instanceof ComplianceActionError) return errorResponse(res, error.message, [], 400);
            return errorResponse(res, "Error recording compliance action", [error.message], 500);
        }
    }

    private async create(req: any, subjectType: ComplianceSubjectType, subjectId: string) {
        const { actionType, reason, fineAmount, fineCurrency } = req.body || {};
        if (!actionType || !VALID_ACTION_TYPES.includes(actionType)) {
            throw new ComplianceActionError(`actionType must be one of: ${VALID_ACTION_TYPES.join(", ")}`);
        }
        return applyComplianceAction({
            subjectType,
            subjectId,
            actionType,
            reason,
            fineAmount,
            fineCurrency,
            performedByUserId: req.user?.id,
            performedByName: req.user?.name,
        });
    }

    /**
     * GET /api/agencies/:id/compliance-actions
     * GET /api/local-produce-buyers/:id/compliance-actions
     * GET /api/agencies/:agencyId/personnel/:personnelId/compliance-actions
     * Any authenticated staff member can view the history (read-only,
     * same access level as the register listing itself) — only the
     * create/mark-paid actions are ADMIN-gated at the route level.
     */
    async listForCertificate(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const history = await getComplianceHistory(ComplianceSubjectType.CERTIFICATE, id);
            return successResponse(res, history);
        } catch (error: any) {
            return errorResponse(res, "Error fetching compliance history", [error.message], 500);
        }
    }

    async listForPersonnel(req: Request, res: Response) {
        try {
            const { personnelId } = req.params;
            const history = await getComplianceHistory(ComplianceSubjectType.AGENT_PERSONNEL, personnelId);
            return successResponse(res, history);
        } catch (error: any) {
            return errorResponse(res, "Error fetching compliance history", [error.message], 500);
        }
    }

    /** PATCH /api/compliance-actions/:actionId/mark-paid — ADMIN-only. */
    async markPaid(req: Request, res: Response) {
        try {
            const { actionId } = req.params;
            const action = await markFinePaid(actionId);
            return successResponse(res, action, "Fine marked as paid");
        } catch (error: any) {
            if (error instanceof ComplianceActionError) return errorResponse(res, error.message, [], 400);
            return errorResponse(res, "Error marking fine as paid", [error.message], 500);
        }
    }
}
