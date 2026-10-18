import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { Application } from "./Application";

// Payment method chosen by the applicant when submitting proof of
// payment. Cheque payments route through PENDING_CHEQUE_CLEARANCE before
// PAYMENT_VERIFIED, per the spec; the other methods go straight from
// PAYMENT_VERIFICATION_PENDING to PAYMENT_VERIFIED once Finance confirms.
export enum PaymentMethod {
    BANK_TRANSFER = "BANK_TRANSFER",
    MOBILE_MONEY = "MOBILE_MONEY",
    CHEQUE = "CHEQUE",
    CASH_AT_LACRA = "CASH_AT_LACRA",
}

/**
 * One row per payment submission attempt for a given Application.
 * Deliberately a separate, proper typed entity (not folded into
 * Application.data) — same rationale as WarehouseAssessment/Invoice.
 *
 * `versionNumber` is bumped whenever Finance rejects a submission via
 * PAYMENT_CORRECTION_REQUIRED and the applicant re-submits — a new row is
 * created for each submission attempt rather than overwriting the
 * previous one, preserving the full payment history for audit.
 * `getCurrentPayment()` in ApplicationController always returns the
 * highest-versionNumber row for an application.
 */
@Entity()
export class PaymentSubmission {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => Application, { onDelete: "CASCADE" })
    @JoinColumn({ name: "applicationId" })
    application!: Application;

    @Column()
    applicationId!: string;

    @Column({ default: 1 })
    versionNumber!: number;

    @Column()
    invoiceId!: string;

    @Column({ type: "simple-enum", enum: PaymentMethod, nullable: true })
    method!: PaymentMethod;

    @Column({ nullable: true })
    referenceNumber!: string;

    @Column({ type: "float", nullable: true })
    amountPaid!: number;

    // Proof-of-payment upload (receipt/screenshot), same Cloudinary upload
    // path as /apply's DocumentUpload component.
    @Column({ nullable: true })
    proofDocumentUrl!: string;

    @Column({ nullable: true })
    proofDocumentName!: string;

    @Column({ type: "timestamp", nullable: true })
    submittedAt!: Date;

    @Column({ nullable: true })
    verifiedByUserId!: string;

    @Column({ nullable: true })
    verifiedByName!: string;

    @Column({ type: "timestamp", nullable: true })
    verifiedAt!: Date;

    // Set on PENDING_CHEQUE_CLEARANCE -> PAYMENT_VERIFIED transition.
    @Column({ type: "timestamp", nullable: true })
    chequeClearedAt!: Date;

    @Column({ type: "text", nullable: true })
    notes!: string;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
