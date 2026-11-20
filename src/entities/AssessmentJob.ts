import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index } from "typeorm";
import { Farm } from "./Farm";
import { Plot } from "./Plot";

/**
 * A queued/executing automatic satellite (Open Foris Whisp) assessment for ONE
 * plot polygon.
 *
 * WHY THIS EXISTS
 * ---------------
 * Assessments used to be triggered only when a member of staff clicked
 * "Assess". That meant a synced farm could sit indefinitely with no satellite
 * evidence, and the compliance screens had nothing to show for it.
 *
 * This table is the durable queue behind automatic assessment. It exists as a
 * ROW rather than an in-memory promise for three reasons:
 *
 *   1. A sync must never wait on Whisp. Enqueueing is one INSERT; the actual
 *      call happens later, in the background.
 *   2. A retried sync must not create a second assessment. The unique index on
 *      `dedupeKey` (= plotId + geometry hash) makes that a database guarantee
 *      rather than an application-level check that can race.
 *   3. A job must survive a restart. Queued rows are picked back up by the
 *      worker, so a deploy in the middle of a sync loses nothing.
 *
 * STATUS MEANINGS (staff-facing, see the admin panel):
 *   'queued'           -> waiting to run (includes waiting out a retry backoff)
 *   'assessing'        -> Whisp call in flight
 *   'completed'        -> a verified result was stored for THIS polygon
 *   'failed'           -> gave up (permanent error, or retries exhausted)
 *   'boundary_review'  -> not sent to Whisp: the polygon is missing, invalid,
 *                         or was generated from a GPS point. Nothing was
 *                         assessed, and staff see why.
 *
 * A row is never edited to "become" a result: the verdict lives in
 * RiskAssessment, and `assessmentId` points at it. This table only tracks the
 * attempt's lifecycle.
 */
@Entity()
export class AssessmentJob {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => Plot, { nullable: true, onDelete: "CASCADE" })
    @JoinColumn()
    plot?: Plot;

    /**
     * Nullable only so a job row survives its plot's deletion without taking the
     * audit trail with it. Every job created by the application has a plotId.
     */
    @Column({ nullable: true })
    plotId?: string;

    @ManyToOne(() => Farm, { nullable: true, onDelete: "CASCADE" })
    @JoinColumn()
    farm?: Farm;

    @Column({ nullable: true })
    farmId?: string;

    /** Denormalised so the queue stays readable if the plot is later renamed. */
    @Column({ nullable: true })
    plotNameSnapshot?: string;

    /**
     * sha256 of the canonicalised polygon this job assesses.
     *
     * This is the linchpin of the "boundary changed mid-flight" rule: when the
     * job finishes, the result is only allowed to become the plot's CURRENT
     * rating if the plot's geometry still hashes to this value. Otherwise the
     * verdict is kept in history but marked superseded.
     */
    @Column({ type: "varchar", nullable: true })
    geometryHash?: string | null;

    /** Human-facing counter: "boundary version 3". Bumped only on real edits. */
    @Column({ type: "int", default: 0 })
    geometryVersion!: number;

    /**
     * Unique per (plot, polygon). A retried sync of an unchanged boundary
     * therefore collides with the existing row instead of creating a duplicate.
     */
    @Index({ unique: true })
    @Column({ type: "varchar" })
    dedupeKey!: string;

    @Column({ type: "varchar", default: "queued" })
    status!: string;

    /** How many execution attempts have been made (not counting enqueue). */
    @Column({ type: "int", default: 0 })
    attempts!: number;

    /** Earliest time the worker may pick this job up. Drives retry backoff. */
    @Column({ type: "timestamp", nullable: true })
    nextAttemptAt?: Date | null;

    /** Machine-readable failure code from WhispService (timeout, auth_failed, ...). */
    @Column({ type: "varchar", nullable: true })
    failureCode?: string | null;

    /** Operator-facing message. Safe to display; contains no secrets. */
    @Column({ type: "text", nullable: true })
    lastError?: string | null;

    /** Whether the last failure is worth retrying automatically. */
    @Column({ type: "boolean", default: false })
    retryable!: boolean;

    /** Why a job was parked in 'boundary_review' rather than assessed. */
    @Column({ type: "text", nullable: true })
    boundaryReviewReason?: string | null;

    /** The RiskAssessment row produced by a successful run, if any. */
    @Column({ type: "varchar", nullable: true })
    assessmentId?: string | null;

    @Column({ type: "timestamp", nullable: true })
    startedAt?: Date | null;

    @Column({ type: "timestamp", nullable: true })
    finishedAt?: Date | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
