import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { User } from "./User";
import { Business } from "./Business";

export enum LicenseType {
    LOCAL_BUYER = "LOCAL_BUYER",
    COOPERATIVE = "COOPERATIVE",
    AGENCY = "AGENCY",
    EXPORTER = "EXPORTER"
}

export enum LicenseStatus {
    DRAFT = "DRAFT",
    SUBMITTED = "SUBMITTED",
    RETURNED_FOR_CORRECTION = "RETURNED_FOR_CORRECTION",
    RECOMMENDED_TO_DG = "RECOMMENDED_TO_DG",
    DG_APPROVED = "DG_APPROVED",
    DG_REJECTED = "DG_REJECTED",
    LICENSE_ISSUED = "LICENSE_ISSUED",
    PENDING = "PENDING", // Keeping for backward compatibility if needed, or remove
    ACTIVE = "ACTIVE",
    REJECTED = "REJECTED",
    EXPIRED = "EXPIRED",
    SUSPENDED = "SUSPENDED"
}

@Entity()
export class License {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ unique: true })
    licenseNumber!: string;

    @Column({
        type: "simple-enum",
        enum: LicenseType
    })
    type!: LicenseType;

    @ManyToOne(() => Business, (business) => business.licenses)
    business!: Business;

    @Column({
        type: "simple-enum",
        enum: LicenseStatus,
        default: LicenseStatus.DRAFT
    })
    status!: LicenseStatus;

    @Column()
    holderName!: string;

    @Column({ nullable: true })
    validFrom!: Date;

    @Column({ nullable: true })
    validTo!: Date;

    @ManyToOne(() => User)
    @JoinColumn()
    user!: User;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
