import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn } from "typeorm";
import { Farm } from "./Farm";

export enum DocumentType {
    LAND_TITLE = "Land Title",
    CONSENT = "Consent",
    REGISTRATION = "Registration",
    OTHER = "Other"
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
