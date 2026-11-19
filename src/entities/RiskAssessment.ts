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

    /**
     * Provenance of this assessment, so no one has to GUESS whether a stored
     * verdict came from the live satellite service:
     *   'whisp_live' -> completed Open Foris Whisp response (audit-grade).
     *   'mock'       -> fabricated result (should not exist post-fix; flagged).
     *   NULL         -> legacy row predating provenance tracking = UNVERIFIED.
     *
     * The audit rule is deliberately blunt: a row is only trustworthy when
     * source === 'whisp_live' AND whispVerified === true. Everything else
     * (including every legacy row) is treated as unverified and must be
     * reassessed before it can support a compliance statement.
     */
    @Column({ type: "varchar", nullable: true })
    source?: string | null;

    /**
     * TRUE only when Whisp returned a completed analysis with usable result
     * fields. Defaults to FALSE so pre-existing rows are conservatively treated
     * as unverified rather than silently trusted.
     */
    @Column({ type: "boolean", default: false })
    whispVerified!: boolean;

    /**
     * Set by the reassessment review job when this row's provenance cannot be
     * established. The ORIGINAL row is never mutated or deleted - flagging only
     * marks it for audit, preserving it for evidentiary purposes.
     */
    @Column({ type: "boolean", default: false })
    flaggedForReassessment!: boolean;

    @Column({ type: "varchar", nullable: true })
    flagReason?: string | null;
}
