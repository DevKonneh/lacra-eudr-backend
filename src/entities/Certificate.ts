import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { Application } from "./Application";

/**
 * The final permit/licence certificate record for an Application — created
 * once (APPROVED_FOR_ISSUANCE -> AWAITING_IT_CERTIFICATE_PRINTING) and
 * updated through CERTIFICATE_PRINTED -> ISSUED. One-to-one with
 * Application in practice (an application only ever gets one certificate
 * per successful run through the workflow), but modeled as its own
 * ManyToOne-keyed entity for consistency with Invoice/PaymentSubmission
 * and to leave room for a future re-issuance/reprint scenario.
 *
 * `certificateNumber` is what the public QR-verification page
 * (added alongside this entity) looks up, and is embedded in the QR code
 * printed on the certificate PDF.
 */
@Entity()
export class Certificate {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => Application, { onDelete: "CASCADE" })
    @JoinColumn({ name: "applicationId" })
    application!: Application;

    @Column()
    applicationId!: string;

    // Format: LACRA-CERT-{year}-{6-digit sequence}, e.g. LACRA-CERT-2026-000001
    @Column({ unique: true, nullable: true })
    certificateNumber!: string;

    @Column({ nullable: true })
    permitOrLicenceType!: string;

    @Column({ type: "timestamp", nullable: true })
    issueDate!: Date;

    @Column({ type: "timestamp", nullable: true })
    expiryDate!: Date;

    @Column({ nullable: true })
    printedByUserId!: string;

    @Column({ nullable: true })
    printedByName!: string;

    @Column({ type: "timestamp", nullable: true })
    printedAt!: Date;

    @Column({ type: "timestamp", nullable: true })
    issuedAt!: Date;

    // Populated once a PDF-generation step is wired up (not part of this
    // phase's scope — printing here means "IT marks the certificate as
    // printed", not literal server-side PDF rendering); left nullable so
    // the certificate record and QR verification can exist without it.
    @Column({ nullable: true })
    documentUrl!: string;

    // -----------------------------------------------------------------
    // Local Produce Buyer Register + live QR verification support.
    // These columns are additive and are only ever populated for
    // permitOrLicenceType === "LOCAL_BUYER" certificates; every other
    // category leaves them null and is entirely unaffected.
    // -----------------------------------------------------------------

    // Opaque, unguessable per-issuance token embedded in the printed QR
    // code (pattern: GET /api/public/permits/verify/:token). Deliberately
    // distinct from certificateNumber (the human-readable permit number) —
    // scanning never has to reveal the real permit number to work, and a
    // renewal gets its own fresh token while the OLD certificate's token
    // keeps resolving to its own (now likely expired) record forever.
    @Column({ type: "varchar", unique: true, nullable: true })
    verificationToken!: string | null;

    // Snapshot fields for the register's table columns (Buyer Name,
    // County) and for the public verify page. Kept as plain snapshot
    // columns — not re-derived from Application.data on every read —
    // because the historical import has no Application-stage buyer
    // info to extract from (see sourceRecordId below), and a fixed
    // snapshot is also what should be shown even if a later correction
    // changes the underlying application record.
    @Column({ type: "varchar", nullable: true })
    buyerDisplayName!: string | null;

    @Column({ type: "varchar", nullable: true })
    county!: string | null;

    // Free-text locality within the county, used for register entries
    // whose source county value needed normalisation (e.g. "Zwedru (as
    // recorded)" -> county "Grand Gedeh", locality "Zwedru"). Null for
    // the common case where the recorded county needed no correction.
    @Column({ type: "varchar", nullable: true })
    locality!: string | null;

    // Self-referencing link to the certificate this one renews. The OLD
    // certificate's own verificationToken is never touched/revoked when a
    // renewal happens — both remain independently resolvable forever, per
    // spec. Only the NEW (renewal) certificate points backward; there is
    // no forward pointer on the old row (a certificate can only ever be
    // renewed once into a single successor in this model).
    @ManyToOne(() => Certificate, { nullable: true })
    @JoinColumn({ name: "predecessorCertificateId" })
    predecessorCertificate!: Certificate | null;

    @Column({ type: "varchar", nullable: true })
    predecessorCertificateId!: string | null;

    // Explicit, validated go-forward link from an Agent's (buyer's)
    // certificate to the Agency's own certificate — set only via the
    // dedicated link-to-agency admin action, never inferred/guessed. The
    // register displays a buyer with this set as an "Agent" under the
    // named agency rather than as an independent Local Produce Buyer.
    // Historical/legacy register rows import with this left null
    // ("unrecorded affiliation") per the decision to never guess agency
    // linkage retroactively.
    @ManyToOne(() => Certificate, { nullable: true })
    @JoinColumn({ name: "agencyCertificateId" })
    agencyCertificate!: Certificate | null;

    @Column({ type: "varchar", nullable: true })
    agencyCertificateId!: string | null;

    // True while this issuance's permit-number conflict (shared number
    // with another distinct buyer) or disputed-date flag has not yet been
    // resolved by staff. A blocked certificate's record is preserved in
    // full (nothing hidden/deleted) but BOTH the opaque-token verify
    // endpoint and the existing certificateNumber verify endpoint must
    // refuse to resolve it publicly until this is cleared.
    @Column({ default: false })
    isPubliclyBlocked!: boolean;

    // Human-readable reason shown to staff (never to the public) for why
    // isPubliclyBlocked is currently true, e.g. "Shared permit number
    // LACRA-260-2026 with Prosper G. Cooper — pending staff resolution."
    @Column({ type: "text", nullable: true })
    publicBlockReason!: string | null;

    // Holds the ORIGINAL permit number recorded in the source register for
    // a certificate that collided with another buyer's permit number
    // during import (certificateNumber has a UNIQUE constraint, so only
    // one certificate per shared-number group can actually hold that
    // value there). Staff resolving the conflict either re-assign a fresh
    // certificateNumber to this record or correct the other party's —
    // this field preserves exactly what the source register said for
    // audit purposes in the meantime, without ever violating the unique
    // constraint on certificateNumber. Null for every normal (non-
    // conflicting) certificate, where certificateNumber itself already
    // holds the correct value.
    @Column({ type: "varchar", nullable: true })
    stagedPermitNumber!: string | null;

    // Stable natural key from the imported register's own QR reference
    // (e.g. "LPB1:LACRA-194-2026:8D7C2870") — the idempotency key the
    // import service matches against on every re-run, so importing twice
    // never creates duplicate rows. Null for every non-imported
    // certificate (new issuances created through the normal workflow).
    @Column({ type: "varchar", unique: true, nullable: true })
    sourceRecordId!: string | null;

    // True for rows created by the historical register backfill rather
    // than by a live Application working its way through the DG-approval
    // workflow. Required so the register/UI can clearly distinguish a
    // real CMIS-approved issuance from a historical manual record being
    // backfilled for continuity — the import must never fabricate the
    // appearance of a workflow approval, payment, or DG sign-off that
    // never happened.
    @Column({ default: false })
    isHistoricalImport!: boolean;

    // Verbatim import-time audit data for historical rows: the exact
    // field values as they appeared in the source register (original raw
    // county string, raw permit number, any note text), preserved even
    // after normalisation is applied to the structured columns above.
    @Column({ type: "jsonb", nullable: true })
    importRawData!: Record<string, any> | null;

    // -----------------------------------------------------------------
    // Agency Register support. Additive, only ever populated for
    // permitOrLicenceType === "AGENCY" certificates; every other category
    // leaves them null/false and is entirely unaffected. See
    // AgencyStaffingService for how these are computed/maintained.
    // -----------------------------------------------------------------

    // True while this Agency does not currently meet the staffing
    // requirement (>= 3 distinct active Agents AND exactly 1 active
    // Clerk) — set/cleared by AgencyStaffingService.
    // computeAndRefreshStaffingFlag(), never implies isPubliclyBlocked and
    // never changes the underlying Application's status: an already-
    // issued Agency permit stays issued and publicly verifiable while
    // flagged, per the explicit "flag for review without automatically
    // changing the status of previously issued permits" decision.
    @Column({ default: false })
    staffingFlagged!: boolean;

    @Column({ type: "text", nullable: true })
    staffingFlagReason!: string | null;

    // Agency's own logo image (Cloudinary secure_url), set via
    // POST /api/agencies/:id/logo. Additive, only ever populated for
    // permitOrLicenceType === "AGENCY" certificates — every other
    // category leaves this null. Shown on the admin Agency profile header
    // and on the public Agency verification page
    // (PermitVerificationService.toPublicPermitView()).
    @Column({ type: "varchar", nullable: true })
    logoUrl!: string | null;

    // -----------------------------------------------------------------
    // Exporter Register support. Additive, only ever populated for
    // permitOrLicenceType === "LOCAL_EXPORTER" or "FOREIGN_EXPORTER"
    // certificates; every other category leaves this null. Every other
    // field the Exporter Register needs (county, isPubliclyBlocked,
    // publicBlockReason, stagedPermitNumber, sourceRecordId,
    // isHistoricalImport, importRawData, verificationToken,
    // buyerDisplayName as the company name) is already generic enough on
    // this entity and is reused as-is, exactly like the Agency Register
    // reused the Local Produce Buyer block before it.
    // -----------------------------------------------------------------

    // Holds the SECOND, disputed county value for a record under staff
    // review (e.g. Meridian Commodity Inc. — the historical overview says
    // Montserrado, the company's own historical QR says Nimba). The
    // primary/first-recorded value stays in `county` above; this field
    // exists purely so neither candidate value is ever discarded while
    // the record is held for review. Null for every normal (non-disputed)
    // Exporter certificate and for every non-Exporter certificate.
    @Column({ type: "varchar", nullable: true })
    disputedCounty!: string | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
