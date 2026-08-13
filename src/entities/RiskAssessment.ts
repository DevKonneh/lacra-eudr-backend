import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn } from "typeorm";
import { Farm } from "./Farm";

export enum RiskLevel {
    LOW = "Low",
    MEDIUM = "Medium",
    HIGH = "High"
}

export enum OverlapResult {
    NONE = "None",
    FARM = "Farm",
    FOREST = "Forest",
    PROTECTED_AREA = "Protected Area"
}

@Entity()
export class RiskAssessment {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => Farm)
    farm!: Farm;

    @Column()
    farmId!: string;

    @CreateDateColumn()
    createdAt!: Date;

    @Column()
    deforestationRisk!: boolean;

    @Column({
        type: "enum",
        enum: OverlapResult,
        default: OverlapResult.NONE
    })
    overlapResult!: OverlapResult;

    @Column()
    legalityRisk!: boolean;

    @Column()
    traceabilityRisk!: boolean;

    @Column({
        type: "enum",
        enum: RiskLevel
    })
    overallRisk!: RiskLevel;

    @Column({ nullable: true })
    whispAnalysisId!: string;

    @Column("jsonb", { nullable: true })
    whispData!: any;

    @Column("jsonb", { nullable: true })
    details!: any;
}
