/**
 * exporterRegisterSeedData.ts — verbatim transcription of the authorized
 * historical Exporter Register batch (12 records) provided directly by the
 * project owner for the staging import preview. The raw authorization
 * source is kept OUTSIDE this git repository
 * (/home/user/.secure_env/exporter_register_source.json on the sandbox
 * used to prepare this feature) — only this hand-transcribed TypeScript
 * file is ever committed, exactly like
 * src/data/localProduceBuyerSeedData.ts and
 * src/data/agencyRegisterSeedData.ts before it.
 *
 * Every string value below (exporterName, licenseNumber, dates) is copied
 * EXACTLY as provided — including the non-zero-padded license numbers
 * (01, 06, 20, 26, 29, 39, 40, 41) alongside the zero-padded ones (030,
 * 033, 037, 044), and the unique "EXPO" prefix on Substantial Trade Group
 * of Companies's license (LACRA-EXPO-033-2026) vs every other record's
 * "EXP" prefix. Do not "fix"/normalize this formatting anywhere — license
 * numbers are matched and displayed as exact strings, never parsed as
 * integers or re-padded.
 *
 * sourceRecordId values are this batch's own stable per-record IDs — the
 * idempotency key ExporterImportService matches against on every re-run,
 * not the license number (which must be preserved verbatim but is never
 * used as the upsert key, consistent with every prior register import).
 *
 * Meridian Commodity Inc. (MCI) — county conflict (per the approved
 * decision, mirrors the Local Produce Buyer/Agency conflict-handling
 * pattern): the earlier overview lists Montserrado for the whole batch,
 * but Meridian's own historical QR says Nimba County. This record imports
 * with isPubliclyBlocked=true (its public QR is disabled until staff
 * resolve the discrepancy) and BOTH county candidates are preserved —
 * `county` holds the overview's Montserrado value (the batch default),
 * `disputedCounty` holds the QR's Nimba value — see
 * ExporterImportService and Certificate.disputedCounty.
 */

export const EXPORTER_IMPORT_SOURCE_LABEL =
    "LACRA Exporter Register — authorized historical batch (12 records), provided directly by the project owner for staging import preview";

// The county recorded in the batch-level overview for every record that
// does not have its own explicit countyConflict entry (per the user's
// "the earlier overview lists Montserrado for the batch" statement).
export const EXPORTER_DEFAULT_COUNTY = "Montserrado";

export interface ExporterCountyConflict {
    overviewCounty: string;
    historicalQrCounty: string;
    note: string;
}

export interface ExporterSeedRecord {
    sourceRecordId: string;
    exporterName: string;
    licenseNumber: string;
    issuedOn: string; // ISO date
    expiresOn: string; // ISO date
    countyConflict: ExporterCountyConflict | null;
}

export const EXPORTER_SEED_DATA: ExporterSeedRecord[] = [
    {
        sourceRecordId: "LACRA-EXPORTER-HIST-001",
        exporterName: "Cocoa Ventures LLC",
        licenseNumber: "LACRA-EXP-01-2026",
        issuedOn: "2026-05-27",
        expiresOn: "2027-05-26",
        countyConflict: null,
    },
    {
        sourceRecordId: "LACRA-EXPORTER-HIST-002",
        exporterName: "Zeno Industries Inc.",
        licenseNumber: "LACRA-EXP-06-2026",
        issuedOn: "2026-06-25",
        expiresOn: "2027-06-24",
        countyConflict: null,
    },
    {
        sourceRecordId: "LACRA-EXPORTER-HIST-003",
        exporterName: "Societe De-Negoce Agricole",
        licenseNumber: "LACRA-EXP-20-2026",
        issuedOn: "2025-12-17",
        expiresOn: "2026-12-16",
        countyConflict: null,
    },
    {
        sourceRecordId: "LACRA-EXPORTER-HIST-004",
        exporterName: "Global Development Logistics Companies",
        licenseNumber: "LACRA-EXP-26-2026",
        issuedOn: "2026-07-22",
        expiresOn: "2027-07-21",
        countyConflict: null,
    },
    {
        sourceRecordId: "LACRA-EXPORTER-HIST-005",
        exporterName: "Liberia Company of Cocoa & Coffee (L3C)",
        licenseNumber: "LACRA-EXP-29-2026",
        issuedOn: "2026-06-25",
        expiresOn: "2027-06-24",
        countyConflict: null,
    },
    {
        sourceRecordId: "LACRA-EXPORTER-HIST-006",
        exporterName: "Aftrade Inc.",
        licenseNumber: "LACRA-EXP-030-2026",
        issuedOn: "2026-06-20",
        expiresOn: "2027-06-19",
        countyConflict: null,
    },
    {
        sourceRecordId: "LACRA-EXPORTER-HIST-007",
        exporterName: "Substantial Trade Group of Companies",
        // Deliberately "EXPO" (not "EXP") — unique to this record, per the
        // explicit instruction to preserve this exact prefix.
        licenseNumber: "LACRA-EXPO-033-2026",
        issuedOn: "2026-05-27",
        expiresOn: "2027-05-26",
        countyConflict: null,
    },
    {
        sourceRecordId: "LACRA-EXPORTER-HIST-008",
        exporterName: "Cocoa World Incorporated",
        licenseNumber: "LACRA-EXP-037-2026",
        issuedOn: "2026-02-24",
        expiresOn: "2027-02-23",
        countyConflict: null,
    },
    {
        sourceRecordId: "LACRA-EXPORTER-HIST-009",
        exporterName: "Soul Group Incorporated",
        licenseNumber: "LACRA-EXP-39-2026",
        issuedOn: "2026-07-08",
        expiresOn: "2027-07-07",
        countyConflict: null,
    },
    {
        sourceRecordId: "LACRA-EXPORTER-HIST-010",
        exporterName: "MOH-KCA Group of Companies",
        licenseNumber: "LACRA-EXP-40-2026",
        issuedOn: "2026-07-13",
        expiresOn: "2027-07-12",
        countyConflict: null,
    },
    {
        sourceRecordId: "LACRA-EXPORTER-HIST-011",
        exporterName: "Meawon Liberia Inc.",
        licenseNumber: "LACRA-EXP-41-2026",
        issuedOn: "2026-07-17",
        expiresOn: "2027-07-16",
        countyConflict: null,
    },
    {
        sourceRecordId: "LACRA-EXPORTER-HIST-012",
        exporterName: "Meridian Commodity Inc. (MCI)",
        licenseNumber: "LACRA-EXP-044-2026",
        issuedOn: "2026-10-20",
        expiresOn: "2027-10-19",
        countyConflict: {
            overviewCounty: "Montserrado",
            historicalQrCounty: "Nimba",
            note:
                "Earlier batch overview lists Montserrado county; this exporter's own historical QR says Nimba County. " +
                "Held for staff confirmation of the correct county — public QR disabled until resolved. Both candidate " +
                "county values are preserved (Certificate.county = Montserrado, Certificate.disputedCounty = Nimba).",
        },
    },
];
