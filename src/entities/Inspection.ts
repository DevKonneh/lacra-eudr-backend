import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { User } from "./User";
import { Farm } from "./Farm";
import { Shipment } from "./Shipment";

export enum InspectionType {
    FARM_VISIT = "FARM_VISIT",
    SHIPMENT_CHECK = "SHIPMENT_CHECK",
    FACILITY_AUDIT = "FACILITY_AUDIT"
}

export enum InspectionStatus {
    SCHEDULED = "SCHEDULED",
    IN_PROGRESS = "IN_PROGRESS",
    COMPLETED = "COMPLETED",
    CANCELLED = "CANCELLED"
}

export enum InspectionResult {
    PENDING = "PENDING",
    PASSED = "PASSED",
    PASSED_WITH_CONDITIONS = "PASSED_WITH_CONDITIONS",
    FAILED = "FAILED"
}

@Entity()
export class Inspection {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({
        type: "simple-enum",
        enum: InspectionType
    })
    type!: InspectionType;

    // Polymorphic-like links (nullable)
    @ManyToOne(() => Farm, { nullable: true })
    farm?: Farm;

    @ManyToOne(() => Shipment, { nullable: true })
    shipment?: Shipment;

    @ManyToOne(() => User)
    @JoinColumn()
    inspector!: User;

    @Column()
    scheduledDate!: Date;

    @Column({ nullable: true })
    completedDate?: Date;

    @Column({
        type: "simple-enum",
        enum: InspectionStatus,
        default: InspectionStatus.SCHEDULED
    })
    status!: InspectionStatus;

    @Column({
        type: "simple-enum",
        enum: InspectionResult,
        default: InspectionResult.PENDING
    })
    result!: InspectionResult;

    @Column("text", { nullable: true })
    notes?: string;

    @Column("simple-json", { nullable: true })
    checklistData?: any;

    @Column("simple-array", { nullable: true })
    attachments?: string[];

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
