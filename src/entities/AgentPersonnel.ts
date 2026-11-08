import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { Certificate } from "./Certificate";

export enum AgentPersonnelRole {
    AGENT = "AGENT",
    CLERK = "CLERK",
}

export enum AgentPersonnelStatus {
    ACTIVE = "ACTIVE",
    INACTIVE = "INACTIVE",
    // Set when a person is replaced by a new appointee in the same slot —
    // kept distinct from INACTIVE (voluntary/administrative deactivation)
    // so the Agency profile's history can say "Replaced by X" rather than
    // a bare "Deactivated".
    REPLACED = "REPLACED",
}

/**
 * AgentPersonnel — one record per Agent or Clerk staffed at an Agency.
 *
 * Modeled as its own entity (not folded into Application.data like the
 * draft-stage PersonnelRecord[] the application wizard collects) because
 * the spec requires each person to have:
 *   - a unique, independently queryable internal record
 *   - their own QR / verification link (Agents only — see below)
 *   - appointment / replacement / deactivation history
 *   - a live link back to their parent Agency's Certificate row
 *
 * Every Agent record carries the SAME permitNumber as its parent Agency's
 * Certificate.certificateNumber (or stagedPermitNumber for a held/
 * conflicted Agency) — this is a deliberate denormalised snapshot, not a
 * live join, because the person must keep showing the number they were
 * actually issued under even if the Agency's own number is later
 * corrected during conflict resolution (the new number would then be
 * copied forward onto currently-ACTIVE agents by the resolution action,
 * not silently inherited through a join).
 *
 * A Clerk has no permitNumber and no public verification token — the
 * spec only asks for "the Agency its own QR and each authorized Agent a
 * separate QR"; a Clerk is internal staffing only, displayed on the
 * Agency profile's dedicated Clerk section but not publicly scannable.
 */
@Entity()
export class AgentPersonnel {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    // Parent Agency's own Certificate row (permitOrLicenceType === "AGENCY").
    // Nullable: historical import leaves a handful of people genuinely
    // unassigned (no candidateAgencySourceRecordId in the source data, or
    // one of the five people excluded from the Local Produce Buyer import
    // pending LACRA confirmation of their Agency) — these rows exist so
    // staff can find and link them later, but are never auto-linked.
    @ManyToOne(() => Certificate, { nullable: true, onDelete: "SET NULL" })
    @JoinColumn({ name: "agencyCertificateId" })
    agencyCertificate!: Certificate | null;

    @Column({ type: "varchar", nullable: true })
    agencyCertificateId!: string | null;

    @Column({ type: "simple-enum", enum: AgentPersonnelRole })
    role!: AgentPersonnelRole;

    @Column()
    fullName!: string;

    // Agent: always equal to the parent Agency's issued permit number at
    // the time of appointment (see class doc comment). Clerk: always null
    // — a Clerk has no permit number, per spec ("The Clerk has a separate
    // role on the Agency profile").
    @Column({ type: "varchar", nullable: true })
    permitNumber!: string | null;

    @Column({ type: "varchar", nullable: true })
    county!: string | null;

    @Column({ type: "varchar", nullable: true })
    nationalId!: string | null;

    @Column({ type: "varchar", nullable: true })
    phone!: string | null;

    // This person's own photo (Cloudinary secure_url), set via
    // POST /api/agencies/:agencyId/personnel/:personnelId/photo. Set for
    // either role (Agent or Clerk) — a Clerk still has no public
    // verification page, but their photo is useful on the internal Agency
    // profile roster view. Shown on the admin Agency profile's
    // Agents/Clerk tables and, for Agents only, on the public Agent
    // verification page (PermitVerificationService.toPublicAgentView()).
    @Column({ type: "varchar", nullable: true })
    photoUrl!: string | null;

    @Column({ type: "simple-enum", enum: AgentPersonnelStatus, default: AgentPersonnelStatus.ACTIVE })
    status!: AgentPersonnelStatus;

    @Column({ type: "timestamp", nullable: true })
    appointedAt!: Date | null;

    @Column({ type: "timestamp", nullable: true })
    deactivatedAt!: Date | null;

    @Column({ type: "text", nullable: true })
    deactivationReason!: string | null;

    // Opaque per-person verification token (Agents only — see class doc
    // comment). Distinct per person even when several Agents share the
    // same permitNumber, so a scanner can always resolve to the specific
    // individual. Null for every Clerk record.
    @Column({ type: "varchar", unique: true, nullable: true })
    verificationToken!: string | null;

    // Mirrors Certificate.isPubliclyBlocked: true while this person's
    // record (or their parent Agency's identity) is held pending staff
    // review — e.g. every Agent historically recorded under the
    // permit-030 / permit-041 Agency-name conflicts. A blocked Agent's
    // QR must not resolve publicly until cleared, exactly like a blocked
    // Agency certificate.
    @Column({ default: false })
    isPubliclyBlocked!: boolean;

    @Column({ type: "text", nullable: true })
    publicBlockReason!: string | null;

    // True for a historical-import row whose source record never named a
    // candidate parent Agency (agencyCertificateId stays null) — kept as
    // its own flag distinct from "agencyCertificateId IS NULL" so a
    // record can be queried even before any UI linking action exists for
    // it, and so it's unambiguous that this is a known, intentionally-
    // unassigned import (not a data-entry oversight).
    @Column({ default: false })
    requiresAgencyConfirmation!: boolean;

    // Append-only appointment / replacement / deactivation log. Each
    // entry: { action, date (ISO), note, performedByName }. Kept as a
    // simple JSONB array on the row itself (rather than a separate
    // history table) because every entry is scoped to exactly this one
    // person and nothing else in the system ever needs to query across
    // people's histories independently of the person record — the same
    // reasoning ApplicationStatusHistory.comments already uses for
    // free-text audit detail, just scoped one level lower.
    @Column({ type: "jsonb", default: () => "'[]'" })
    historyLog!: Array<{ action: string; date: string; note?: string; performedByName?: string }>;

    // Stable natural key from the historical reconciliation package
    // (agency_register.json's historicalPersonnel[].sourceRecordId, e.g.
    // "LACRA-AGENT-HIST-003") — the idempotency key the import service
    // matches against on every re-run. Null for any person appointed
    // through the live application/profile workflow.
    @Column({ type: "varchar", unique: true, nullable: true })
    sourceRecordId!: string | null;

    @Column({ default: false })
    isHistoricalImport!: boolean;

    @Column({ type: "jsonb", nullable: true })
    importRawData!: Record<string, any> | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
