/**
 * ExporterImportService — dry-run/apply reconciliation of the authorized
 * historical Exporter Register batch (12 records) into the live
 * Application + Certificate model.
 *
 * Modeled directly on LocalProduceBuyerImportService's and
 * AgencyImportService's idempotency pattern:
 *   - The natural/upsert key is `sourceRecordId` (this batch's own stable
 *     per-record ID, e.g. "LACRA-EXPORTER-HIST-007") — NOT the exporter
 *     name or license number, consistent with every prior register
 *     import.
 *   - Nothing already imported is ever re-created or altered by a re-run
 *     (an existing Certificate.sourceRecordId match is always a no-op).
 *   - Nothing is ever deleted.
 *   - A full preview (read-only) is always available before apply.
 *   - License numbers are preserved EXACTLY as recorded — including
 *     leading zeros and the unique "EXPO" prefix on Substantial Trade
 *     Group of Companies's license — never parsed/re-padded as a number.
 *
 * Historical-vs-live distinction (same as every prior register importer):
 * every row created by this importer is an Application+Certificate pair
 * with isHistoricalImport=true, status=ISSUED set directly (never routed
 * through SUBMITTED -> ... -> CERTIFICATE_PRINTED), and exactly ONE audit
 * trail entry ("HISTORICAL_IMPORT") rather than a simulated verification/
 * approval/payment chain.
 *
 * Meridian Commodity Inc. (MCI) county conflict (per the approved
 * decision): imports with isPubliclyBlocked=true (no verificationToken —
 * its public QR is disabled until staff resolve the discrepancy),
 * certificateNumber set normally (the license number itself is not in
 * conflict, only the county), `county` holding the batch overview's
 * Montserrado value and `disputedCounty` holding the historical QR's
 * Nimba value — BOTH candidates preserved, neither discarded.
 *
 * Every historical Exporter is imported under
 * ApplicationCategory.LOCAL_EXPORTER / permitOrLicenceType "EXPORTER" —
 * see the class doc note in ExporterController for why the register
 * presents a single unified Exporter view rather than splitting
 * Local/Foreign, even though the underlying Application.category enum
 * already distinguishes LOCAL_EXPORTER and FOREIGN_EXPORTER for the
 * live /apply wizard.
 */

import { AppDataSource } from "../data-source";
import { Application, ApplicationCategory, ApplicationChannel, ApplicationStatus } from "../entities/Application";
import { ApplicationStatusHistory } from "../entities/ApplicationStatusHistory";
import { Certificate } from "../entities/Certificate";
import { ExporterImportRun } from "../entities/ExporterImportRun";
import {
    EXPORTER_SEED_DATA,
    EXPORTER_IMPORT_SOURCE_LABEL,
    EXPORTER_DEFAULT_COUNTY,
    ExporterSeedRecord,
} from "../data/exporterRegisterSeedData";

// The single, unified discriminator value used for every Exporter
// certificate regardless of whether the underlying Application.category
// is LOCAL_EXPORTER or FOREIGN_EXPORTER — the Exporter Register itself has
// no Local/Foreign column or filter (per the spec's table-column list), so
// collapsing both categories into one permitOrLicenceType keeps the
// register's queries as simple as every other register's.
export const EXPORTER_PERMIT_TYPE = "EXPORTER";

export type ExporterImportRecordStatus = "MATCHED" | "ADDED" | "CONFLICT";

/**
 * Thrown by preview()/apply() when the certificate table contains evidence
 * of a prior Exporter import whose sourceRecordId has gone missing — the
 * same orphaned-row integrity guard every prior register importer uses
 * (see LocalProduceBuyerImportIntegrityError / AgencyImportIntegrityError
 * for the full reasoning).
 */
export class ExporterImportIntegrityError extends Error {
    constructor(public readonly orphanedCount: number) {
        super(
            `Refusing to proceed: ${orphanedCount} existing "${EXPORTER_PERMIT_TYPE}" certificate record(s) have no sourceRecordId. ` +
                `This is the signature of a prior import whose idempotency key was lost (e.g. a schema rollback run without first ` +
                `exporting/restoring the dropped columns) — proceeding would create a second, duplicate set of records for exporters ` +
                `who may already have one. Resolve the orphaned records first before running preview or apply again.`
        );
        this.name = "ExporterImportIntegrityError";
    }
}

const HISTORICAL_IMPORT_SUBMISSION_METHOD = "Historical Register Import";

export interface ExporterImportRecordResult {
    sourceRecordId: string;
    exporterName: string;
    licenseNumber: string;
    county: string;
    status: ExporterImportRecordStatus;
    conflictReason?: string;
    isPubliclyBlocked: boolean;
}

export interface ExporterImportSummary {
    source: string;
    totalSourceRecords: number;
    matchedCount: number;
    addedCount: number;
    conflictCount: number;
    records: ExporterImportRecordResult[];
}

export class ExporterImportService {
    private static async assertNoOrphanedImports(manager: typeof AppDataSource | import("typeorm").EntityManager): Promise<void> {
        const orphanedCount = await manager
            .getRepository(Certificate)
            .createQueryBuilder("cert")
            .innerJoin(Application, "app", "app.id = cert.applicationId")
            .where("cert.permitOrLicenceType = :type", { type: EXPORTER_PERMIT_TYPE })
            .andWhere("app.submissionMethod = :method", { method: HISTORICAL_IMPORT_SUBMISSION_METHOD })
            .andWhere("cert.sourceRecordId IS NULL")
            .getCount();

        if (orphanedCount > 0) {
            throw new ExporterImportIntegrityError(orphanedCount);
        }
    }

    /**
     * Read-only dry run: classifies every one of the 12 source records as
     * MATCHED (already imported — sourceRecordId found), ADDED (would be
     * newly created), or CONFLICT (Meridian's county discrepancy — would
     * be created but held/blocked pending staff review). Writes nothing to
     * the database except, optionally, the ExporterImportRun audit row
     * itself (controlled by `recordRun`).
     */
    static async preview(options: { performedByUserId?: string | null; performedByName?: string | null; recordRun?: boolean } = {}): Promise<ExporterImportSummary> {
        await this.assertNoOrphanedImports(AppDataSource);

        const certificateRepository = AppDataSource.getRepository(Certificate);
        const existingBySourceId = new Map<string, Certificate>();
        const existing = await certificateRepository.find({ where: { permitOrLicenceType: EXPORTER_PERMIT_TYPE } });
        for (const c of existing) {
            if (c.sourceRecordId) existingBySourceId.set(c.sourceRecordId, c);
        }

        const summary = this.classifyAll(EXPORTER_SEED_DATA, existingBySourceId);

        if (options.recordRun) {
            await this.recordRun(summary, { isDryRun: true, performedByUserId: options.performedByUserId, performedByName: options.performedByName });
        }

        return summary;
    }

    private static classifyAll(
        seedData: ExporterSeedRecord[],
        existingBySourceId: Map<string, Certificate>
    ): ExporterImportSummary {
        const records: ExporterImportRecordResult[] = seedData.map((rec) => {
            const alreadyImported = existingBySourceId.has(rec.sourceRecordId);
            const isConflict = !!rec.countyConflict;

            let status: ExporterImportRecordStatus = alreadyImported ? "MATCHED" : "ADDED";
            let conflictReason: string | undefined;

            if (isConflict) {
                conflictReason = rec.countyConflict!.note;
                if (!alreadyImported) status = "CONFLICT";
            }

            return {
                sourceRecordId: rec.sourceRecordId,
                exporterName: rec.exporterName,
                licenseNumber: rec.licenseNumber,
                county: rec.countyConflict ? rec.countyConflict.overviewCounty : EXPORTER_DEFAULT_COUNTY,
                status,
                conflictReason,
                isPubliclyBlocked: isConflict,
            };
        });

        return {
            source: EXPORTER_IMPORT_SOURCE_LABEL,
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
     * overwritten on a re-run, so a staff correction made after resolving
     * Meridian's county conflict is never clobbered by re-running this.
     * New records are created as historical Application+Certificate
     * pairs. Nothing is ever deleted.
     */
    static async apply(options: { performedByUserId?: string | null; performedByName?: string | null }): Promise<ExporterImportSummary> {
        const summary = await AppDataSource.transaction(async (manager) => {
            await this.assertNoOrphanedImports(manager);

            const certificateRepository = manager.getRepository(Certificate);
            const applicationRepository = manager.getRepository(Application);
            const historyRepository = manager.getRepository(ApplicationStatusHistory);

            const existing = await certificateRepository.find({ where: { permitOrLicenceType: EXPORTER_PERMIT_TYPE } });
            const existingBySourceId = new Map<string, Certificate>();
            for (const c of existing) {
                if (c.sourceRecordId) existingBySourceId.set(c.sourceRecordId, c);
            }

            const classification = this.classifyAll(EXPORTER_SEED_DATA, existingBySourceId);

            // License numbers are a verbatim mix of EXP/EXPO prefixes and
            // leading-zero styles (see seed data doc comment) — unlike the
            // Local Produce Buyer register, there is no shared running
            // sequence to seed here; every license number in this batch
            // is already fully formed and unique, so no number-allocator
            // bookkeeping is needed.
            for (let i = 0; i < EXPORTER_SEED_DATA.length; i++) {
                const rec = EXPORTER_SEED_DATA[i];
                const classified = classification.records[i];

                if (classified.status === "MATCHED") {
                    // Already imported — leave entirely untouched.
                    continue;
                }

                const application = applicationRepository.create({
                    category: ApplicationCategory.LOCAL_EXPORTER,
                    commodity: undefined,
                    channel: ApplicationChannel.OFFICE_ASSISTED,
                    submissionMethod: HISTORICAL_IMPORT_SUBMISSION_METHOD,
                    status: ApplicationStatus.ISSUED,
                    data: {
                        exporter: {
                            legalName: rec.exporterName,
                            county: classified.county,
                        },
                    },
                    officeApplicantName: rec.exporterName,
                    enteringOfficerName: options.performedByName || "System Import",
                    enteringOfficerUserId: options.performedByUserId || undefined,
                    assistedEntryReason: "Backfilled from the authorized historical Exporter Register batch (pre-dates the CMIS Application workflow).",
                    applicantConsentConfirmed: false,
                    submittedByUserId: options.performedByUserId || undefined,
                    submittedAt: new Date(rec.issuedOn),
                });
                await applicationRepository.save(application);

                const isConflict = classified.isPubliclyBlocked;
                const certificate = certificateRepository.create({
                    applicationId: application.id,
                    permitOrLicenceType: EXPORTER_PERMIT_TYPE,
                    // The license number itself is never in conflict for
                    // this batch (only Meridian's county is) — every
                    // record, including Meridian, gets its real
                    // certificateNumber set directly. isPubliclyBlocked
                    // alone is what disables the public QR for Meridian
                    // (no verificationToken is issued), mirroring how a
                    // disputed-date Local Produce Buyer record still gets
                    // its real permit number but no token.
                    certificateNumber: rec.licenseNumber,
                    stagedPermitNumber: null,
                    issueDate: new Date(rec.issuedOn),
                    expiryDate: new Date(rec.expiresOn),
                    verificationToken: isConflict ? null : cryptoRandomUUID(),
                    buyerDisplayName: rec.exporterName,
                    county: classified.county,
                    locality: null,
                    disputedCounty: rec.countyConflict ? rec.countyConflict.historicalQrCounty : null,
                    isPubliclyBlocked: isConflict,
                    publicBlockReason: classified.conflictReason || null,
                    sourceRecordId: rec.sourceRecordId,
                    isHistoricalImport: true,
                    importRawData: {
                        countyConflict: rec.countyConflict || null,
                        importedAt: new Date().toISOString(),
                    },
                    printedByUserId: options.performedByUserId || undefined,
                    printedByName: options.performedByName || "System Import",
                    printedAt: new Date(),
                    issuedAt: new Date(rec.issuedOn),
                });
                await certificateRepository.save(certificate);

                // Exactly ONE audit trail entry for the whole backfill —
                // never a simulated SUBMITTED -> VERIFIED -> APPROVED ->
                // ... chain, so this can never be mistaken for (or
                // queried as) a real workflow run.
                await historyRepository.save(historyRepository.create({
                    applicationId: application.id,
                    action: "HISTORICAL_IMPORT",
                    previousStatus: undefined,
                    newStatus: ApplicationStatus.ISSUED,
                    userId: options.performedByUserId || undefined,
                    userName: options.performedByName || "System Import",
                    role: "System Import",
                    comments: `Backfilled from the authorized historical Exporter Register batch (source record ${rec.sourceRecordId}, license ${rec.licenseNumber}).${isConflict ? " HELD pending staff confirmation of a county discrepancy — see Certificate.publicBlockReason / disputedCounty." : ""} This is a historical record, not a live CMIS approval — no verification/approval/payment workflow was run.`,
                }));
            }

            return classification;
        });

        await this.recordRun(summary, { isDryRun: false, performedByUserId: options.performedByUserId, performedByName: options.performedByName });
        return summary;
    }

    private static async recordRun(summary: ExporterImportSummary, options: { isDryRun: boolean; performedByUserId?: string | null; performedByName?: string | null }) {
        const importRunRepository = AppDataSource.getRepository(ExporterImportRun);
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

    static async getImportRuns(): Promise<ExporterImportRun[]> {
        const importRunRepository = AppDataSource.getRepository(ExporterImportRun);
        return importRunRepository.find({ order: { createdAt: "DESC" }, take: 50 });
    }
}

function cryptoRandomUUID(): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("crypto").randomUUID();
}
