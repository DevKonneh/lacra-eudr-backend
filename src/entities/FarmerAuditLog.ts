import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from "typeorm";
import { Farmer } from "./Farmer";

// Immutable audit trail for the "Add Farm to Existing Farmer" workflow.
// Per the spec: "Record all changes in an audit log" whenever an
// enumerator updates a returning farmer's permitted contact information
// (or adds a new farm) instead of re-collecting/duplicating their full
// personal profile. One row per field changed (or one summary row for
// "farm added"), so the history is granular and reviewable — mirrors the
// ApplicationStatusHistory audit pattern already used elsewhere in this
// codebase (immutable rows, never edited/deleted).
export enum FarmerAuditAction {
    CONTACT_UPDATED = "CONTACT_UPDATED",
    FARM_ADDED = "FARM_ADDED",
    IDENTITY_CONFIRMED = "IDENTITY_CONFIRMED",
    // Added for the multi-commodity-per-farm feature: logged whenever a
    // commodity is added, updated or deactivated on one of this farmer's
    // farms, so the "add/update/deactivate without deleting the farm"
    // requirement has a reviewable history, mirroring the existing
    // FARM_ADDED pattern.
    COMMODITY_ADDED = "COMMODITY_ADDED",
    COMMODITY_UPDATED = "COMMODITY_UPDATED",
    COMMODITY_DEACTIVATED = "COMMODITY_DEACTIVATED",
}

@Entity()
export class FarmerAuditLog {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => Farmer, { onDelete: "CASCADE" })
    @JoinColumn({ name: "farmerId" })
    farmer!: Farmer;

    @Column()
    farmerId!: string;

    @Column({ type: "enum", enum: FarmerAuditAction })
    action!: FarmerAuditAction;

    // For CONTACT_UPDATED: which field changed (e.g. "phoneNumber").
    @Column({ nullable: true })
    fieldName!: string;

    @Column({ type: "text", nullable: true })
    previousValue!: string;

    @Column({ type: "text", nullable: true })
    newValue!: string;

    // For FARM_ADDED: which farm this row documents.
    @Column({ nullable: true })
    farmId!: string;

    @Column({ nullable: true })
    performedByUserId!: string;

    @Column({ nullable: true })
    performedByName!: string;

    @Column({ type: "text", nullable: true })
    notes!: string;

    @CreateDateColumn()
    createdAt!: Date;
}
