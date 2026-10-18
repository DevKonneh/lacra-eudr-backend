import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { Application } from "./Application";

/**
 * Immutable audit trail row for one application. Per the CMIS extension
 * spec: "every approval/return/rejection/verification needs an audit
 * record with reason" and "no ordinary user can delete audit records" —
 * this entity has no update()/delete() exposed anywhere in the API
 * surface (see application.routes.ts), only INSERT via
 * ApplicationController.recordHistory(), which every stage of the
 * workflow (added across later phases) will call on every transition.
 */
@Entity()
export class ApplicationStatusHistory {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => Application, { onDelete: "CASCADE" })
    @JoinColumn({ name: "applicationId" })
    application!: Application;

    @Column()
    applicationId!: string;

    // e.g. "SUBMITTED", "COMMERCIAL_VERIFIED", "RETURNED_TO_COMMERCIAL",
    // "DG_COMMERCIAL_APPROVAL", "DG_REJECTED" — a short, human-readable
    // action label distinct from (but usually paired with) the status
    // enum values, since some actions (e.g. "Save progress") don't
    // themselves change status.
    @Column()
    action!: string;

    @Column({ nullable: true })
    previousStatus!: string;

    @Column({ nullable: true })
    newStatus!: string;

    @Column({ nullable: true })
    userId!: string;

    @Column({ nullable: true })
    userName!: string;

    @Column({ nullable: true })
    role!: string;

    @Column({ nullable: true })
    department!: string;

    @Column({ type: "text", nullable: true })
    comments!: string;

    // Populated whenever the action is a Return/Reject/Hold/Reprint —
    // the spec requires a mandatory reason for all four of these.
    @Column({ type: "text", nullable: true })
    reason!: string;

    @Column({ nullable: true })
    ipAddress!: string;

    @Column({ nullable: true })
    deviceInfo!: string;

    // Bumped whenever this action is associated with a new
    // ApplicationVersion (created on correction resubmission) — added in
    // a later phase; defaults to 1 for every action in this phase.
    @Column({ default: 1 })
    versionNumber!: number;

    @CreateDateColumn()
    createdAt!: Date;
}
