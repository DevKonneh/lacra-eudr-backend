import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

export enum OfflineSubmissionStatus {
    PENDING = "PENDING", // Queued on the device, not yet synced
    SYNCED = "SYNCED",   // Successfully synced - the real Farmer/Farm record now exists
    FAILED = "FAILED"    // At least one sync attempt failed (device retains it locally and will retry)
}

/**
 * A lightweight "shadow record" of a farmer registration that an inspector's
 * device captured while offline (or while the live submission failed due to
 * a network error), but has NOT yet fully synced to the real Farmer/Farm
 * tables.
 *
 * IMPORTANT: this is deliberately a small, text-only summary (no photos, no
 * boundary geometry) - the whole point is that it must be reportable over a
 * weak/flaky connection where the full multipart registration payload would
 * time out. It exists purely so admins/inspectors have visibility into
 * "data that exists on a device somewhere but hasn't reached the server
 * yet", which was previously completely invisible to the backend.
 *
 * Lifecycle:
 *  1. Mobile app queues the registration locally (PendingSyncItem) and
 *     best-effort POSTs a summary here -> row created with status PENDING.
 *  2. If a sync attempt fails, the mobile app PATCHes this row with the
 *     updated retryCount/lastError (still PENDING/marked FAILED).
 *  3. Once the real registration succeeds, the mobile app marks this row
 *     SYNCED (optionally linking syncedFarmerId), or deletes it outright.
 *
 * Uniqueness is enforced on (clientId, inspectorId) so re-reporting the same
 * locally-queued item (e.g. after a retry) updates the existing row instead
 * of creating duplicates.
 */
@Entity()
@Index(["clientId", "inspectorId"], { unique: true })
export class OfflineSubmission {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    // The mobile app's own local queue id (PendingSyncItem.id) - lets the
    // device correlate this shadow record back to its local entry when
    // marking it synced/deleted later.
    @Column()
    clientId!: string;

    // Which inspector's device this came from (from the JWT, not trusted
    // client input) - lets admins see "who has unsynced data" and lets an
    // inspector's own PATCH/DELETE calls be scoped to only their own rows.
    @Column()
    inspectorId!: string;

    @Column({ nullable: true })
    inspectorName!: string;

    @Column({ nullable: true })
    displayName!: string; // Farmer full name, best-effort at report time

    @Column({ nullable: true })
    phoneNumber!: string;

    @Column({ nullable: true })
    community!: string;

    @Column({ nullable: true })
    district!: string;

    @Column({ nullable: true })
    region!: string;

    @Column({ nullable: true })
    farmName!: string;

    @Column({ nullable: true })
    cropType!: string;

    @Column({
        type: "simple-enum",
        enum: OfflineSubmissionStatus,
        default: OfflineSubmissionStatus.PENDING
    })
    status!: OfflineSubmissionStatus;

    @Column({ default: 0 })
    retryCount!: number;

    @Column({ type: "text", nullable: true })
    lastError!: string;

    // When the device itself captured/queued this registration (may be well
    // before reportedAt, if the device stayed offline for a while).
    @Column({ nullable: true })
    capturedAt!: Date;

    // Once actually synced, the id of the real Farmer record it became.
    @Column({ nullable: true })
    syncedFarmerId!: string;

    @CreateDateColumn()
    reportedAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
