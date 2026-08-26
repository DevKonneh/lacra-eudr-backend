import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn } from "typeorm";
import { Farm } from "./Farm";

export enum DocumentType {
    // Legacy values - kept so existing records/admin-panel code paths
    // continue to work unchanged.
    LAND_TITLE = "Land Title",
    CONSENT = "Consent",
    REGISTRATION = "Registration",
    OTHER = "Other",
    // EUDR due-diligence document types collected by the mobile app
    // (FarmerAttachmentsStep "Compliance Documents" section).
    NATIONAL_ID = "National ID / Identification Document",
    LAND_DEED = "Land Deed / Land Ownership Document",
    LEASE_AGREEMENT = "Lease / Land-Use Agreement",
    CUSTOMARY_AUTHORIZATION = "Customary or Community Land Authorization",
    COOPERATIVE_MEMBERSHIP = "Cooperative/Association Membership Document"
}

export enum DocumentStatus {
    VALID = "Valid",
    INVALID = "Invalid",
    PENDING = "Pending"
}

@Entity()
export class FarmDocument {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => Farm)
    farm!: Farm;

    @Column()
    farmId!: string;

    @Column({
        type: "enum",
        enum: DocumentType
    })
    type!: DocumentType;

    @Column()
    documentUrl!: string;

    @Column({
        type: "enum",
        enum: DocumentStatus,
        default: DocumentStatus.PENDING
    })
    status!: DocumentStatus;

    @CreateDateColumn()
    uploadedAt!: Date;
}
