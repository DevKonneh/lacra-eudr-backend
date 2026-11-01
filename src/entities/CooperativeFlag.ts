import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn, UpdateDateColumn } from "typeorm";
import { Cooperative } from "./Cooperative";

/**
 * Staff-only data-quality flag against a Cooperative record — "suspected
 * duplicate", "missing information", or "possible commodity
 * inconsistency" per the Cooperative Registry spec.
 *
 * Deliberately NOT an automatic merge/correction mechanism: flags are
 * raised (by a rule-based scan or manually by staff), reviewed by an
 * authorised user, and the reviewer records an outcome (e.g. "confirmed
 * duplicate — see cooperative X", "not a duplicate, different county",
 * "corrected address", "no action needed"). The underlying Cooperative
 * record is never silently merged or altered by this mechanism — any
 * actual correction a reviewer makes is a separate, explicit
 * CooperativeController#correct call, logged in CooperativeChangeLog.
 */
export enum CooperativeFlagType {
    SUSPECTED_DUPLICATE = "SUSPECTED_DUPLICATE",
    MISSING_INFORMATION = "MISSING_INFORMATION",
    COMMODITY_INCONSISTENCY = "COMMODITY_INCONSISTENCY",
}

export enum CooperativeFlagStatus {
    OPEN = "OPEN",
    REVIEWED = "REVIEWED",
}

@Entity()
export class CooperativeFlag {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => Cooperative, { onDelete: "CASCADE" })
    @JoinColumn({ name: "cooperativeId" })
    cooperative!: Cooperative;

    @Column()
    cooperativeId!: string;

    @Column({ type: "enum", enum: CooperativeFlagType })
    type!: CooperativeFlagType;

    // Human-readable explanation of WHY this was flagged — e.g. "Name is
    // 92% similar to 'BOE-KPAR COCOA FARMERS' COOPERATIVE SOCIETY' (Nimba)"
    // for a duplicate, or "No membership figure on file" for missing
    // information. Always populated so staff reviewing the flag
    // understand the reasoning without re-deriving it themselves.
    @Column({ type: "text" })
    reason!: string;

    // For SUSPECTED_DUPLICATE: the other cooperative this one was matched
    // against, so the reviewer can open both side by side.
    @Column({ nullable: true })
    relatedCooperativeId!: string | null;

    @Column({ type: "enum", enum: CooperativeFlagStatus, default: CooperativeFlagStatus.OPEN })
    status!: CooperativeFlagStatus;

    // Who/when raised it — null createdByUserId means it was raised by
    // the automated similarity/completeness scan rather than a person.
    @Column({ nullable: true })
    createdByUserId!: string | null;

    @Column({ nullable: true })
    createdByName!: string | null;

    // Review outcome — populated only once an authorised staff member
    // resolves the flag. Kept as free text (not an enum) since the range
    // of real outcomes ("merged manually outside the system", "contacted
    // CDA for clarification", "confirmed correct as-is", etc.) is broader
    // than a fixed set of codes would usefully capture.
    @Column({ type: "text", nullable: true })
    reviewOutcome!: string | null;

    @Column({ nullable: true })
    reviewedByUserId!: string | null;

    @Column({ nullable: true })
    reviewedByName!: string | null;

    @Column({ type: "timestamp", nullable: true })
    reviewedAt!: Date | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
