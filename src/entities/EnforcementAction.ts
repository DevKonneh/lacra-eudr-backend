import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { User } from "./User";
import { Inspection } from "./Inspection";
import { QualityControl } from "./QualityControl";

export enum EnforcementType {
    WARNING = "WARNING",
    FINE = "FINE",
    LICENSE_SUSPENSION = "LICENSE_SUSPENSION",
    SHIPMENT_SEIZURE = "SHIPMENT_SEIZURE"
}

export enum EnforcementStatus {
    OPEN = "OPEN",
    UNDER_REVIEW = "UNDER_REVIEW",
    RESOLVED = "RESOLVED",
    APPEALED = "APPEALED"
}

@Entity()
export class EnforcementAction {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({
        type: "simple-enum",
        enum: EnforcementType
    })
    type!: EnforcementType;

    // Link to the trigger event (Inspection or QC)
    @ManyToOne(() => Inspection, { nullable: true })
    inspection?: Inspection;

    @ManyToOne(() => QualityControl, { nullable: true })
    qualityControl?: QualityControl;

    @ManyToOne(() => User)
    @JoinColumn()
    officer!: User;

    @Column("text")
    description!: string;

    @Column("text", { nullable: true })
    remediationRequired?: string;

    @Column({
        type: "simple-enum",
        enum: EnforcementStatus,
        default: EnforcementStatus.OPEN
    })
    status!: EnforcementStatus;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
