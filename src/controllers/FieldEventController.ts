import { Response } from "express";
import { AppDataSource } from "../data-source";
import { FieldEvent, FieldEventType } from "../entities/FieldEvent";
import { successResponse, errorResponse } from "../utils/response";
import { AuthRequest } from "../middleware/auth.middleware";

/**
 * Authenticated check-in / check-out ingestion for field enumerators.
 *
 * Per explicit requirements:
 *   - The enumerator is ALWAYS derived from the authenticated request
 *     (req.user.id), never from client-supplied identity in the body.
 *   - Check-in succeeds WITHOUT a GPS coordinate (e.g. location permission
 *     denied) - latitude/longitude are simply left null in that case.
 *   - Check-out succeeds WITHOUT collecting GPS at all - the client is not
 *     even expected to attempt a GPS read for a check-out, and any
 *     latitude/longitude sent with a CHECK_OUT body is ignored.
 *   - Retries are deduplicated via the (enumeratorId, eventId) unique
 *     index on FieldEvent - the client generates a stable `eventId` once
 *     per logical check-in/check-out action and resends it unchanged on
 *     every retry, so re-submitting the same event is a safe no-op
 *     (`.orIgnore()`), never a second row.
 */
export class FieldEventController {
    private repo = AppDataSource.getRepository(FieldEvent);

    /**
     * POST /api/field-events/check-in
     * POST /api/field-events/check-out
     * body: { eventId: string, latitude?: number, longitude?: number,
     *         gpsAccuracyM?: number, capturedAt?: string (ISO),
     *         assignmentContext?: string }
     */
    private async ingest(req: AuthRequest, res: Response, type: FieldEventType) {
        try {
            const enumeratorId = req.user?.id;
            if (!enumeratorId) return errorResponse(res, "Unauthorized", [], 401);

            const { eventId, latitude, longitude, gpsAccuracyM, capturedAt, assignmentContext } = req.body;

            if (!eventId || typeof eventId !== "string") {
                return errorResponse(res, "eventId is required", [], 400);
            }

            // CHECK_OUT never carries GPS, even if the client sent some -
            // per the explicit requirement "check-out succeeds without
            // collecting GPS" (not just "GPS is optional").
            const carriesGps = type !== FieldEventType.CHECK_OUT;

            const values: Partial<FieldEvent> = {
                eventId,
                enumeratorId,
                type,
                assignmentContext: assignmentContext ?? null,
                latitude: carriesGps && typeof latitude === "number" ? latitude : null,
                longitude: carriesGps && typeof longitude === "number" ? longitude : null,
                gpsAccuracyM: carriesGps && typeof gpsAccuracyM === "number" ? gpsAccuracyM : null,
                capturedAt: capturedAt ? new Date(capturedAt) : new Date(),
            };

            // Idempotent insert: a retried submission of the SAME
            // (enumeratorId, eventId) pair is silently ignored rather than
            // creating a duplicate row or erroring.
            await this.repo
                .createQueryBuilder()
                .insert()
                .into(FieldEvent)
                .values(values)
                .orIgnore()
                .execute();

            // Return the actual persisted row (whether just inserted, or
            // already existing from an earlier attempt of this same event)
            // so the client always gets a consistent confirmation.
            const record = await this.repo.findOne({ where: { enumeratorId, eventId } });
            return successResponse(res, record, `${type} recorded`, 201);
        } catch (error: any) {
            console.error(`Field Event Ingest Error (${type})`, error);
            return errorResponse(res, "Error recording field event", [error.message], 500);
        }
    }

    async checkIn(req: AuthRequest, res: Response) {
        return this.ingest(req, res, FieldEventType.CHECK_IN);
    }

    async checkOut(req: AuthRequest, res: Response) {
        return this.ingest(req, res, FieldEventType.CHECK_OUT);
    }
}
