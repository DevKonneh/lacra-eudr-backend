/**
 * AgencyImportService — dry-run/apply reconciliation of the historical
 * LACRA Agency Register (11 Agency rows + 7 historical Agent entries)
 * into the live Application + Certificate + AgentPersonnel model.
 *
 * Modeled directly on LocalProduceBuyerImportService's idempotency
 * pattern:
 *   - The natural/upsert key is `sourceRecordId` (the reconciliation
 *     package's own stable IDs, e.g. "LACRA-AGENCY-HIST-004" /
 *     "LACRA-AGENT-HIST-002") — NOT name or permit number, since this
 *     source data has two KNOWN permit-number conflicts (030, 041) where
 *     multiple distinct names are recorded under one shared number.
 *   - Nothing already imported is ever re-created or altered by a re-run.
 *   - Nothing is ever deleted.
 *   - A full preview (read-only) is always available before apply.
 *
 * Historical-vs-live distinction: every Agency created by this importer is
 * an Application+Certificate pair with isHistoricalImport=true,
 * status=ISSUED set directly, and exactly ONE audit trail entry
 * ("HISTORICAL_IMPORT") — never a simulated verification/approval/payment
 * chain. Every historical Agent created is an AgentPersonnel row with
 * isHistoricalImport=true and its own single historyLog entry
 * ("Backfilled from historical register").
 *
 * Conflict handling (permits 030 and 041, per the approved decision):
 *   - The Agency row itself (reconciliationStatus === "requires_reconciliation")
 *     imports with isPubliclyBlocked=true, certificateNumber left null,
 *     stagedPermitNumber holding the recorded number, and no
 *     verificationToken — exactly like a Local Produce Buyer shared-number
 *     conflict.
 *   - EVERY historical Agent whose sharedAgencyPermitNumber is 030 or 041
 *     ALSO imports with isPubliclyBlocked=true and no verificationToken,
 *     even if that Agent's own candidateAgencySourceRecordId happens to be
 *     set — a conflicted Agency's identity being unresolved means none of
 *     its Agents can be safely verified as belonging to a confirmed legal
 *     entity yet.
 *
 * Unassigned personnel (per the approved decision — "leave missing staff
 * assignments blank"): the three historical Agents with
 * candidateAgencySourceRecordId === null (Ousmane Sow, Larry Clark, Sekou
 * K. Sheriff) import with agencyCertificateId left null and
 * requiresAgencyConfirmation=true. They are never auto-linked to any
 * Agency, including by name-matching — only an explicit staff linking
 * action (AgencyController.linkPersonnelToAgency) may set
 * agencyCertificateId for these.
 *
 * Incomplete staffing (per the approved decision — "flag incomplete
 * historical staffing for review without automatically changing the
 * status of previously issued permits"): confirmedClerks is EMPTY in the
 * source package (no Clerk names were confirmed), so EVERY one of the 11
 * imported Agencies will fail the >=3-Agents+1-Clerk staffing check and
 * come out of apply() with Certificate.staffingFlagged=true. This is
 * expected, not a bug — see AgencyStaffingService.computeAndRefreshStaffingFlag(),
 * which deliberately never touches Application.status or
 * Certificate.isPubliclyBlocked when flagging staffing.
 */

import { AppDataSource } from "../data-source";
import { Application, ApplicationCategory, ApplicationChannel, ApplicationStatus } from "../entities/Application";
import { ApplicationStatusHistory } from "../entities/ApplicationStatusHistory";
import { Certificate } from "../entities/Certificate";
import { AgentPersonnel, AgentPersonnelRole, AgentPersonnelStatus } from "../entities/AgentPersonnel";
import { AgencyImportRun } from "../entities/AgencyImportRun";
import { computeAndRefreshStaffingFlag } from "./AgencyStaffingService";
import {
    AGENCY_SEED_DATA,
    AGENT_PERSONNEL_SEED_DATA,
    AGENCY_CONFLICTS,
    AGENCY_IMPORT_SOURCE_LABEL,
    AgencySeedRecord,
    AgentPersonnelSeedRecord,
} from "../data/agencyRegisterSeedData";

export type AgencyImportRecordStatus = "MATCHED" | "ADDED" | "CONFLICT";

export class AgencyImportIntegrityError extends Error {
    constructor(public readonly orphanedAgencyCount: number, public readonly orphanedPersonnelCount: number) {
        super(
            `Refusing to proceed: ${orphanedAgencyCount} existing "AGENCY" certificate record(s) and/or ${orphanedPersonnelCount} ` +
                `existing AgentPersonnel record(s) created by a prior historical import have lost their sourceRecordId. This is the ` +
                `signature of a schema rollback run without first exporting/restoring the dropped columns — proceeding would create a ` +
                `second, duplicate set of records. Resolve the orphaned records first before running preview or apply again.`
        );
        this.name = "AgencyImportIntegrityError";
    }
}

const HISTORICAL_IMPORT_SUBMISSION_METHOD = "Historical Register Import";

export interface AgencyImportRecordResult {
    sourceRecordId: string;
    agencyName: string;
    permitNumber: string;
    county: string | null;
    status: AgencyImportRecordStatus;
    conflictReason?: string;
    isPubliclyBlocked: boolean;
}

export interface PersonnelImportRecordResult {
    sourceRecordId: string;
    name: string;
    sharedAgencyPermitNumber: string;
    candidateAgencySourceRecordId: string | null;
    status: "MATCHED" | "ADDED";
    requiresAgencyConfirmation: boolean;
    isPubliclyBlocked: boolean;
    note?: string;
}

export interface AgencyImportSummary {
    source: string;
    totalAgencySourceRecords: number;
    matchedAgencyCount: number;
    addedAgencyCount: number;
    conflictAgencyCount: number;
    agencyRecords: AgencyImportRecordResult[];

    totalPersonnelSourceRecords: number;
    matchedPersonnelCount: number;
    addedPersonnelCount: number;
    personnelRecords: PersonnelImportRecordResult[];

    conflicts: typeof AGENCY_CONFLICTS;

    // Staffing projection: since confirmedClerks is empty in the source
    // package, this is informational for the preview — every agency is
    // expected to show 0 of 1 Clerk regardless of Agent count.
    staffingProjection: Array<{ sourceRecordId: string; agencyName: string; projectedAgents: number; projectedClerks: number; meetsRequirement: boolean }>;
}

export class AgencyImportService {
    private static async assertNoOrphanedImports(manager: typeof AppDataSource | import("typeorm").EntityManager): Promise<void> {
        const orphanedAgencyCount = await manager
            .getRepository(Certificate)
            .createQueryBuilder("cert")
            .innerJoin(Application, "app", "app.id = cert.applicationId")
            .where("cert.permitOrLicenceType = :type", { type: "AGENCY" })
            .andWhere("app.submissionMethod = :method", { method: HISTORICAL_IMPORT_SUBMISSION_METHOD })
            .andWhere("cert.sourceRecordId IS NULL")
            .getCount();

        const orphanedPersonnelCount = await manager
            .getRepository(AgentPersonnel)
            .createQueryBuilder("p")
            .where("p.isHistoricalImport = true")
            .andWhere("p.sourceRecordId IS NULL")
            .getCount();

        if (orphanedAgencyCount > 0 || orphanedPersonnelCount > 0) {
            throw new AgencyImportIntegrityError(orphanedAgencyCount, orphanedPersonnelCount);
        }
    }

    private static conflictedPermitNumbers(): Set<string> {
        return new Set(AGENCY_SEED_DATA.filter((a) => a.reconciliationStatus === "requires_reconciliation").map((a) => a.permitNumberAsRecorded));
    }

    private static classifyAgencies(
        seedData: AgencySeedRecord[],
        existingBySourceId: Map<string, Certificate>
    ): { records: AgencyImportRecordResult[]; matchedCount: number; addedCount: number; conflictCount: number } {
        const records: AgencyImportRecordResult[] = seedData.map((rec) => {
            const alreadyImported = existingBySourceId.has(rec.sourceRecordId);
            const isConflict = rec.reconciliationStatus === "requires_reconciliation";

            let status: AgencyImportRecordStatus = alreadyImported ? "MATCHED" : "ADDED";
            let conflictReason: string | undefined;

            if (isConflict) {
                const matchingConflict = AGENCY_CONFLICTS.find((c) => c.permitNumber === rec.permitNumberAsRecorded);
                conflictReason = matchingConflict
                    ? `Agency name conflict on permit ${rec.permitNumberAsRecorded}: recorded as ${matchingConflict.namesAsRecorded.join(" / ")}. ${matchingConflict.evidence} ${matchingConflict.reviewAction}`
                    : `Permit ${rec.permitNumberAsRecorded} is flagged for staff reconciliation.`;
                if (!alreadyImported) status = "CONFLICT";
            }

            return {
                sourceRecordId: rec.sourceRecordId,
                agencyName: rec.agencyName,
                permitNumber: rec.permitNumberAsRecorded,
                county: rec.county,
                status,
                conflictReason,
                isPubliclyBlocked: isConflict,
            };
        });

        return {
            records,
            matchedCount: records.filter((r) => r.status === "MATCHED").length,
            addedCount: records.filter((r) => r.status === "ADDED").length,
            conflictCount: records.filter((r) => r.status === "CONFLICT").length,
        };
    }

    private static classifyPersonnel(
        seedData: AgentPersonnelSeedRecord[],
        existingBySourceId: Map<string, AgentPersonnel>,
        conflictedPermitNumbers: Set<string>
    ): { records: PersonnelImportRecordResult[]; matchedCount: number; addedCount: number } {
        const records: PersonnelImportRecordResult[] = seedData.map((rec) => {
            const alreadyImported = existingBySourceId.has(rec.sourceRecordId);
            const isPubliclyBlocked = conflictedPermitNumbers.has(rec.sharedAgencyPermitNumber);
            const requiresAgencyConfirmation = !rec.candidateAgencySourceRecordId;

            return {
                sourceRecordId: rec.sourceRecordId,
                name: rec.name,
                sharedAgencyPermitNumber: rec.sharedAgencyPermitNumber,
                candidateAgencySourceRecordId: rec.candidateAgencySourceRecordId,
                status: alreadyImported ? "MATCHED" : "ADDED",
                requiresAgencyConfirmation,
                isPubliclyBlocked,
                note: rec.notes || undefined,
            };
        });

        return {
            records,
            matchedCount: records.filter((r) => r.status === "MATCHED").length,
            addedCount: records.filter((r) => r.status === "ADDED").length,
        };
    }

    static async preview(options: { performedByUserId?: string | null; performedByName?: string | null; recordRun?: boolean } = {}): Promise<AgencyImportSummary> {
        await this.assertNoOrphanedImports(AppDataSource);

        const certificateRepository = AppDataSource.getRepository(Certificate);
        const personnelRepository = AppDataSource.getRepository(AgentPersonnel);

        const existingCertificates = await certificateRepository.find({ where: { permitOrLicenceType: ApplicationCategory.AGENCY } });
        const existingCertBySourceId = new Map<string, Certificate>();
        for (const c of existingCertificates) {
            if (c.sourceRecordId) existingCertBySourceId.set(c.sourceRecordId, c);
        }

        const existingPersonnel = await personnelRepository.find();
        const existingPersonnelBySourceId = new Map<string, AgentPersonnel>();
        for (const p of existingPersonnel) {
            if (p.sourceRecordId) existingPersonnelBySourceId.set(p.sourceRecordId, p);
        }

        const conflictedPermitNumbers = this.conflictedPermitNumbers();
        const agencyClassification = this.classifyAgencies(AGENCY_SEED_DATA, existingCertBySourceId);
        const personnelClassification = this.classifyPersonnel(AGENT_PERSONNEL_SEED_DATA, existingPersonnelBySourceId, conflictedPermitNumbers);

        // Staffing projection: how many of the (to-be-)imported Agents will
        // land under each Agency, purely for the preview — actual
        // staffingFlagged is computed for real inside apply().
        const agentCountByAgencySourceId = new Map<string, number>();
        for (const p of AGENT_PERSONNEL_SEED_DATA) {
            if (!p.candidateAgencySourceRecordId) continue;
            agentCountByAgencySourceId.set(p.candidateAgencySourceRecordId, (agentCountByAgencySourceId.get(p.candidateAgencySourceRecordId) || 0) + 1);
        }
        const staffingProjection = AGENCY_SEED_DATA.map((a) => {
            const projectedAgents = agentCountByAgencySourceId.get(a.sourceRecordId) || 0;
            const projectedClerks: number = 0; // confirmedClerks is empty in the source package — see class doc comment
            return {
                sourceRecordId: a.sourceRecordId,
                agencyName: a.agencyName,
                projectedAgents,
                projectedClerks,
                meetsRequirement: projectedAgents >= 3 && projectedClerks === 1,
            };
        });

        const summary: AgencyImportSummary = {
            source: AGENCY_IMPORT_SOURCE_LABEL,
            totalAgencySourceRecords: AGENCY_SEED_DATA.length,
            matchedAgencyCount: agencyClassification.matchedCount,
            addedAgencyCount: agencyClassification.addedCount,
            conflictAgencyCount: agencyClassification.conflictCount,
            agencyRecords: agencyClassification.records,
            totalPersonnelSourceRecords: AGENT_PERSONNEL_SEED_DATA.length,
            matchedPersonnelCount: personnelClassification.matchedCount,
            addedPersonnelCount: personnelClassification.addedCount,
            personnelRecords: personnelClassification.records,
            conflicts: AGENCY_CONFLICTS,
            staffingProjection,
        };

        if (options.recordRun) {
            await this.recordRun(summary, { isDryRun: true, performedByUserId: options.performedByUserId, performedByName: options.performedByName });
        }

        return summary;
    }

    static async apply(options: { performedByUserId?: string | null; performedByName?: string | null }): Promise<AgencyImportSummary> {
        const { summary, createdCertificateIds } = await AppDataSource.transaction(async (manager) => {
            await this.assertNoOrphanedImports(manager);

            const certificateRepository = manager.getRepository(Certificate);
            const applicationRepository = manager.getRepository(Application);
            const historyRepository = manager.getRepository(ApplicationStatusHistory);
            const personnelRepository = manager.getRepository(AgentPersonnel);

            const existingCertificates = await certificateRepository.find({ where: { permitOrLicenceType: ApplicationCategory.AGENCY } });
            const existingCertBySourceId = new Map<string, Certificate>();
            for (const c of existingCertificates) {
                if (c.sourceRecordId) existingCertBySourceId.set(c.sourceRecordId, c);
            }
            const existingPersonnel = await personnelRepository.find();
            const existingPersonnelBySourceId = new Map<string, AgentPersonnel>();
            for (const p of existingPersonnel) {
                if (p.sourceRecordId) existingPersonnelBySourceId.set(p.sourceRecordId, p);
            }

            const conflictedPermitNumbers = this.conflictedPermitNumbers();
            const agencyClassification = this.classifyAgencies(AGENCY_SEED_DATA, existingCertBySourceId);
            const personnelClassification = this.classifyPersonnel(AGENT_PERSONNEL_SEED_DATA, existingPersonnelBySourceId, conflictedPermitNumbers);

            // sourceRecordId -> newly-created (or already-existing) Certificate.id,
            // used to resolve historicalPersonnel's candidateAgencySourceRecordId
            // into a real agencyCertificateId below.
            const certificateIdBySourceId = new Map<string, string>(existingCertBySourceId.size ? Array.from(existingCertBySourceId.entries()).map(([k, v]) => [k, v.id]) : []);

            // ---- 1. Agencies ----
            for (let i = 0; i < AGENCY_SEED_DATA.length; i++) {
                const rec = AGENCY_SEED_DATA[i];
                const classified = agencyClassification.records[i];

                if (classified.status === "MATCHED") continue; // already imported — untouched

                const application = applicationRepository.create({
                    category: ApplicationCategory.AGENCY,
                    commodity: undefined,
                    channel: ApplicationChannel.OFFICE_ASSISTED,
                    submissionMethod: HISTORICAL_IMPORT_SUBMISSION_METHOD,
                    status: ApplicationStatus.ISSUED,
                    data: {
                        agency: {
                            legalName: rec.agencyName,
                            county: rec.county || "",
                        },
                    },
                    officeApplicantName: rec.agencyName,
                    enteringOfficerName: options.performedByName || "System Import",
                    enteringOfficerUserId: options.performedByUserId || undefined,
                    assistedEntryReason: "Backfilled from the historical LACRA Agency Register (pre-dates the CMIS Application workflow).",
                    applicantConsentConfirmed: false,
                    submittedByUserId: options.performedByUserId || undefined,
                    submittedAt: rec.issuedOn ? new Date(rec.issuedOn) : undefined,
                });
                await applicationRepository.save(application);

                const isConflict = classified.isPubliclyBlocked;
                const certificate = certificateRepository.create({
                    applicationId: application.id,
                    permitOrLicenceType: ApplicationCategory.AGENCY,
                    certificateNumber: isConflict ? undefined : rec.permitNumberAsRecorded,
                    stagedPermitNumber: isConflict ? rec.permitNumberAsRecorded : null,
                    issueDate: rec.issuedOn ? new Date(rec.issuedOn) : undefined,
                    expiryDate: rec.expiresOn ? new Date(rec.expiresOn) : undefined,
                    verificationToken: isConflict ? null : cryptoRandomUUID(),
                    buyerDisplayName: rec.agencyName,
                    county: rec.county,
                    locality: null,
                    isPubliclyBlocked: isConflict,
                    publicBlockReason: classified.conflictReason || null,
                    sourceRecordId: rec.sourceRecordId,
                    isHistoricalImport: true,
                    importRawData: {
                        countyEvidence: rec.countyEvidence,
                        historicalQr: rec.historicalQr,
                        importedAt: new Date().toISOString(),
                    },
                    printedByUserId: options.performedByUserId || undefined,
                    printedByName: options.performedByName || "System Import",
                    printedAt: new Date(),
                    issuedAt: rec.issuedOn ? new Date(rec.issuedOn) : new Date(),
                });
                await certificateRepository.save(certificate);
                certificateIdBySourceId.set(rec.sourceRecordId, certificate.id);

                await historyRepository.save(historyRepository.create({
                    applicationId: application.id,
                    action: "HISTORICAL_IMPORT",
                    previousStatus: undefined,
                    newStatus: ApplicationStatus.ISSUED,
                    userId: options.performedByUserId || undefined,
                    userName: options.performedByName || "System Import",
                    role: "System Import",
                    comments: `Backfilled from the historical LACRA Agency Register (source record ${rec.sourceRecordId}, permit ${rec.permitNumberAsRecorded}).${isConflict ? " HELD pending staff reconciliation of a conflicting Agency name recorded under this permit number — see Certificate.publicBlockReason." : ""} This is a historical record, not a live CMIS approval — no verification/approval/payment workflow was run.`,
                }));
            }

            // ---- 2. Historical Agent personnel ----
            for (let i = 0; i < AGENT_PERSONNEL_SEED_DATA.length; i++) {
                const rec = AGENT_PERSONNEL_SEED_DATA[i];
                const classified = personnelClassification.records[i];

                if (classified.status === "MATCHED") continue; // already imported — untouched

                const linkedCertificateId = rec.candidateAgencySourceRecordId
                    ? certificateIdBySourceId.get(rec.candidateAgencySourceRecordId) || null
                    : null;

                const person = personnelRepository.create({
                    agencyCertificateId: linkedCertificateId,
                    role: AgentPersonnelRole.AGENT,
                    fullName: rec.name,
                    permitNumber: rec.sharedAgencyPermitNumber,
                    county: rec.countyAsRecorded,
                    status: AgentPersonnelStatus.ACTIVE,
                    appointedAt: rec.agentRecordIssuedOn ? new Date(rec.agentRecordIssuedOn) : null,
                    verificationToken: classified.isPubliclyBlocked ? null : cryptoRandomUUID(),
                    isPubliclyBlocked: classified.isPubliclyBlocked,
                    publicBlockReason: classified.isPubliclyBlocked
                        ? `Shared permit number ${rec.sharedAgencyPermitNumber} is part of an Agency-name conflict pending staff reconciliation — held pending resolution.`
                        : null,
                    requiresAgencyConfirmation: classified.requiresAgencyConfirmation,
                    sourceRecordId: rec.sourceRecordId,
                    isHistoricalImport: true,
                    importRawData: {
                        agencyNameAsRecorded: rec.agencyNameAsRecorded,
                        agentRecordExpiresOn: rec.agentRecordExpiresOn,
                        notes: rec.notes,
                        historicalQr: rec.historicalQr || null,
                        importedAt: new Date().toISOString(),
                    },
                    historyLog: [
                        {
                            action: "HISTORICAL_IMPORT",
                            date: new Date().toISOString(),
                            note: classified.requiresAgencyConfirmation
                                ? `Backfilled from the historical Agency Register (source record ${rec.sourceRecordId}). No candidate parent Agency was recorded — left unassigned pending LACRA confirmation.`
                                : `Backfilled from the historical Agency Register (source record ${rec.sourceRecordId}), linked to Agency source record ${rec.candidateAgencySourceRecordId}.`,
                            performedByName: options.performedByName || "System Import",
                        },
                    ],
                });
                await personnelRepository.save(person);
            }

            return { summary: { agencyClassification, personnelClassification }, createdCertificateIds: Array.from(certificateIdBySourceId.values()) };
        });

        // ---- 3. Recompute staffing flags for every imported Agency ----
        // Run AFTER the transaction commits so computeAndRefreshStaffingFlag
        // (which does its own repository reads/writes) sees the just-created
        // AgentPersonnel rows. Every one of the 11 is expected to come out
        // staffingFlagged=true since confirmedClerks is empty in the source
        // package — see class doc comment.
        for (const certId of createdCertificateIds) {
            await computeAndRefreshStaffingFlag(AppDataSource, certId);
        }

        const fullSummary: AgencyImportSummary = {
            source: AGENCY_IMPORT_SOURCE_LABEL,
            totalAgencySourceRecords: AGENCY_SEED_DATA.length,
            matchedAgencyCount: summary.agencyClassification.matchedCount,
            addedAgencyCount: summary.agencyClassification.addedCount,
            conflictAgencyCount: summary.agencyClassification.conflictCount,
            agencyRecords: summary.agencyClassification.records,
            totalPersonnelSourceRecords: AGENT_PERSONNEL_SEED_DATA.length,
            matchedPersonnelCount: summary.personnelClassification.matchedCount,
            addedPersonnelCount: summary.personnelClassification.addedCount,
            personnelRecords: summary.personnelClassification.records,
            conflicts: AGENCY_CONFLICTS,
            staffingProjection: [],
        };

        await this.recordRun(fullSummary, { isDryRun: false, performedByUserId: options.performedByUserId, performedByName: options.performedByName });
        return fullSummary;
    }

    private static async recordRun(summary: AgencyImportSummary, options: { isDryRun: boolean; performedByUserId?: string | null; performedByName?: string | null }) {
        const importRunRepository = AppDataSource.getRepository(AgencyImportRun);
        const run = importRunRepository.create({
            source: summary.source,
            isDryRun: options.isDryRun,
            performedByUserId: options.performedByUserId || null,
            performedByName: options.performedByName || null,
            matchedAgencyCount: summary.matchedAgencyCount,
            addedAgencyCount: summary.addedAgencyCount,
            conflictAgencyCount: summary.conflictAgencyCount,
            totalAgencySourceRecords: summary.totalAgencySourceRecords,
            matchedPersonnelCount: summary.matchedPersonnelCount,
            addedPersonnelCount: summary.addedPersonnelCount,
            totalPersonnelSourceRecords: summary.totalPersonnelSourceRecords,
            detailsJson: JSON.stringify({ agencyRecords: summary.agencyRecords, personnelRecords: summary.personnelRecords, conflicts: summary.conflicts }),
        });
        await importRunRepository.save(run);
    }

    static async getImportRuns(): Promise<AgencyImportRun[]> {
        const importRunRepository = AppDataSource.getRepository(AgencyImportRun);
        return importRunRepository.find({ order: { createdAt: "DESC" }, take: 50 });
    }
}

function cryptoRandomUUID(): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("crypto").randomUUID();
}
