import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

/**
 * ComplianceAction — immutable audit log of every enforcement action taken
 * against a Certificate (Agency or Local Produce Buyer permit) or an
 * individual AgentPersonnel record: Warning, Fine, Suspension, Revocation,
 * and Reinstatement.
 *
 * Deliberately a SEPARATE, append-only table (never updated/deleted) rather
 * than overloading Application.status alone, because:
 *   - staff need to see the FULL history of actions taken against a permit
 *     (e.g. two prior warnings before an eventual suspension), not just the
 *     single current status;
 *   - a FINE never changes the certificate's live status at all (a fined
 *     Agency/Buyer can remain fully VALID while still owing a fine) but
 *     must still be recorded with its amount and reason;
 *   - every action requires a staff-entered reason, mirroring the existing
 *     ApplicationStatusHistory pattern ("every approval/return/rejection
 *     needs an audit record with reason") — this entity is the Agency/
 *     Local-Produce-Buyer-register equivalent of that audit trail.
 *
 * SUSPEND and REVOKE additionally update the underlying Application's
 * `status` column to SUSPENDED/REVOKED (see ComplianceActionService),
 * which is what PermitVerificationService.computePublicStatus() already
 * checks FIRST (ahead of the normal issued/expired timeline) — so a
 * suspended/revoked permit immediately shows that status on every public
 * QR scan and on the register, with no separate "status" column needed
 * here. WARNING and FINE never touch Application.status. REINSTATE reverts
 * a SUSPENDED Application back to ISSUED (a REVOKED permit cannot be
 * reinstated — revocation is final, matching real-world regulatory
 * practice; a brand-new permit would need to be issued instead).
 */
export enum ComplianceActionType {
    WARNING = "WARNING",
    FINE = "FINE",
    SUSPEND = "SUSPEND",
    REVOKE = "REVOKE",
    REINSTATE = "REINSTATE",
}

// Which kind of record this action was taken against — a Certificate
// (Agency or Local Produce Buyer permit) or an individual AgentPersonnel
// row (an Agent can be individually warned/fined/suspended/revoked without
// necessarily taking action against their whole parent Agency).
export enum ComplianceSubjectType {
    CERTIFICATE = "CERTIFICATE",
    AGENT_PERSONNEL = "AGENT_PERSONNEL",
}

@Entity()
export class ComplianceAction {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ type: "simple-enum", enum: ComplianceSubjectType })
    subjectType!: ComplianceSubjectType;

    // Certificate.id or AgentPersonnel.id depending on subjectType. Not a
    // FK/relation on purpose — mirrors ApplicationStatusHistory's own
    // plain applicationId column, and lets this one table serve both
    // subject kinds without two near-identical entities.
    @Column()
    subjectId!: string;

    // Denormalised snapshot of the subject's display name and permit
    // number AT THE TIME of this action, so the audit trail still reads
    // correctly even if the subject's own name/number is later corrected
    // (e.g. during an Agency-name conflict resolution) — exactly the same
    // snapshot reasoning Certificate.buyerDisplayName itself already uses.
    @Column({ type: "varchar", nullable: true })
    subjectName!: string | null;

    @Column({ type: "varchar", nullable: true })
    subjectPermitNumber!: string | null;

    @Column({ type: "simple-enum", enum: ComplianceActionType })
    actionType!: ComplianceActionType;

    // Mandatory for every action type — enforced in the controller, not
    // just here, so the API rejects a missing reason before anything is
    // written. "Why you are taking such action", per spec.
    @Column({ type: "text" })
    reason!: string;

    // Only ever populated for actionType === FINE. Stored as a plain
    // numeric amount in the fixed currency below (LRD — Liberian Dollar,
    // LACRA's own operating currency) rather than letting staff pick a
    // currency per fine, so register totals stay meaningfully summable.
    @Column({ type: "numeric", precision: 12, scale: 2, nullable: true })
    fineAmount!: number | null;

    @Column({ type: "varchar", nullable: true, default: "LRD" })
    fineCurrency!: string | null;

    // True once a FINE has been marked as paid by staff (separate action,
    // see ComplianceActionController.markFinePaid) — a fine is recorded
    // immediately on issuance but its payment is tracked independently,
    // since the two can happen at very different times.
    @Column({ default: false })
    finePaid!: boolean;

    @Column({ type: "timestamp", nullable: true })
    finePaidAt!: Date | null;

    @Column({ nullable: true })
    performedByUserId!: string;

    @Column({ nullable: true })
    performedByName!: string;

    // For SUSPEND/REVOKE/REINSTATE: snapshot of the Application.status
    // transition this action caused, so the audit entry is self-contained
    // even if the Application row is inspected separately later.
    @Column({ nullable: true })
    previousStatus!: string;

    @Column({ nullable: true })
    newStatus!: string;

    @CreateDateColumn()
    createdAt!: Date;
}
