import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

/**
 * One record per "Import CDA Records" run (see CooperativeController's
 * previewImport/applyImport). Captures exactly what the spec asks for:
 * "the import source, date, responsible user, and result" — so the
 * registry maintenance screen can show a real history of imports instead
 * of only the result of the most recent one.
 *
 * IMPORTANT: this is a review-then-apply workflow against the single
 * embedded CDA_COOPERATIVE_SEED_DATA source file, not a live connection
 * to any external CDA system — `source` is always a fixed, honest label
 * ("Embedded CDA Listing (cdaCooperativeSeedData.ts)") rather than
 * anything implying a live feed, per the requirement not to imply a live
 * CDA connection that does not exist.
 */
@Entity()
export class CooperativeImportRun {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column()
    source!: string;

    @Column({ nullable: true })
    performedByUserId!: string | null;

    @Column({ nullable: true })
    performedByName!: string | null;

    @Column({ type: "int", default: 0 })
    newCount!: number;

    @Column({ type: "int", default: 0 })
    changedCount!: number;

    @Column({ type: "int", default: 0 })
    unchangedCount!: number;

    @Column({ type: "int", default: 0 })
    flaggedCount!: number;

    // Full per-record preview/result payload (slug, status, changed
    // fields) kept as JSON so the maintenance screen can show "what
    // exactly happened" for a past run, not just the summary counts.
    @Column({ type: "text", nullable: true })
    detailsJson!: string | null;

    @CreateDateColumn()
    createdAt!: Date;
}
