/**
 * LocalProduceBuyerImportService — dry-run/apply reconciliation of the
 * historical Local Produce Buyer Register (83 total records: 82 original
 * rows + Bill Gruyoo's separately recovered record) into the live
 * Application + Certificate model.
 *
 * Modeled directly on CooperativeController's previewImport()/applyImport()
 * idempotency pattern:
 *   - The natural/upsert key is `sourceRecordId` (the register's own QR
 *     reference string, e.g. "LPB1:LACRA-194-2026:8D7C2870") — NOT name or
 *     permit number, since two different real people can legitimately
 *     share a permit number in this source data (the two flagged
 *     conflicts) and names are not guaranteed unique either.
 *   - Nothing already imported is ever re-created or altered by a re-run
 *     (an existing Certificate.sourceRecordId match is always a no-op).
 *   - Nothing is ever deleted.
 *   - A full preview (read-only) is always available before apply.
 *
 * Historical-vs-live distinction (explicit, per the approved decision):
 * every row created by this importer is an Application+Certificate pair
 * with isHistoricalImport=true, status=ISSUED set directly (never routed
 * through SUBMITTED -> ... -> CERTIFICATE_PRINTED), and exactly ONE audit
 * trail entry ("HISTORICAL_IMPORT") rather than the sequence of
 * verification/approval/payment history rows a real application
 * accumulates — so the backfill can never be mistaken for, or later
 * queried as, a live CMIS approval, payment, or DG sign-off that never
 * actually happened.
 *
 * Conflict handling (per the approved decision):
 *   - The two shared-permit-number groups (LACRA-260-2026: Moses A.
 *     Diapleh / Prosper G. Cooper; LACRA-263-2026: Jonathan B. Davis /
 *     Vivian Z. N. Yarbah) — all FOUR of those records import as
 *     isPubliclyBlocked=true. Because certificateNumber is UNIQUE, only
 *     the first-imported record of each pair can actually hold the
 *     shared number in certificateNumber; the others get
 *     stagedPermitNumber set to the original value and certificateNumber
 *     left null until staff resolve the conflict (assign a corrected
 *     number to one side).
 *   - Lawrence P. Smith (disputed issuance date) imports as
 *     isPubliclyBlocked=true with both the register's own two candidate
 *     dates preserved in importRawData for staff review.
 *   - The three pinned numbers (Mark Z. Yuahn/278, Irene Gbarlea Dolo/279,
 *     Uranus W. Wonyagror/190) import exactly as recorded — the importer
 *     asserts this against PINNED_PERMIT_NUMBERS and would itself flag
 *     a CONFLICT (not silently proceed) if the source data ever disagreed
 *     with the pin.
 */

import { AppDataSource } from "../data-source";
import { Application, ApplicationCategory, ApplicationChannel, ApplicationStatus } from "../entities/Application";
import { ApplicationStatusHistory } from "../entities/ApplicationStatusHistory";
import { Certificate } from "../entities/Certificate";
import { LocalProduceBuyerImportRun } from "../entities/LocalProduceBuyerImportRun";
import { LocalProduceBuyerNumberService } from "./LocalProduceBuyerNumberService";
import {
    LOCAL_PRODUCE_BUYER_SEED_DATA,
    LOCAL_PRODUCE_BUYER_IMPORT_SOURCE_LABEL,
    PINNED_PERMIT_NUMBERS,
    LocalProduceBuyerSeedRecord,
} from "../data/localProduceBuyerSeedData";

export type ImportRecordStatus = "MATCHED" | "ADDED" | "CONFLICT";

/**
 * Thrown by preview()/apply() when the certificate table contains
 * evidence of a prior Local Produce Buyer import or issuance whose
 * sourceRecordId has gone missing — the exact signature left behind by a
 * schema rollback (down.sql) that was run without first exporting/
 * restoring the dropped columns, or any other data corruption that
 * stripped the import's idempotency key while leaving the rows in place.
 * Surfaced loudly rather than silently re-importing, because without a
 * readable sourceRecordId the importer cannot tell which of these
 * orphaned rows correspond to which seed records, so classifyAll() can no
 * longer distinguish "already imported" from "never imported" for them —
 * proceeding would create a second, duplicate set of Application +
 * Certificate rows for buyers who already have one (see
 * migrations/2028_local_produce_buyers/README.md for the tested evidence
 * of exactly this failure mode).
 */
export class LocalProduceBuyerImportIntegrityError extends Error {
    constructor(public readonly orphanedCount: number) {
        super(
            `Refusing to proceed: ${orphanedCount} existing "LOCAL_BUYER" certificate record(s) have no sourceRecordId. ` +
                `This is the signature of a prior import whose idempotency key was lost (e.g. a schema rollback run without ` +
                `first exporting/restoring the dropped columns) — proceeding would create a second, duplicate set of records ` +
                `for buyers who may already have one. Resolve the orphaned records first (restore their sourceRecordId from a ` +
                `backup, or have staff explicitly review and remove them) before running preview or apply again.`
        );
        this.name = "LocalProduceBuyerImportIntegrityError";
    }
}

export interface ImportRecordResult {
    sourceRecordId: string;
    name: string;
    permitNumber: string;
    county: string;
    status: ImportRecordStatus;
    conflictReason?: string;
    isPubliclyBlocked: boolean;
}

export interface ImportSummary {
    source: string;
    totalSourceRecords: number;
    matchedCount: number;
    addedCount: number;
    conflictCount: number;
    records: ImportRecordResult[];
}

// The exact Application.submissionMethod value apply() sets on every
// historical-import row (see below), used by assertNoOrphanedImports() to
// distinguish "a certificate created by this importer that has since lost
// its sourceRecordId" from a legitimate live LOCAL_BUYER issuance, which
// never has this submissionMethod and legitimately has no sourceRecordId
// at all. This constant lives on the `application` table, which
// down.sql's column drop never touches, so it survives a rollback even
// when the certificate-side sourceRecordId does not — making it the one
// reliable signal left to detect the orphaned-row state.
const HISTORICAL_IMPORT_SUBMISSION_METHOD = "Historical Register Import";

export class LocalProduceBuyerImportService {
    /**
     * Guards against the exact state a mishandled post-import schema
     * rollback can leave behind: certificate rows that were created by
     * THIS importer (their Application has
     * submissionMethod === "Historical Register Import") but whose
     * sourceRecordId has gone missing (e.g. down.sql's column drop ran
     * without first exporting/restoring it). If any such row is found,
     * preview()/apply() must refuse to proceed rather than silently
     * treating every seed record as "never imported" and creating a
     * second, duplicate set — see LocalProduceBuyerImportIntegrityError's
     * doc comment and migrations/2028_local_produce_buyers/README.md for
     * the tested evidence of that failure mode.
     */
    private static async assertNoOrphanedImports(manager: typeof AppDataSource | import("typeorm").EntityManager): Promise<void> {
        const orphanedCount = await manager
            .getRepository(Certificate)
            .createQueryBuilder("cert")
            .innerJoin(Application, "app", "app.id = cert.applicationId")
            .where("cert.permitOrLicenceType = :type", { type: "LOCAL_BUYER" })
            .andWhere("app.submissionMethod = :method", { method: HISTORICAL_IMPORT_SUBMISSION_METHOD })
            .andWhere("cert.sourceRecordId IS NULL")
            .getCount();

        if (orphanedCount > 0) {
            throw new LocalProduceBuyerImportIntegrityError(orphanedCount);
        }
    }

    /**
     * Read-only dry run: classifies every one of the 83 source records as
     * MATCHED (already imported — sourceRecordId found), ADDED (would be
     * newly created), or CONFLICT (shared permit number / disputed date —
     * would be created but held/blocked pending staff review). Writes
     * nothing to the database except, optionally, the LocalProduceBuyerImportRun
     * audit row itself (controlled by `recordRun`).
     *
     * Refuses to run (throws LocalProduceBuyerImportIntegrityError) if any
     * previously-imported certificate row has lost its sourceRecordId —
     * see assertNoOrphanedImports().
     */
    static async preview(options: { performedByUserId?: string | null; performedByName?: string | null; recordRun?: boolean } = {}): Promise<ImportSummary> {
        await this.assertNoOrphanedImports(AppDataSource);

        const certificateRepository = AppDataSource.getRepository(Certificate);
        const existingBySourceId = new Map<string, Certificate>();
        const existing = await certificateRepository.find();
        for (const c of existing) {
            if (c.sourceRecordId) existingBySourceId.set(c.sourceRecordId, c);
        }

        const summary = this.classifyAll(LOCAL_PRODUCE_BUYER_SEED_DATA, existingBySourceId);

        if (options.recordRun) {
            await this.recordRun(summary, { isDryRun: true, performedByUserId: options.performedByUserId, performedByName: options.performedByName });
        }

        return summary;
    }

    private static classifyAll(
        seedData: LocalProduceBuyerSeedRecord[],
        existingBySourceId: Map<string, Certificate>
    ): ImportSummary {
        // Pre-compute which permit numbers are shared by MORE THAN ONE
        // distinct source record, so both sides of a shared-number pair
        // are flagged symmetrically regardless of import order.
        const numberCounts = new Map<string, number>();
        for (const rec of seedData) {
            numberCounts.set(rec.permitNumber, (numberCounts.get(rec.permitNumber) || 0) + 1);
        }

        const records: ImportRecordResult[] = seedData.map((rec) => {
            const alreadyImported = existingBySourceId.has(rec.sourceRecordId);

            const sharedNumber = (numberCounts.get(rec.permitNumber) || 0) > 1;
            const disputedDate = rec.flags.includes("DATE_NOTE");
            const pinnedExpected = PINNED_PERMIT_NUMBERS[rec.name];
            const pinnedMismatch = pinnedExpected !== undefined && pinnedExpected !== rec.permitNumber;

            let status: ImportRecordStatus = alreadyImported ? "MATCHED" : "ADDED";
            let conflictReason: string | undefined;
            let isPubliclyBlocked = false;

            if (sharedNumber) {
                isPubliclyBlocked = true;
                conflictReason = `Permit number ${rec.permitNumber} is shared with another distinct buyer in the source register — held pending staff resolution.`;
                if (!alreadyImported) status = "CONFLICT";
            }
            if (disputedDate) {
                isPubliclyBlocked = true;
                conflictReason = conflictReason
                    ? `${conflictReason} Also: issuance date is disputed (register shows 19 Feb 2026; an earlier summary gives 19 May 2026) — held for issuance-date review.`
                    : "Issuance date is disputed (register shows 19 Feb 2026; an earlier summary gives 19 May 2026) — held for issuance-date review.";
                if (!alreadyImported) status = "CONFLICT";
            }
            if (pinnedMismatch) {
                // Defensive guard: the embedded seed data should never
                // disagree with the explicitly pinned values, but if it
                // ever does (e.g. a future hand-edit of the seed file),
                // surface it loudly as a conflict rather than silently
                // importing a number that contradicts a pin.
                isPubliclyBlocked = true;
                conflictReason = `Pinned permit number mismatch: ${rec.name} is pinned to ${pinnedExpected} but source data has ${rec.permitNumber} — held pending correction.`;
                status = alreadyImported ? "MATCHED" : "CONFLICT";
            }

            return {
                sourceRecordId: rec.sourceRecordId,
                name: rec.name,
                permitNumber: rec.permitNumber,
                county: rec.county,
                status,
                conflictReason,
                isPubliclyBlocked,
            };
        });

        return {
            source: LOCAL_PRODUCE_BUYER_IMPORT_SOURCE_LABEL,
            totalSourceRecords: seedData.length,
            matchedCount: records.filter((r) => r.status === "MATCHED").length,
            addedCount: records.filter((r) => r.status === "ADDED").length,
            conflictCount: records.filter((r) => r.status === "CONFLICT").length,
            records,
        };
    }

    /**
     * Applies the import. Idempotent: records already present (matched by
     * sourceRecordId) are left completely untouched — no field is
     * overwritten on a re-run, so a staff correction made after a staff
     * conflict-resolution (e.g. manually fixing a stagedPermitNumber) is
     * never clobbered by re-running this. New records are created as
     * historical Application+Certificate pairs. Nothing is ever deleted.
     *
     * Seeds/raises the LocalProduceBuyerSequence counter to at least the
     * highest permitNumber present in the full seed set (including
     * conflicting/staged ones), so a live issuance immediately after
     * import can never collide with an imported historical number.
     *
     * Refuses to run (throws LocalProduceBuyerImportIntegrityError, inside
     * the same transaction so nothing is written) if any
     * previously-imported certificate row has lost its sourceRecordId —
     * see assertNoOrphanedImports().
     */
    static async apply(options: { performedByUserId?: string | null; performedByName?: string | null }): Promise<ImportSummary> {
        const summary = await AppDataSource.transaction(async (manager) => {
            await this.assertNoOrphanedImports(manager);

            const certificateRepository = manager.getRepository(Certificate);
            const applicationRepository = manager.getRepository(Application);
            const historyRepository = manager.getRepository(ApplicationStatusHistory);

            const existing = await certificateRepository.find();
            const existingBySourceId = new Map<string, Certificate>();
            for (const c of existing) {
                if (c.sourceRecordId) existingBySourceId.set(c.sourceRecordId, c);
            }

            const classification = this.classifyAll(LOCAL_PRODUCE_BUYER_SEED_DATA, existingBySourceId);

            // Track, per permit number, which record (if any) has already
            // claimed the real certificateNumber slot this run — the
            // FIRST record processed for a shared number gets
            // certificateNumber; every subsequent one with the same
            // number gets stagedPermitNumber instead, to respect the
            // unique constraint while preserving both records in full.
            const claimedNumbers = new Set<string>(existing.filter((c) => c.certificateNumber).map((c) => c.certificateNumber));

            let highestSeedNumber = 0;
            for (const rec of LOCAL_PRODUCE_BUYER_SEED_DATA) {
                const match = rec.permitNumber.match(/^LACRA-(\d+)-\d{4}$/);
                if (match) highestSeedNumber = Math.max(highestSeedNumber, parseInt(match[1], 10));
            }
            await LocalProduceBuyerNumberService.ensureMinimum(manager, highestSeedNumber);

            for (let i = 0; i < LOCAL_PRODUCE_BUYER_SEED_DATA.length; i++) {
                const rec = LOCAL_PRODUCE_BUYER_SEED_DATA[i];
                const classified = classification.records[i];

                if (classified.status === "MATCHED") {
                    // Already imported — leave entirely untouched.
                    continue;
                }

                // ADDED or CONFLICT: both create a new Application +
                // Certificate pair; CONFLICT additionally sets
                // isPubliclyBlocked / publicBlockReason / possibly
                // stagedPermitNumber instead of certificateNumber.
                const numberAlreadyClaimed = claimedNumbers.has(rec.permitNumber);
                const useStagedNumber = numberAlreadyClaimed;
                if (!useStagedNumber) claimedNumbers.add(rec.permitNumber);

                const application = applicationRepository.create({
                    category: ApplicationCategory.LOCAL_BUYER,
                    commodity: undefined,
                    channel: ApplicationChannel.OFFICE_ASSISTED,
                    submissionMethod: "Historical Register Import",
                    status: ApplicationStatus.ISSUED,
                    data: {
                        buyer: {
                            fullName: rec.name,
                            county: rec.county,
                        },
                    },
                    officeApplicantName: rec.name,
                    enteringOfficerName: options.performedByName || "System Import",
                    enteringOfficerUserId: options.performedByUserId || undefined,
                    assistedEntryReason: "Backfilled from the historical Local Produce Buyer Register (pre-dates the CMIS Application workflow).",
                    applicantConsentConfirmed: false,
                    submittedByUserId: options.performedByUserId || undefined,
                    submittedAt: new Date(rec.issuedDate),
                });
                await applicationRepository.save(application);

                const certificate = certificateRepository.create({
                    applicationId: application.id,
                    permitOrLicenceType: "LOCAL_BUYER",
                    certificateNumber: useStagedNumber ? undefined : rec.permitNumber,
                    stagedPermitNumber: useStagedNumber ? rec.permitNumber : null,
                    issueDate: new Date(rec.issuedDate),
                    expiryDate: new Date(rec.expiresDate),
                    verificationToken: classified.isPubliclyBlocked ? null : cryptoRandomUUID(),
                    buyerDisplayName: rec.name,
                    county: rec.county,
                    locality: rec.locality,
                    isPubliclyBlocked: classified.isPubliclyBlocked,
                    publicBlockReason: classified.conflictReason || null,
                    sourceRecordId: rec.sourceRecordId,
                    isHistoricalImport: true,
                    importRawData: {
                        rawCounty: rec.rawCounty,
                        issuedLabel: rec.issuedLabel,
                        expiresLabel: rec.expiresLabel,
                        flags: rec.flags,
                        separatelyRecovered: rec.separatelyRecovered,
                        importedAt: new Date().toISOString(),
                    },
                    printedByUserId: options.performedByUserId || undefined,
                    printedByName: options.performedByName || "System Import",
                    printedAt: new Date(),
                    issuedAt: new Date(rec.issuedDate),
                });
                await certificateRepository.save(certificate);

                // Exactly ONE audit trail entry for the whole backfill —
                // deliberately NOT a simulated SUBMITTED -> VERIFIED ->
                // APPROVED -> ... chain, so this can never be mistaken for
                // (or queried as) a real workflow run.
                await historyRepository.save(historyRepository.create({
                    applicationId: application.id,
                    action: "HISTORICAL_IMPORT",
                    previousStatus: undefined,
                    newStatus: ApplicationStatus.ISSUED,
                    userId: options.performedByUserId || undefined,
                    userName: options.performedByName || "System Import",
                    role: "System Import",
                    comments: `Backfilled from the historical Local Produce Buyer Register (source record ${rec.sourceRecordId}, permit ${rec.permitNumber}). This is a historical record, not a live CMIS approval — no verification/approval/payment workflow was run.`,
                }));
            }

            return classification;
        });

        await this.recordRun(summary, { isDryRun: false, performedByUserId: options.performedByUserId, performedByName: options.performedByName });
        return summary;
    }

    private static async recordRun(summary: ImportSummary, options: { isDryRun: boolean; performedByUserId?: string | null; performedByName?: string | null }) {
        const importRunRepository = AppDataSource.getRepository(LocalProduceBuyerImportRun);
        const run = importRunRepository.create({
            source: summary.source,
            isDryRun: options.isDryRun,
            performedByUserId: options.performedByUserId || null,
            performedByName: options.performedByName || null,
            matchedCount: summary.matchedCount,
            addedCount: summary.addedCount,
            conflictCount: summary.conflictCount,
            totalSourceRecords: summary.totalSourceRecords,
            detailsJson: JSON.stringify(summary.records),
        });
        await importRunRepository.save(run);
    }

    static async getImportRuns(): Promise<LocalProduceBuyerImportRun[]> {
        const importRunRepository = AppDataSource.getRepository(LocalProduceBuyerImportRun);
        return importRunRepository.find({ order: { createdAt: "DESC" }, take: 50 });
    }
}

function cryptoRandomUUID(): string {
    // Local helper to avoid importing the whole 'crypto' module's type
    // surface into this file's public API; Node's global crypto is
    // available in the runtime versions this backend targets.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("crypto").randomUUID();
}
