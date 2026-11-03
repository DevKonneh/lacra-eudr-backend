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
    // NOTE: IDENTITY_CONFIRMED (legacy name, distinct from the Identity
    // Verification feature below) refers to the "Add Farm to Existing
    // Farmer" flow's identity-confirmation screen re-confirming/updating
    // contact details — it does NOT mean the farmer's identityStatus was
    // set to "Verified". Kept only so historical rows using this value
    // remain readable; new code should not emit it.
    IDENTITY_CONFIRMED = "IDENTITY_CONFIRMED",
    // Added for the multi-commodity-per-farm feature: logged whenever a
    // commodity is added, updated or deactivated on one of this farmer's
    // farms, so the "add/update/deactivate without deleting the farm"
    // requirement has a reviewable history, mirroring the existing
    // FARM_ADDED pattern.
    COMMODITY_ADDED = "COMMODITY_ADDED",
    COMMODITY_UPDATED = "COMMODITY_UPDATED",
    COMMODITY_DEACTIVATED = "COMMODITY_DEACTIVATED",
    // --- Identity Verification feature ---
    // One row per farmer per status change, recording who made the
    // decision, when (createdAt), the previous/new status (previousValue/
    // newValue on the "identityStatus" fieldName), and the reason (notes).
    // IDENTITY_VERIFIED: identityStatus set to "Verified".
    // IDENTITY_CONFLICT_FLAGGED: identityStatus set to "Conflict" — an
    //   unresolved issue (e.g. contradictory documents, suspected
    //   duplicate identity), NOT a final rejection of the farmer.
    // IDENTITY_REVERTED_TO_UNVERIFIED: either (a) an admin manually moved
    //   a Verified farmer back to Unverified (reason required), or (b) a
    //   previously-Verified farmer was automatically reverted to
    //   Unverified because one of the identity-defining fields changed
    //   (see IDENTITY_REVERIFICATION_FIELDS in FarmerController) — both
    //   cases record performedByUserId (whoever made the edit/decision);
    //   they're distinguished by the `notes` text ("Automatically
    //   reverted: ..." prefix for case (b)).
    IDENTITY_VERIFIED = "IDENTITY_VERIFIED",
    IDENTITY_CONFLICT_FLAGGED = "IDENTITY_CONFLICT_FLAGGED",
    IDENTITY_REVERTED_TO_UNVERIFIED = "IDENTITY_REVERTED_TO_UNVERIFIED",
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
