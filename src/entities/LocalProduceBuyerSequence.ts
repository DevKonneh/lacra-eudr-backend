import { Entity, PrimaryColumn, Column } from "typeorm";

/**
 * Single-row atomic counter backing the Local Produce Buyer permit number
 * format LACRA-{###}-{YYYY}. Unlike the LACRA-CERT-{year}-{6digit} numbers
 * used by the other four application categories (which reset their
 * sequence every calendar year — see ApplicationController.nextSequentialNumber),
 * the Local Produce Buyer register's own numbering (seen in the imported
 * historical register, 007 through 290) is a single running sequence that
 * does NOT reset annually — a permit issued in 2027 continues from wherever
 * 2026's last number left off. This table exists purely so that
 * continuation can be enforced atomically (SELECT ... FOR UPDATE + UPDATE in
 * one transaction) instead of being derived by counting existing rows,
 * which would race under concurrent issuance.
 *
 * Exactly one row exists (id = 1), seeded by the historical import to start
 * above the highest number present in the imported register (including the
 * explicitly pinned/reserved legacy numbers), so the very next value
 * allocated after import is guaranteed to be unused.
 */
@Entity()
export class LocalProduceBuyerSequence {
    @PrimaryColumn({ type: "int", default: 1 })
    id!: number;

    @Column({ type: "int", default: 0 })
    lastNumber!: number;

    @Column({ type: "timestamp", nullable: true })
    updatedAt!: Date;
}
