import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToOne, JoinColumn, OneToMany } from "typeorm";
import { User } from "./User";
import { License } from "./License";
import { Permit } from "./Permit";

export enum BusinessType {
    EXPORTER = "EXPORTER",
    LOCAL_BUYER = "LOCAL_BUYER",
    AGENCY = "AGENCY",
    COOPERATIVE = "COOPERATIVE",
    TRANSPORTER = "TRANSPORTER",
    WAREHOUSE = "WAREHOUSE"
}

export enum BusinessEligibility {
    LICENSE_ALLOWED = "LICENSE_ALLOWED",
    PERMIT_ALLOWED = "PERMIT_ALLOWED",
    NONE = "NONE" // Should not happen for valid types
}

@Entity()
export class Business {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({
        type: "simple-enum",
        enum: BusinessType
    })
    type!: BusinessType;

    @Column()
    name!: string;

    @Column({ unique: true })
    registrationNumber!: string;

    @Column("simple-array", { nullable: true })
    kycDocuments!: string[];

    @Column({
        type: "simple-enum", // Using simple-enum to avoid DB synchronization headaches
        enum: BusinessEligibility
    })
    eligibility!: BusinessEligibility;

    // Link to the main User account (Owner/Admin of this business)
    @OneToOne(() => User)
    @JoinColumn()
    owner!: User;

    @OneToMany(() => License, (license) => license.business)
    licenses!: License[];

    @OneToMany(() => Permit, (permit) => permit.business)
    permits!: Permit[];

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
