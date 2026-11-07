import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { OfflineSubmission, OfflineSubmissionStatus } from "../entities/OfflineSubmission";
import { MobileSyncStatus } from "../entities/MobileSyncStatus";
import { successResponse, errorResponse } from "../utils/response";
import { AuthRequest } from "../middleware/auth.middleware";

/**
 * Backend visibility for farmer registrations captured on an inspector's
 * device while offline, but not yet fully synced to the real Farmer/Farm
 * tables. See src/entities/OfflineSubmission.ts for the full lifecycle
 * explanation.
 */
export class OfflineSubmissionController {
    private repo = AppDataSource.getRepository(OfflineSubmission);
    private syncStatusRepo = AppDataSource.getRepository(MobileSyncStatus);

    /**
     * Called by the mobile app as soon as a registration is queued locally
     * (or its retry/error state changes). Upserts on (clientId, inspectorId)
     * so re-reporting the same local item after a failed retry updates the
     * existing shadow record instead of creating a duplicate.
     */
    async report(req: AuthRequest, res: Response) {
        try {
            const inspectorId = req.user?.id;
            if (!inspectorId) return errorResponse(res, "Unauthorized", [], 401);

            const {
                clientId,
                displayName,
                phoneNumber,
                community,
                district,
                region,
                farmName,
                cropType,
                retryCount,
                lastError,
                capturedAt,
            } = req.body;

            if (!clientId) {
                return errorResponse(res, "clientId is required", [], 400);
            }

            let record = await this.repo.findOne({ where: { clientId, inspectorId } });
            if (!record) {
                record = new OfflineSubmission();
                record.clientId = clientId;
                record.inspectorId = inspectorId;
            }

            record.inspectorName = req.user?.name ?? record.inspectorName;
            record.displayName = displayName ?? record.displayName;
            record.phoneNumber = phoneNumber ?? record.phoneNumber;
            record.community = community ?? record.community;
            record.district = district ?? record.district;
            record.region = region ?? record.region;
            record.farmName = farmName ?? record.farmName;
            record.cropType = cropType ?? record.cropType;
            record.retryCount = typeof retryCount === "number" ? retryCount : (record.retryCount ?? 0);
            record.lastError = lastError ?? null as any;
            record.status = record.retryCount > 0 ? OfflineSubmissionStatus.FAILED : OfflineSubmissionStatus.PENDING;
            if (capturedAt) record.capturedAt = new Date(capturedAt);

            await this.repo.save(record);
            return successResponse(res, record, "Offline submission reported", 201);
        } catch (error: any) {
            console.error("Report Offline Submission Error", error);
            return errorResponse(res, "Error reporting offline submission", [error.message], 500);
        }
    }

    /**
     * Called by the mobile app once the item actually finishes syncing (the
     * real Farmer record now exists), or is discarded locally by the
     * inspector. Removes the shadow record so admin visibility stays
     * accurate - synced data shows up as a real Farmer, not a lingering
     * "still offline" entry.
     */
    async resolve(req: AuthRequest, res: Response) {
        try {
            const inspectorId = req.user?.id;
            if (!inspectorId) return errorResponse(res, "Unauthorized", [], 401);

            const { clientId } = req.params;
            const record = await this.repo.findOne({ where: { clientId, inspectorId } });
            if (!record) {
                // Already resolved/never reported - not an error, nothing to do.
                return successResponse(res, null, "No matching offline submission found");
            }

            const { syncedFarmerId } = req.body;
            if (syncedFarmerId) {
                // Kept briefly as SYNCED (rather than deleted) so admins can
                // still see "this was captured offline" on the farmer's
                // record if the frontend wants to surface that later.
                record.status = OfflineSubmissionStatus.SYNCED;
                record.syncedFarmerId = syncedFarmerId;
                record.lastError = null as any;
                await this.repo.save(record);
                return successResponse(res, record, "Offline submission marked as synced");
            }

            await this.repo.remove(record);
            return successResponse(res, null, "Offline submission removed");
        } catch (error: any) {
            console.error("Resolve Offline Submission Error", error);
            return errorResponse(res, "Error resolving offline submission", [error.message], 500);
        }
    }

    /**
     * Admin/Inspector visibility: lists everything currently sitting on
     * devices (PENDING/FAILED) that hasn't reached the real Farmer table
     * yet. This is the core of the "backend/admin visibility into offline
     * data" feature - previously this data was completely invisible to the
     * backend until a device with connectivity finally synced it.
     */
    async getAll(req: AuthRequest, res: Response) {
        try {
            const records = await this.repo.find({
                where: [
                    { status: OfflineSubmissionStatus.PENDING },
                    { status: OfflineSubmissionStatus.FAILED },
                ],
            });
            // Sort newest-reported-first in memory (avoids composite index
            // requirements on a status + reportedAt query).
            records.sort((a, b) => new Date(b.reportedAt).getTime() - new Date(a.reportedAt).getTime());
            return successResponse(res, records);
        } catch (error: any) {
            console.error("Get Offline Submissions Error", error);
            return errorResponse(res, "Error fetching offline submissions", [error.message], 500);
        }
    }

    /**
     * POST /api/offline-submissions/sync-status
     * Reuses this EXISTING offline-submission reporting flow (not a new
     * polling endpoint) for the Monitoring feature's "sync visibility"
     * requirement. Called by the mobile app's OfflineSyncService on every
     * sync-cycle attempt — including one FINAL call with
     * pendingCount: 0 once the queue is fully empty, per the explicit
     * requirement ("mobile app must explicitly report a successful cycle
     * with zero items pending") — the mobile app must not simply stop
     * reporting once its queue empties, since that would leave this row
     * stuck showing the last nonzero count forever.
     *
     * `lastPendingReportedAt` is this SERVER's own receipt time
     * (`new Date()` below), not a client-supplied timestamp — per the
     * explicit instruction to "use server receipt time for sync
     * freshness/staleness". Each call simply upserts with latest-arrival-
     * wins semantics: because staleness here is defined purely by arrival
     * time (not a device-side capture time, unlike FieldEvent), there is
     * no older/newer ambiguity to protect against — whichever report
     * reaches the server last IS, by definition, the most current known
     * sync state for that device as of now.
     */
    async reportSyncStatus(req: AuthRequest, res: Response) {
        try {
            const userId = req.user?.id;
            if (!userId) return errorResponse(res, "Unauthorized", [], 401);

            const { pendingCount, success, syncError } = req.body;
            if (typeof pendingCount !== "number" || pendingCount < 0) {
                return errorResponse(res, "pendingCount (>= 0) is required", [], 400);
            }

            let status = await this.syncStatusRepo.findOne({ where: { userId } });
            if (!status) {
                status = this.syncStatusRepo.create({ userId });
            }

            const now = new Date();
            status.lastPendingCount = pendingCount;
            status.lastPendingReportedAt = now;

            if (success === true || pendingCount === 0) {
                status.lastSuccessfulSyncAt = now;
            }

            if (syncError) {
                status.lastSyncError = String(syncError);
                status.lastSyncErrorAt = now;
            } else if (success === true) {
                // A reported success clears any previously-shown error -
                // otherwise a long-resolved error would linger forever on
                // the Monitoring view even after the device recovered.
                status.lastSyncError = null;
                status.lastSyncErrorAt = null;
            }

            await this.syncStatusRepo.save(status);
            return successResponse(res, status, "Sync status reported");
        } catch (error: any) {
            console.error("Report Sync Status Error", error);
            return errorResponse(res, "Error reporting sync status", [error.message], 500);
        }
    }

    /** A given inspector's own currently-unsynced items (for their own app UI, if ever needed server-side). */
    async getMine(req: AuthRequest, res: Response) {
        try {
            const inspectorId = req.user?.id;
            if (!inspectorId) return errorResponse(res, "Unauthorized", [], 401);

            const records = await this.repo.find({
                where: [
                    { inspectorId, status: OfflineSubmissionStatus.PENDING },
                    { inspectorId, status: OfflineSubmissionStatus.FAILED },
                ],
            });
            records.sort((a, b) => new Date(b.reportedAt).getTime() - new Date(a.reportedAt).getTime());
            return successResponse(res, records);
        } catch (error: any) {
            console.error("Get My Offline Submissions Error", error);
            return errorResponse(res, "Error fetching offline submissions", [error.message], 500);
        }
    }
}
