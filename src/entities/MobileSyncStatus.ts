import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm";

/**
 * One row per enumerator, upserted by the mobile app's existing offline-
 * sync reporting flow (OfflineSyncService._reportShadowRecord /
 * syncSelectedItems in the Flutter app -> OfflineSubmissionController on
 * the backend). Backs the Enumerator Monitoring tab's "Sync visibility"
 * requirement: last successful sync, last reported pending count (with
 * the time of THAT report, which is distinct from "now"), and the last
 * sync error if any.
 *
 * IMPORTANT per the explicit instruction: this must "report a successful
 * cycle with zero items pending, including after the final item uploads" -
 * i.e. the mobile app must call the reporting endpoint one final time with
 * pendingCount: 0 once its queue empties, not just silently stop
 * reporting (which would otherwise leave this row stuck showing the
 * second-to-last nonzero count forever). See
 * OfflineSubmissionController.reportSyncStatus() / OfflineSyncService
 * changes in the Flutter app.
 */
@Entity()
export class MobileSyncStatus {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ unique: true })
    userId!: string;

    @Column({ type: "timestamp", nullable: true })
    lastSuccessfulSyncAt!: Date | null;

    // The pending-queue size as last REPORTED by the device - not computed
    // server-side (the server has no way to see the device's local queue
    // except via these reports).
    @Column({ type: "int", nullable: true })
    lastPendingCount!: number | null;

    // When the lastPendingCount value above was reported - kept distinct
    // from `updatedAt` so "stale report" can be judged correctly even if
    // some other field on this row changes at a different time.
    @Column({ type: "timestamp", nullable: true })
    lastPendingReportedAt!: Date | null;

    @Column({ type: "text", nullable: true })
    lastSyncError!: string | null;

    @Column({ type: "timestamp", nullable: true })
    lastSyncErrorAt!: Date | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
