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

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
