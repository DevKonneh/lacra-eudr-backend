import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

/**
 * One record per "Import Local Produce Buyer Register" run (preview or
 * apply), mirroring CooperativeImportRun's "source, date, responsible user,
 * result" pattern. `source` is always a fixed, honest label naming the
 * specific uploaded register file — never implies a live external feed.
 *
 * IMPORTANT: this is a review-then-apply workflow against a one-time
 * uploaded historical register (82 original rows + Bill Gruyoo's
 * separately-recovered record = 83 total), not a live connection to any
 * external system. Re-running apply against the same source is safe and
 * idempotent (see LocalProduceBuyerImportService) — matched records are
 * left untouched, nothing is ever deleted, and duplicate-number/date
 * conflicts are re-detected and re-staged for review on every run rather
 * than silently resolved.
 */
@Entity()
export class LocalProduceBuyerImportRun {
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

    // Full per-record preview/result payload (source record id, name,
    // permit number, status: MATCHED/ADDED/CONFLICT, and for conflicts the
    // specific reason) so staff can see exactly what a past run did/would
    // do, not just the summary counts.
    @Column({ type: "text", nullable: true })
    detailsJson!: string | null;

    @CreateDateColumn()
    createdAt!: Date;
}
