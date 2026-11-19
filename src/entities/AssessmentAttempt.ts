import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { Farm } from "./Farm";

/**
 * A record of an assessment run that did NOT produce a verified result.
 *
 * Why this exists: previously a failed or unconfigured Open Foris Whisp call
 * silently fell through to a name-based fake, and RiskService still wrote a
 * normal-looking RiskAssessment row plus stamped `farm.riskLevel` /
 * `farm.lastRiskAssessmentDate`. A failure was therefore indistinguishable
 * from a real verdict in the UI and in every report.
 *
 * This entity is the opposite of that: it stores ONLY the fact that an attempt
 * happened and why it failed. It deliberately has NO risk-level, boolean
 * mitigating-factor or overlap columns, so nothing downstream can ever read a
 * failed attempt as a compliance result. Staff can list these to see exactly
 * which farms are currently unassessed and retry them.
 *
 * This table is append-only from the application's perspective; rows are never
 * updated to "become" a success. A later successful run creates a separate
 * RiskAssessment row.
 */
@Entity()
export class AssessmentAttempt {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => Farm, { nullable: true, onDelete: "CASCADE" })
    @JoinColumn()
    farm?: Farm;

    @Column({ nullable: true })
    farmId?: string;

    /** Denormalised at write time so the attempt stays readable if the farm is later renamed/deleted. */
    @Column({ nullable: true })
    farmNameSnapshot?: string;

    @CreateDateColumn()
    attemptedAt!: Date;

    /** Always "failed" today; a string (not an enum) so future non-verdict outcomes can be added safely. */
    @Column({ default: "failed" })
    outcome!: string;

    /** WhispFailureCode from WhispService: not_configured / auth_failed / timeout / ... */
    @Column({ nullable: true })
    failureCode?: string;

    /** Operator-facing explanation. Safe to display; contains no secrets. */
    @Column({ type: "text" })
    message!: string;

    @Column({ nullable: true })
    httpStatus?: number;

    @Column({ default: false })
    retryable!: boolean;

    /** Server-side diagnostic detail (upstream code/message). Never contains the API key. */
    @Column("jsonb", { nullable: true })
    detail?: Record<string, any>;
}
