import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm";

// ---------------------------------------------------------------------------
// The five public application categories, matching the /apply wizard on the
// admin panel exactly (Step1ApplicationType.tsx's ApplicationCategory type).
// ---------------------------------------------------------------------------
export enum ApplicationCategory {
    LOCAL_BUYER = "LOCAL_BUYER",
    AGENCY = "AGENCY",
    COOPERATIVE = "COOPERATIVE",
    LOCAL_EXPORTER = "LOCAL_EXPORTER",
    FOREIGN_EXPORTER = "FOREIGN_EXPORTER",
}

// How the application entered the system — Online Self-Service (applicant
// fills in /apply themselves) vs Office-Assisted (Commercial/Marketing
// staff enter it on a walk-in applicant's behalf using the same form).
export enum ApplicationChannel {
    ONLINE = "ONLINE",
    OFFICE_ASSISTED = "OFFICE_ASSISTED",
}

// The full 41-status workflow, verbatim from the CMIS extension
// specification. Kept as one flat enum (rather than per-department sub-
// enums) so a single WORKFLOW_TRANSITIONS table (added in a later phase)
// can validate every transition centrally, and so status history/audit
// records always reference one canonical value.
export enum ApplicationStatus {
    DRAFT = "DRAFT",
    SUBMITTED = "SUBMITTED",
    AWAITING_COMMERCIAL_VERIFICATION = "AWAITING_COMMERCIAL_VERIFICATION",
    COMMERCIAL_REVIEW_IN_PROGRESS = "COMMERCIAL_REVIEW_IN_PROGRESS",
    APPLICANT_CORRECTION_REQUIRED = "APPLICANT_CORRECTION_REQUIRED",
    COMMERCIALLY_VERIFIED = "COMMERCIALLY_VERIFIED",
    AWAITING_FIRST_DG_APPROVAL = "AWAITING_FIRST_DG_APPROVAL",
    RETURNED_TO_COMMERCIAL = "RETURNED_TO_COMMERCIAL",
    COMMERCIAL_STAGE_APPROVED = "COMMERCIAL_STAGE_APPROVED",
    AWAITING_TECHNICAL_REVIEW = "AWAITING_TECHNICAL_REVIEW",
    INSPECTOR_ASSIGNMENT_PENDING = "INSPECTOR_ASSIGNMENT_PENDING",
    INSPECTOR_ASSIGNED = "INSPECTOR_ASSIGNED",
    WAREHOUSE_INSPECTION_SCHEDULED = "WAREHOUSE_INSPECTION_SCHEDULED",
    WAREHOUSE_ASSESSMENT_IN_PROGRESS = "WAREHOUSE_ASSESSMENT_IN_PROGRESS",
    WAREHOUSE_ASSESSMENT_SUBMITTED = "WAREHOUSE_ASSESSMENT_SUBMITTED",
    WAREHOUSE_REINSPECTION_REQUIRED = "WAREHOUSE_REINSPECTION_REQUIRED",
    AWAITING_TECHNICAL_VERIFICATION = "AWAITING_TECHNICAL_VERIFICATION",
    TECHNICALLY_VERIFIED = "TECHNICALLY_VERIFIED",
    AWAITING_SECOND_DG_APPROVAL = "AWAITING_SECOND_DG_APPROVAL",
    RETURNED_TO_TECHNICAL_SERVICES = "RETURNED_TO_TECHNICAL_SERVICES",
    TECHNICAL_STAGE_APPROVED = "TECHNICAL_STAGE_APPROVED",
    AWAITING_BILLING_REVIEW = "AWAITING_BILLING_REVIEW",
    BILLING_REVIEW_IN_PROGRESS = "BILLING_REVIEW_IN_PROGRESS",
    INVOICE_APPROVED = "INVOICE_APPROVED",
    AWAITING_APPLICANT_PAYMENT = "AWAITING_APPLICANT_PAYMENT",
    PAYMENT_SUBMITTED = "PAYMENT_SUBMITTED",
    PAYMENT_VERIFICATION_PENDING = "PAYMENT_VERIFICATION_PENDING",
    PAYMENT_CORRECTION_REQUIRED = "PAYMENT_CORRECTION_REQUIRED",
    PENDING_CHEQUE_CLEARANCE = "PENDING_CHEQUE_CLEARANCE",
    PAYMENT_VERIFIED = "PAYMENT_VERIFIED",
    AWAITING_FINAL_DG_APPROVAL = "AWAITING_FINAL_DG_APPROVAL",
    RETURNED_TO_FINANCE = "RETURNED_TO_FINANCE",
    APPROVED_FOR_ISSUANCE = "APPROVED_FOR_ISSUANCE",
    AWAITING_IT_CERTIFICATE_PRINTING = "AWAITING_IT_CERTIFICATE_PRINTING",
    CERTIFICATE_PRINTED = "CERTIFICATE_PRINTED",
    ISSUED = "ISSUED",
    REJECTED = "REJECTED",
    SUSPENDED = "SUSPENDED",
    REVOKED = "REVOKED",
    EXPIRED = "EXPIRED",
    CANCELLED = "CANCELLED",
}

/**
 * A LACRA permit/licence application submitted through the public /apply
 * wizard (online self-service) or entered on a walk-in applicant's behalf
 * by Commercial/Marketing staff (office-assisted) — both channels use the
 * exact same form and land in this same table, per the CMIS extension spec.
 *
 * `data` stores the full ApplicationState JSON exactly as produced by the
 * /apply wizard (category-specific info, warehouse, personnel/leadership/
 * farmers/owners/suppliers, documents, declaration). This is deliberately
 * schema-flexible (jsonb) rather than one column per field, because the
 * five categories have materially different shapes and the wizard's shape
 * may keep evolving — the workflow entities added in later phases
 * (WarehouseAssessment, Invoice, PaymentSubmission, etc.) are what get
 * proper typed columns, since those are net-new internal data, not a
 * mirror of applicant-supplied JSON.
 *
 * Per the spec's "applicant-submitted info becomes read-only after
 * submission" rule: once a row exists here it is never edited directly by
 * this controller past submit() — corrections happen through a dedicated
 * correction workflow (added in a later phase) that preserves the original
 * and creates a new ApplicationVersion, never overwriting `data` in place.
 */
@Entity()
export class Application {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    // Format: LACRA-APP-{year}-{6-digit sequence}, e.g. LACRA-APP-2026-000001
    @Column({ unique: true, nullable: true })
    applicationNumber!: string;

    @Column({ type: "simple-enum", enum: ApplicationCategory })
    category!: ApplicationCategory;

    @Column({ nullable: true })
    commodity!: string;

    @Column({ type: "simple-enum", enum: ApplicationChannel, default: ApplicationChannel.ONLINE })
    channel!: ApplicationChannel;

    // "Self-Service" (applicant submitted it themselves) or
    // "Entered by Commercial" (office-assisted intake).
    @Column({ nullable: true })
    submissionMethod!: string;

    @Column({ type: "simple-enum", enum: ApplicationStatus, default: ApplicationStatus.SUBMITTED })
    status!: ApplicationStatus;

    @Column({ type: "jsonb" })
    data!: any;

    // -----------------------------------------------------------------
    // Office-Assisted intake metadata — all null for Online Self-Service.
    // Kept as distinct columns (not folded into `data`) so it's always
    // clearly separable from applicant-provided information, per the
    // spec's "must clearly distinguish applicant-provided vs officer-
    // entered vs later-verified info" requirement.
    // -----------------------------------------------------------------
    @Column({ nullable: true })
    officeApplicantName!: string;

    @Column({ nullable: true })
    officeApplicantPhone!: string;

    @Column({ nullable: true })
    officeApplicantEmail!: string;

    @Column({ nullable: true })
    officeLocation!: string;

    @Column({ nullable: true })
    enteringOfficerName!: string;

    @Column({ nullable: true })
    enteringOfficerUserId!: string;

    @Column({ type: "text", nullable: true })
    assistedEntryReason!: string;

    @Column({ default: false })
    applicantConsentConfirmed!: boolean;

    // Set only if the HTTP request that submitted this application carried
    // a valid auth token (e.g. an office-assisted submission by a logged-in
    // Commercial officer). Null for anonymous online self-service
    // submissions, which is the normal case for /apply.
    @Column({ nullable: true })
    submittedByUserId!: string;

    @Column({ type: "timestamp", nullable: true })
    submittedAt!: Date;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
