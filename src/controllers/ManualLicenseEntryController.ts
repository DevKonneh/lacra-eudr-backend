/**
 * ManualLicenseEntryController — staff-facing endpoint backing the
 * "License Registry -> Apply for New License" manual-entry form (new
 * pathway, NOT the old simple License entity/LicenseDashboard.tsx form it
 * replaces, and NOT the full /apply 41-status wizard).
 *
 * Lets Commercial/Marketing staff record a license/permit (Local Buyer,
 * Agency, Cooperative, or Exporter) that was already approved and issued
 * manually on paper in the past, landing it straight into ISSUED status
 * and the relevant register — see ManualLicenseEntryService for the full
 * write-path details.
 */

import { Request, Response } from "express";
import { successResponse, errorResponse } from "../utils/response";
import {
    ManualLicenseEntryService,
    ManualLicenseEntryValidationError,
    ManualLicenseEntryInput,
} from "../services/ManualLicenseEntryService";

export class ManualLicenseEntryController {
    /**
     * POST /api/manual-license-entries
     * Body: ManualLicenseEntryInput (see the service for the full shape).
     */
    async create(req: any, res: Response) {
        try {
            const input = (req.body || {}) as ManualLicenseEntryInput;
            const result = await ManualLicenseEntryService.create(input, {
                userId: req.user?.id,
                name: req.user?.name,
            });
            return successResponse(res, result, "License/permit recorded and issued", 201);
        } catch (error: any) {
            if (error instanceof ManualLicenseEntryValidationError) {
                return errorResponse(res, error.message, error.errors, 400);
            }
            return errorResponse(res, "Error recording manual license entry", [error.message], 500);
        }
    }
}
