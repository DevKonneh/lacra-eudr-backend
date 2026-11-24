import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
    CreateDateColumn,
    Index,
} from "typeorm";
import { Farm } from "./Farm";
import { Plot } from "./Plot";
import { RiskAssessment } from "./RiskAssessment";
import { User } from "./User";

/**
 * A human EUDR review decision recorded against ONE plot.
 *
 * WHY THIS TABLE EXISTS
 * ---------------------
 * WhISP is a satellite service. It can say "disturbance detected after 2020" or
 * "more_info_needed", but it cannot know whether that parcel was legally
 * converted, whether the farmer holds title, or whether an inspector visited and
 * found the land was already cleared before the cutoff. Those are human
 * judgements, and the six EUDR statuses require them:
 *
 *   - "Needs Review" means a reviewer must record evidence and RESOLVE the
 *     finding before clearance.
 *   - "Non-Compliant" means an AUTHORISED review confirmed post-2020 conversion
 *     or a Liberian legal violation.
 *
 * Before this table there was nowhere to put that judgement. The only stored
 * truth was WhISP's own verdict plus boolean legality/traceability flags derived
 * from documents, so "resolved by a human" could not be represented at all —
 * and inventing it at read time would have meant the panel asserting a decision
 * nobody actually made.
 *
 * THE THREE RULES THIS TABLE ENFORCES
 * -----------------------------------
 *  1. THE WHISP RESULT IS NEVER REPLACED. `riskAssessmentId` points AT the
 *     assessment that was reviewed, so the original satellite evidence stays
 *     intact and the decision is clearly a separate, attributable act. A review
 *     never edits or deletes a RiskAssessment.
 *
 *  2. A REVIEW IS BOUND TO A SPECIFIC POLYGON. `geometryHash` /
 *     `geometryVersion` record the boundary that was reviewed. If the boundary
 *     later changes, the review no longer describes the parcel on the map, so it
 *     cannot restore clearance — a fresh assessment and a fresh decision are
 *     required. (See EudrStatusService.isCurrentReview.)
 *
 *  3. ONLY AN AUTHORISED DECISION CLEARS OR CONDEMNS. `isFinal` distinguishes a
 *     recommendation (an inspector's evidence and suggested outcome) from a
 *     decision (a holder of the EUDR review permission). Non-final rows are
 *     recorded and shown, but they never change a plot's status.
 */
@Entity()
@Index(["plotId", "createdAt"])
export class PlotEudrReview {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => Plot, { onDelete: "CASCADE" })
    @JoinColumn()
    plot!: Plot;

    @Column()
    plotId!: string;

    @ManyToOne(() => Farm, { onDelete: "CASCADE" })
    @JoinColumn()
    farm!: Farm;

    @Column()
    farmId!: string;

    /**
     * The specific WhISP assessment this decision is about.
     *
     * Nullable so a review can still be recorded when the satellite result is
     * missing or failed (e.g. a legal-violation decision, or a reviewer
     * documenting why a plot cannot be assessed). It is NOT nullable as a
     * signal that "no assessment was considered" — `evidence` explains the gap.
     */
    @ManyToOne(() => RiskAssessment, { nullable: true, onDelete: "SET NULL" })
    @JoinColumn()
    riskAssessment?: RiskAssessment | null;

    @Column({ type: "varchar", nullable: true })
    riskAssessmentId?: string | null;

    /**
     * sha256 of the polygon that was reviewed. Compared against the plot's
     * CURRENT hash at read time; a mismatch makes this review historical only.
     */
    @Column({ type: "varchar", nullable: true })
    geometryHash?: string | null;

    /** Boundary version reviewed ("this decision describes v2"). */
    @Column({ type: "int", nullable: true })
    geometryVersion?: number | null;

    /**
     * The outcome the reviewer decided.
     *
     * Allowed values (varchar rather than a native Postgres enum so a future
     * outcome does not require an ALTER TYPE on a live table):
     *   'cleared'       - the finding is resolved; the plot may proceed.
     *   'non_compliant' - conversion or a legal violation is confirmed.
     *   'needs_review'  - the reviewer could not resolve it; keep clearance held.
     */
    @Column({ type: "varchar" })
    decision!: string;

    /**
     * TRUE only for a decision by a holder of the EUDR review permission.
     *
     * A recommendation (inspector evidence + suggested outcome) is stored with
     * isFinal = false: it is visible to staff and preserved as evidence, but it
     * cannot change a plot's status on its own.
     */
    @Column({ type: "boolean", default: false })
    isFinal!: boolean;

    /** Plain-language justification. REQUIRED for 'non_compliant'. */
    @Column({ type: "text" })
    reason!: string;

    /**
     * Supporting evidence supplied with the decision: document references,
     * photo URLs, inspection IDs, field notes, or an explicit statement of what
     * was checked. Free-form by design — the reviewer, not the schema, knows what
     * evidence applies to a given parcel.
     */
    @Column({ type: "jsonb", nullable: true })
    evidence?: any;

    @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
    @JoinColumn()
    reviewedBy?: User | null;

    @Column({ type: "varchar", nullable: true })
    reviewedByUserId?: string | null;

    /** Denormalised so the audit trail stays readable if the account is deleted. */
    @Column({ type: "varchar", nullable: true })
    reviewedByName?: string | null;

    /** The role the reviewer held at the moment of the decision. */
    @Column({ type: "varchar", nullable: true })
    reviewedByRole?: string | null;

    @CreateDateColumn()
    createdAt!: Date;
}

/** Allowed values for `decision`, mirrored in the API and the frontend. */
export const EudrDecision = {
    CLEARED: "cleared",
    NON_COMPLIANT: "non_compliant",
    NEEDS_REVIEW: "needs_review",
} as const;

export type EudrDecisionValue = typeof EudrDecision[keyof typeof EudrDecision];

export const EUDR_DECISION_VALUES: string[] = Object.values(EudrDecision);
