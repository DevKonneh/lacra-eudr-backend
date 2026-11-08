import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

/**
 * One record per "Import Agency Register" run (preview or apply),
 * mirroring LocalProduceBuyerImportRun's "source, date, responsible user,
 * result" pattern exactly.
 *
 * IMPORTANT: this is a review-then-apply workflow against a one-time
 * uploaded historical reconciliation package (11 Agency rows + 7
 * historical Agent entries), not a live connection to any external
 * system. Re-running apply against the same source is safe and idempotent
 * (see AgencyImportService) — matched records are left untouched, nothing
 * is ever deleted, and the permit-030/041 conflicts plus every
 * incomplete-staffing flag are re-detected and re-reported on every run
 * rather than silently resolved.
 */
@Entity()
export class AgencyImportRun {
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
    matchedAgencyCount!: number;

    @Column({ type: "int", default: 0 })
    addedAgencyCount!: number;

    @Column({ type: "int", default: 0 })
    conflictAgencyCount!: number;

    @Column({ type: "int", default: 0 })
    totalAgencySourceRecords!: number;

    @Column({ type: "int", default: 0 })
    matchedPersonnelCount!: number;

    @Column({ type: "int", default: 0 })
    addedPersonnelCount!: number;

    @Column({ type: "int", default: 0 })
    totalPersonnelSourceRecords!: number;

    // Full per-record preview/result payload (agencies[] and
    // personnel[] arrays) so staff can see exactly what a past run
    // did/would do, not just the summary counts.
    @Column({ type: "text", nullable: true })
    detailsJson!: string | null;

    @CreateDateColumn()
    createdAt!: Date;
}
