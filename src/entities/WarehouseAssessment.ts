import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { Application } from "./Application";

// Outcome of a completed warehouse assessment, chosen by the inspector at
// submission time. PASS_WITH_CONDITIONS still lets the application move
// forward to Technical verification (with the conditions recorded in
// `notes`), matching the spec's three-way inspection result.
export enum WarehouseAssessmentOutcome {
    PASS = "PASS",
    PASS_WITH_CONDITIONS = "PASS_WITH_CONDITIONS",
    FAIL = "FAIL",
}

/**
 * One row per inspection cycle for a given Application. Deliberately a
 * separate, proper typed entity — NOT the existing farm-mapping-adjacent
 * `Inspection` entity (which is ManyToOne(Farm)/ManyToOne(Shipment) and is
 * out of scope here per the standing "farm-mapping integration is OUT OF
 * SCOPE" instruction) and NOT folded into Application.data (which is
 * reserved for the applicant-submitted JSON blob and is read-only after
 * submission per Application.ts's docblock).
 *
 * `versionNumber` starts at 1 and is bumped by
 * ApplicationController.requireReinspection() whenever Technical Services
 * sends the application back for a re-inspection loop
 * (WAREHOUSE_REINSPECTION_REQUIRED) — a new WarehouseAssessment row is
 * created for each cycle rather than overwriting the previous one, so the
 * full inspection history for an application is preserved for audit.
 */
@Entity()
export class WarehouseAssessment {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => Application, { onDelete: "CASCADE" })
    @JoinColumn({ name: "applicationId" })
    application!: Application;

    @Column()
    applicationId!: string;

    @Column({ default: 1 })
    versionNumber!: number;

    @Column({ nullable: true })
    inspectorId!: string;

    @Column({ nullable: true })
    inspectorName!: string;

    @Column({ nullable: true })
    assignedByUserId!: string;

    @Column({ nullable: true })
    assignedByName!: string;

    @Column({ type: "timestamp", nullable: true })
    scheduledDate!: Date;

    @Column({ type: "timestamp", nullable: true })
    startedAt!: Date;

    @Column({ type: "timestamp", nullable: true })
    submittedAt!: Date;

    @Column({ type: "simple-enum", enum: WarehouseAssessmentOutcome, nullable: true })
    outcome!: WarehouseAssessmentOutcome;

    // Free-form checklist answers captured by the inspector's assessment
    // form (e.g. structural condition, pest control, storage capacity,
    // fire safety, ventilation) — kept as jsonb since the exact checklist
    // fields are a UI/content concern, not a schema concern.
    @Column({ type: "jsonb", nullable: true })
    checklistData!: any;

    @Column({ type: "text", nullable: true })
    notes!: string;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
