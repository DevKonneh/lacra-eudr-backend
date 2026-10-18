import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne } from "typeorm";
import { Business } from "./Business";

export enum PermitStatus {
    DRAFT = "DRAFT",
    SUBMITTED = "SUBMITTED",
    RETURNED_FOR_CORRECTION = "RETURNED_FOR_CORRECTION",
    RECOMMENDED_TO_DG = "RECOMMENDED_TO_DG",
    DG_APPROVED = "DG_APPROVED",
    DG_REJECTED = "DG_REJECTED",
    PERMIT_ISSUED = "PERMIT_ISSUED"
}

// Matches LACRA Form No. 0050 "Type of Entity" — the Permit path covers these
// three actor types only. (Exporters use the separate License/Form path.)
export enum PermitEntityType {
    LOCAL_BUYER = "LOCAL_BUYER",
    AGENCY = "AGENCY",
    COOPERATIVE = "COOPERATIVE"
}

export enum PermitGender {
    MALE = "MALE",
    FEMALE = "FEMALE"
}

export enum PermitIdType {
    NATIONAL_ID = "NATIONAL_ID",
    PASSPORT = "PASSPORT",
    DRIVER_LICENSE = "DRIVER_LICENSE",
    VOTER_ID = "VOTER_ID",
    OTHER = "OTHER"
}

// Matches LACRA Form No. 0050 Section C "Intended Commodity (Cocoa / Coffee / Palm)".
export enum PermitCommodity {
    COCOA = "COCOA",
    COFFEE = "COFFEE",
    PALM = "PALM"
}

/**
 * Permit application record.
 *
 * Field set below mirrors LACRA's official paper intake form (Form No. 0050
 * "LACRA Permit Application Form — For Local Produce Buyer, Agency, and
 * Cooperative Applicants") section-for-section, so the online form is a
 * faithful digital equivalent of what applicants already fill in on paper:
 *   Section A — Applicant Information
 *   Section B — Ownership and Management
 *   Section C — Operational Information
 *   Section D — Declaration
 * Section E (LACRA Internal Use Only) is handled by staff during review
 * (see permitNumber, status, and internalRemarks) rather than by the applicant.
 */
@Entity()
export class Permit {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ unique: true, nullable: true })
    permitNumber!: string;

    @ManyToOne(() => Business, (business) => business.permits)
    business!: Business;

    @Column({
        type: "simple-enum",
        enum: PermitStatus,
        default: PermitStatus.DRAFT
    })
    status!: PermitStatus;

    @Column({ nullable: true })
    validFrom!: Date;

    @Column({ nullable: true })
    validTo!: Date;

    @Column("simple-array", { nullable: true })
    documents!: string[];

    // ---------------------------------------------------------------
    // SECTION A — Applicant Information
    // ---------------------------------------------------------------
    @Column({ nullable: true })
    businessName!: string;

    @Column({
        type: "simple-enum",
        enum: PermitEntityType,
        nullable: true
    })
    typeOfEntity!: PermitEntityType;

    @Column({ nullable: true })
    tinNumber!: string;

    @Column({ nullable: true })
    county!: string;

    @Column({ nullable: true })
    district!: string;

    @Column({ nullable: true })
    businessAddress!: string;

    @Column({ nullable: true })
    contactPerson!: string;

    @Column({ nullable: true })
    phoneNumber!: string;

    @Column({ nullable: true })
    emailAddress!: string;

    @Column({ nullable: true })
    whatsapp!: string;

    // ---------------------------------------------------------------
    // SECTION B — Ownership and Management
    // ---------------------------------------------------------------
    @Column({ nullable: true })
    ownerManagerName!: string;

    @Column({ nullable: true })
    dateOfBirth!: Date;

    @Column({
        type: "simple-enum",
        enum: PermitGender,
        nullable: true
    })
    gender!: PermitGender;

    @Column({ nullable: true })
    placeOfBirth!: string;

    @Column({ nullable: true })
    nationality!: string;

    @Column({ nullable: true })
    position!: string;

    @Column({
        type: "simple-enum",
        enum: PermitIdType,
        nullable: true
    })
    idType!: PermitIdType;

    @Column({ nullable: true })
    idNumber!: string;

    // ---------------------------------------------------------------
    // SECTION C — Operational Information
    // ---------------------------------------------------------------
    @Column("simple-array", { nullable: true })
    intendedCommodities!: PermitCommodity[];

    @Column({ nullable: true })
    estimatedPurchaseVolume!: string;

    @Column({ nullable: true })
    warehousingLocation!: string;

    @Column({ nullable: true })
    expectedAreasOfOperation!: string;

    // ---------------------------------------------------------------
    // SECTION D — Declaration
    // ---------------------------------------------------------------
    @Column({ default: false })
    declarationAccepted!: boolean;

    @Column({ nullable: true })
    declarationName!: string;

    @Column({ nullable: true })
    declarationDate!: Date;

    // ---------------------------------------------------------------
    // SECTION E — LACRA Internal Use Only (staff-entered, not applicant)
    // ---------------------------------------------------------------
    @Column({ type: "text", nullable: true })
    internalRemarks!: string;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
