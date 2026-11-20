import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn, JoinColumn } from "typeorm";
import { Farm } from "./Farm";
import { Plot } from "./Plot";

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

    // ─── Per-plot attribution (automatic assessment) ────────────────────────
    //
    // A farm can hold several plots, each with its own polygon. A verdict
    // describes ONE parcel, so it must be attached to the plot it actually
    // assessed — not just to the farm. Without this, two plots on one farm
    // could not be told apart in history and a corrected subplot could appear
    // to invalidate its neighbour's result.
    //
    // Nullable: legacy farm-level rows (assessed before per-plot assessment
    // existed) genuinely describe the whole farm boundary and have no plot.
    @ManyToOne(() => Plot, { nullable: true, onDelete: "SET NULL" })
    @JoinColumn()
    plot?: Plot | null;

    @Column({ nullable: true })
    plotId?: string | null;

    /**
     * sha256 of the canonical polygon this verdict was produced from
     * (see services/GeometryVersioning.ts).
     *
     * Used at read time to prove the verdict describes the polygon currently
     * on the plot. If it does not match, the row is historical evidence only.
     */
    @Column({ type: "varchar", nullable: true })
    geometryHash?: string | null;

    /** Boundary version this verdict assessed, for display ("assessed v2"). */
    @Column({ type: "int", nullable: true })
    geometryVersion?: number | null;

    /**
     * TRUE when the plot's polygon was corrected while this assessment was
     * already running, so this verdict describes a boundary that is no longer
     * current.
     *
     * The row is DELIBERATELY KEPT (never deleted): it is the record of what
     * the satellite said about that shape, which is exactly what due diligence
     * needs. It is merely excluded from being the plot's current rating.
     */
    @Column({ type: "boolean", default: false })
    supersededByGeometryChange!: boolean;

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
