import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { Application } from "./Application";

/**
 * The final permit/licence certificate record for an Application — created
 * once (APPROVED_FOR_ISSUANCE -> AWAITING_IT_CERTIFICATE_PRINTING) and
 * updated through CERTIFICATE_PRINTED -> ISSUED. One-to-one with
 * Application in practice (an application only ever gets one certificate
 * per successful run through the workflow), but modeled as its own
 * ManyToOne-keyed entity for consistency with Invoice/PaymentSubmission
 * and to leave room for a future re-issuance/reprint scenario.
 *
 * `certificateNumber` is what the public QR-verification page
 * (added alongside this entity) looks up, and is embedded in the QR code
 * printed on the certificate PDF.
 */
@Entity()
export class Certificate {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => Application, { onDelete: "CASCADE" })
    @JoinColumn({ name: "applicationId" })
    application!: Application;

    @Column()
    applicationId!: string;

    // Format: LACRA-CERT-{year}-{6-digit sequence}, e.g. LACRA-CERT-2026-000001
    @Column({ unique: true, nullable: true })
    certificateNumber!: string;

    @Column({ nullable: true })
    permitOrLicenceType!: string;

    @Column({ type: "timestamp", nullable: true })
    issueDate!: Date;

    @Column({ type: "timestamp", nullable: true })
    expiryDate!: Date;

    @Column({ nullable: true })
    printedByUserId!: string;

    @Column({ nullable: true })
    printedByName!: string;

    @Column({ type: "timestamp", nullable: true })
    printedAt!: Date;

    @Column({ type: "timestamp", nullable: true })
    issuedAt!: Date;

    // Populated once a PDF-generation step is wired up (not part of this
    // phase's scope — printing here means "IT marks the certificate as
    // printed", not literal server-side PDF rendering); left nullable so
    // the certificate record and QR verification can exist without it.
    @Column({ nullable: true })
    documentUrl!: string;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
