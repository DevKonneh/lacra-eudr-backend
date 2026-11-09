import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

/**
 * One record per "Import Exporter Register" run (preview or apply),
 * mirroring LocalProduceBuyerImportRun's and AgencyImportRun's "source,
 * date, responsible user, result" pattern exactly.
 *
 * IMPORTANT: this is a review-then-apply workflow against a one-time
 * authorized historical batch (12 Exporter rows), not a live connection
 * to any external system. Re-running apply against the same source is
 * safe and idempotent (see ExporterImportService) — matched records are
 * left untouched, nothing is ever deleted, and the Meridian county
 * discrepancy is re-detected and re-reported on every run rather than
 * silently resolved.
 */
@Entity()
export class ExporterImportRun {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column()
    source!: string;

    @Column({ default: false })
    isDryRun!: boolean;

    @Column({ type: "varchar", nullable: true })
    performedByUserId!: string | null;

    @Column({ type: "varchar", nullable: true })
    performedByName!: string | null;

    @Column({ type: "int", default: 0 })
    matchedCount!: number;

    @Column({ type: "int", default: 0 })
    addedCount!: number;

    @Column({ type: "int", default: 0 })
    conflictCount!: number;

    @Column({ type: "int", default: 0 })
    totalSourceRecords!: number;

    // Full per-record preview/result payload (source record id, exporter
    // name, license number, status: MATCHED/ADDED/CONFLICT, and for
    // conflicts the specific reason) so staff can see exactly what a past
    // run did/would do, not just the summary counts.
    @Column({ type: "text", nullable: true })
    detailsJson!: string | null;

    @CreateDateColumn()
    createdAt!: Date;
}
