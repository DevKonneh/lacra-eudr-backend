import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { Application } from "./Application";

/**
 * One row per invoice issued for a given Application. Deliberately a
 * separate, proper typed entity (not folded into Application.data, which
 * is reserved for the applicant-submitted JSON blob per Application.ts's
 * docblock) — same rationale as WarehouseAssessment in Stage 3.
 *
 * `versionNumber` starts at 1 and is bumped whenever Billing has to
 * re-issue an invoice for the same application (e.g. after the DG returns
 * the application to Finance at the final-approval stage over a billing
 * discrepancy) — a new Invoice row is created rather than mutating the
 * previous one, so the full billing history is preserved for audit.
 * `getCurrentInvoice()` in ApplicationController always returns the
 * highest-versionNumber row for an application.
 */
@Entity()
export class Invoice {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => Application, { onDelete: "CASCADE" })
    @JoinColumn({ name: "applicationId" })
    application!: Application;

    @Column()
    applicationId!: string;

    @Column({ default: 1 })
    versionNumber!: number;

    // Format: LACRA-INV-{year}-{6-digit sequence}, e.g. LACRA-INV-2026-000001
    @Column({ unique: true, nullable: true })
    invoiceNumber!: string;

    @Column({ default: "USD" })
    currency!: string;

    @Column({ type: "float" })
    amount!: number;

    // [{ label: "Application Processing Fee", amount: 100 }, ...] — kept as
    // jsonb since the exact fee line items are a Billing/content concern,
    // not a schema concern.
    @Column({ type: "jsonb", nullable: true })
    feeBreakdown!: { label: string; amount: number }[];

    @Column({ type: "text", nullable: true })
    notes!: string;

    @Column({ nullable: true })
    createdByUserId!: string;

    @Column({ nullable: true })
    createdByName!: string;

    @Column({ type: "timestamp", nullable: true })
    approvedAt!: Date;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
