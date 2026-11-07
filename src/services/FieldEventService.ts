import { AppDataSource } from "../data-source";
import { FieldEvent, FieldEventType } from "../entities/FieldEvent";

/**
 * Shared helper for writing FieldEvent rows, used both by the dedicated
 * check-in/check-out ingestion endpoint (FieldEventController) and,
 * server-side, by every farm-creation code path that captures a GPS
 * reference point (farmLatitude/farmLongitude) - per the explicit
 * requirement "Capture GPS at check-in and farm record capture" for the
 * Enumerator Monitoring tab's "Last reported location".
 *
 * IDEMPOTENCY (explicit requirement, and the bug fixed here): eventId is
 * now derived from the farm's own PERSISTED id (`farm-capture-<farmId>`),
 * not a freshly-generated random UUID. A farm row, once saved, always has
 * the same id on every retry of the same submission (the client/server
 * idempotency guards upstream - Farmer.clientRecordId, farm name+farmer
 * uniqueness - guarantee a retry resolves to the SAME Farm row rather than
 * creating a second one), so this id is a reliable, stable dedup key
 * without needing a separate client-generated event id for this
 * server-side-only event type.
 *
 * The actual insert uses INSERT ... ON CONFLICT DO NOTHING (via
 * `.orIgnore()`) against the (enumeratorId, eventId) unique index, so:
 *   - two different farms in one submission -> two different farmIds ->
 *     two different eventIds -> two rows.
 *   - retrying the SAME submission (same farm id) -> same eventId -> the
 *     second insert attempt is silently ignored -> still exactly one row
 *     for that farm, never a duplicate.
 *   - if the farm was saved successfully but this call never ran (e.g. a
 *     crash between the two), a LATER retry that reaches this farm again
 *     (same farm id) can still insert the row for the first time -
 *     recovering the missing event instead of leaving a permanent gap.
 */
export async function recordFarmCaptureFieldEvent(params: {
    farmId: string;
    enumeratorId: string | null | undefined;
    latitude: number | null | undefined;
    longitude: number | null | undefined;
    gpsAccuracyM?: number | null;
    capturedAt?: Date;
    assignmentContext?: string | null;
}): Promise<void> {
    // No known enumerator (e.g. a FARMER self-registering their own farm,
    // not an inspector/enumerator in the field) or no coordinate at all -
    // nothing to record for Monitoring purposes.
    if (!params.enumeratorId) return;
    if (params.latitude === null || params.latitude === undefined) return;
    if (params.longitude === null || params.longitude === undefined) return;
    if (!params.farmId) return;

    try {
        const repo = AppDataSource.getRepository(FieldEvent);
        await repo
            .createQueryBuilder()
            .insert()
            .into(FieldEvent)
            .values({
                eventId: `farm-capture-${params.farmId}`,
                enumeratorId: params.enumeratorId,
                type: FieldEventType.FARM_RECORD_CAPTURE,
                assignmentContext: params.assignmentContext ?? null,
                latitude: params.latitude,
                longitude: params.longitude,
                gpsAccuracyM: params.gpsAccuracyM ?? null,
                capturedAt: params.capturedAt ?? new Date(),
            })
            // ON CONFLICT (enumeratorId, eventId) DO NOTHING - see class doc
            // above. Without this, a retry (or a recovery attempt for a
            // farm whose event write previously failed) would throw a
            // unique-constraint violation instead of safely no-op'ing.
            .orIgnore()
            .execute();
    } catch (error) {
        // Best-effort: Monitoring visibility must never block or fail the
        // actual farm save that triggered it.
        console.error("Failed to record farm-capture field event", error);
    }
}
