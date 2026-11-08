/**
 * agencyRegisterSeedData.ts — verbatim transcription of
 * LACRA_Agency_Register_Source.zip's agency_register.json, compiled by
 * the project owner for staff reconciliation (11 Agency rows, 7
 * historical Agent entries, 2 flagged permit-number/name conflicts, 5
 * people excluded from the Local Produce Buyer import pending Agency
 * confirmation). See AgencyImportService for how this is reconciled into
 * Certificate + AgentPersonnel rows.
 *
 * Every string value below (agencyName, permitNumberAsRecorded, dates,
 * county, notes) is copied EXACTLY as it appears in the source JSON —
 * including the non-zero-padded permit numbers (36, 38, 39) the source
 * README explicitly instructs must be preserved, not normalized. Do not
 * "fix" formatting here; any correction belongs in the staff
 * conflict-resolution workflow, not in the seed data itself.
 *
 * sourceRecordId values are the package's own "stable source IDs for
 * repeat imports" (sourceIdPolicy in the JSON) — these are the
 * idempotency keys AgencyImportService matches against, not permit
 * numbers (which can legitimately collide — see the two conflicts below
 * — and are not guaranteed unique in this source data).
 */

export const AGENCY_IMPORT_SOURCE_LABEL =
    "LACRA_Agency_Register_Source.zip (agency_register.json, schemaVersion 1) — 11 Agency rows + 7 historical Agent entries, staff-reconciliation package";

export interface AgencySeedRecord {
    sourceRecordId: string;
    agencyName: string;
    county: string | null;
    countyEvidence: string | null;
    permitNumberAsRecorded: string;
    issuedOn: string | null; // ISO date, nullable
    expiresOn: string | null; // ISO date, nullable
    reconciliationStatus: "unreviewed" | "requires_reconciliation";
    historicalQr: { file: string; sha256: string };
}

export const AGENCY_SEED_DATA: AgencySeedRecord[] = [
    {
        sourceRecordId: "LACRA-AGENCY-HIST-001",
        agencyName: "Konmana Cocoa Corporation Inc.",
        county: null,
        countyEvidence: null,
        permitNumberAsRecorded: "LACRA-AGN-001-2026",
        issuedOn: "2026-02-04",
        expiresOn: "2027-02-03",
        reconciliationStatus: "unreviewed",
        historicalQr: { file: "agency_qr/Konmana_Cocoa_Corporation_Agency_Permit_QR_Code.png", sha256: "ab9d04c50bb099ca2b97ea07e498d404e2ccbccf309e84a2bb94840ee24c1d40" },
    },
    {
        sourceRecordId: "LACRA-AGENCY-HIST-002",
        agencyName: "Monleh Incorporated",
        county: "Nimba",
        countyEvidence: "agency_register",
        permitNumberAsRecorded: "LACRA-AGN-007-2026",
        issuedOn: "2026-08-20",
        expiresOn: "2027-08-19",
        reconciliationStatus: "unreviewed",
        historicalQr: { file: "agency_qr/Monleh_Incorporated_AGN_007_2026_QR.png", sha256: "bd0bdc84ea3119b280f3d8e4792b0b47a7bda8ae826e2352e1a88129ed3e4db5" },
    },
    {
        sourceRecordId: "LACRA-AGENCY-HIST-003",
        agencyName: "David & Abenego Farmers Corporation",
        county: "Grand Gedeh",
        countyEvidence: "agency_register",
        permitNumberAsRecorded: "LACRA-AGN-015-2026",
        issuedOn: "2026-10-19",
        expiresOn: "2027-10-18",
        reconciliationStatus: "unreviewed",
        historicalQr: { file: "agency_qr/David_Abenego_Lacra_AGN_015_2026_QR.png", sha256: "ed417ca0db2ff5cd65212f50ae1d5a409ba18902b0a736a1361a4f878201a016" },
    },
    {
        sourceRecordId: "LACRA-AGENCY-HIST-004",
        agencyName: "ID Cocoa Incorporated",
        county: "Grand Gedeh",
        countyEvidence: "agency_register",
        permitNumberAsRecorded: "LACRA-AGN-030-2026",
        issuedOn: "2026-10-10",
        expiresOn: "2027-10-09",
        reconciliationStatus: "requires_reconciliation",
        historicalQr: { file: "agency_qr/ID_Cocoa_Lacra_AGN_030_2026_QR.png", sha256: "7101027f429e561cab7fe65b22987ae4367afdb3734da584da406e204333da38" },
    },
    {
        sourceRecordId: "LACRA-AGENCY-HIST-005",
        agencyName: "Massany Corporation",
        county: "Grand Gedeh",
        countyEvidence: "earlier_agency_record",
        permitNumberAsRecorded: "LACRA-AGN-36-2026",
        issuedOn: "2026-04-14",
        expiresOn: "2027-04-13",
        reconciliationStatus: "unreviewed",
        historicalQr: { file: "agency_qr/lacra_massany_qr.png", sha256: "84e3b16a8e56c438c9b48e94ccdc0e48162408f8973c42d61f897100f04cf76e" },
    },
    {
        sourceRecordId: "LACRA-AGENCY-HIST-006",
        agencyName: "Otsego Trading Group of Companies, Inc.",
        county: null,
        countyEvidence: null,
        permitNumberAsRecorded: "LACRA-AGN-037-2026",
        issuedOn: null,
        expiresOn: "2027-05-06",
        reconciliationStatus: "unreviewed",
        historicalQr: { file: "agency_qr/otsego_agency_huge_qr.png", sha256: "17c615c4f93d73d43fc8e03995fa9c40971b77ba2f4fb278b3db83306c9d7612" },
    },
    {
        sourceRecordId: "LACRA-AGENCY-HIST-007",
        agencyName: "Daniel Saryee Corporation",
        county: null,
        countyEvidence: null,
        permitNumberAsRecorded: "LACRA-AGN-38-2026",
        issuedOn: "2026-06-25",
        expiresOn: "2027-06-24",
        reconciliationStatus: "unreviewed",
        historicalQr: { file: "agency_qr/daniel_saryee_agency_qr_v2.png", sha256: "f16dc098517c68fbe915b16cf7cfcc7054d5a2e17b72124389a95515cc287841" },
    },
    {
        sourceRecordId: "LACRA-AGENCY-HIST-008",
        agencyName: "Choice Cocoa Buying Agency",
        county: "Nimba",
        countyEvidence: "agent_record",
        permitNumberAsRecorded: "LACRA-AGN-39-2026",
        issuedOn: "2026-07-14",
        expiresOn: "2027-07-13",
        reconciliationStatus: "unreviewed",
        historicalQr: { file: "agency_qr/Choice_Cocoa_Buying_Agency_Agency_Permit_QR.png", sha256: "d6b1a21f334111976cf69c5e74a6af8f4021f997310db5e922ca5618227a530c" },
    },
    {
        sourceRecordId: "LACRA-AGENCY-HIST-009",
        agencyName: "Salaams Trading LLC",
        county: "Grand Gedeh",
        countyEvidence: "agency_register",
        permitNumberAsRecorded: "LACRA-AGN-041-2026",
        issuedOn: "2026-08-31",
        expiresOn: "2027-08-30",
        reconciliationStatus: "requires_reconciliation",
        historicalQr: { file: "agency_qr/Salaams_Trading_LLC_AGN_041_2026_QR.png", sha256: "1f3e2ffc7345a9c4e0d425024355024df68e1f25bfd50c47a84b4ea1b58ec857" },
    },
    {
        sourceRecordId: "LACRA-AGENCY-HIST-010",
        agencyName: "Jeko Organic Inc.",
        county: "Grand Gedeh",
        countyEvidence: "agency_register",
        permitNumberAsRecorded: "LACRA-AGN-042-2026",
        issuedOn: "2026-09-09",
        expiresOn: "2027-09-02",
        reconciliationStatus: "unreviewed",
        historicalQr: { file: "agency_qr/Jeko_Organic_Inc_Agency_042_QR.png", sha256: "d55e8758dd1d3431783595280634dfa12670c3af8720ef4592dd75908379f0be" },
    },
    {
        sourceRecordId: "LACRA-AGENCY-HIST-011",
        agencyName: "Abdullah Kenneh Enterprise",
        county: "Montserrado",
        countyEvidence: "agency_register",
        permitNumberAsRecorded: "LACRA-AGN-044-2026",
        issuedOn: "2026-10-08",
        expiresOn: "2027-10-07",
        reconciliationStatus: "unreviewed",
        historicalQr: { file: "agency_qr/Abdullah_Kenneh_Lacra_AGN_044_2026_QR.png", sha256: "18a21613a802903d0932fb4687775766f06a02b5386948225d5cf669fc6713bf" },
    },
];

export interface AgentPersonnelSeedRecord {
    sourceRecordId: string;
    name: string;
    agencyNameAsRecorded: string;
    sharedAgencyPermitNumber: string;
    countyAsRecorded: string | null;
    agentRecordIssuedOn: string | null;
    agentRecordExpiresOn: string | null;
    candidateAgencySourceRecordId: string | null; // null = genuinely unassigned pending LACRA confirmation
    notes: string | null;
    historicalQr?: { file: string; sha256: string };
}

export const AGENT_PERSONNEL_SEED_DATA: AgentPersonnelSeedRecord[] = [
    {
        sourceRecordId: "LACRA-AGENT-HIST-001",
        name: "Darlington Gboi",
        agencyNameAsRecorded: "Monleh Incorporated",
        sharedAgencyPermitNumber: "LACRA-AGN-007-2026",
        countyAsRecorded: "Grand Gedeh",
        agentRecordIssuedOn: "2026-10-08",
        agentRecordExpiresOn: "2027-10-07",
        candidateAgencySourceRecordId: "LACRA-AGENCY-HIST-002",
        notes: null,
    },
    {
        sourceRecordId: "LACRA-AGENT-HIST-002",
        name: "T. Abraham Browne",
        agencyNameAsRecorded: "ID Cocoa Incorporated",
        sharedAgencyPermitNumber: "LACRA-AGN-030-2026",
        countyAsRecorded: "Grand Gedeh",
        agentRecordIssuedOn: "2026-10-30",
        agentRecordExpiresOn: "2027-10-29",
        candidateAgencySourceRecordId: "LACRA-AGENCY-HIST-004",
        notes: "Permit 030 has a recorded Agency-name discrepancy.",
        historicalQr: { file: "agent_qr/T_Abraham_Browne_Agency_030_QR.png", sha256: "6bbf472bc2f7791a82412045b7ee140601831e4957eab96a971d4ee64fa70da7" },
    },
    {
        sourceRecordId: "LACRA-AGENT-HIST-003",
        name: "Ousmane Sow",
        agencyNameAsRecorded: "Cocoa Incorporated",
        sharedAgencyPermitNumber: "LACRA-AGN-030-2026",
        countyAsRecorded: "Grand Gedeh",
        agentRecordIssuedOn: "2026-10-22",
        agentRecordExpiresOn: "2027-10-21",
        candidateAgencySourceRecordId: null,
        notes: "Confirm whether Cocoa Incorporated and ID Cocoa Incorporated are the same entity before linking.",
        historicalQr: { file: "agent_qr/Ousmane_Sow_Agency_030_QR.png", sha256: "356dab74bed6ce7ea0c2e2ac306976bd947b3fe84b14ed79a4cd97d8ceb71bd2" },
    },
    {
        sourceRecordId: "LACRA-AGENT-HIST-004",
        name: "Abraham B. Konneh",
        agencyNameAsRecorded: "Massany Corporation",
        sharedAgencyPermitNumber: "LACRA-AGN-36-2026",
        countyAsRecorded: "Grand Gedeh",
        agentRecordIssuedOn: "2026-04-14",
        agentRecordExpiresOn: null, // source states "2927" — clearly erroneous, left blank per instruction
        candidateAgencySourceRecordId: "LACRA-AGENCY-HIST-005",
        notes: "Original Agent entry states an expiry year of 2927. Agent expiry needs confirmation.",
    },
    {
        sourceRecordId: "LACRA-AGENT-HIST-005",
        name: "Melvin B. Kebby",
        agencyNameAsRecorded: "Choice Cocoa Buying Agency",
        sharedAgencyPermitNumber: "LACRA-AGN-39-2026",
        countyAsRecorded: "Nimba",
        agentRecordIssuedOn: "2026-09-30",
        agentRecordExpiresOn: "2027-09-29",
        candidateAgencySourceRecordId: "LACRA-AGENCY-HIST-008",
        notes: null,
    },
    {
        sourceRecordId: "LACRA-AGENT-HIST-006",
        name: "Larry Clark",
        agencyNameAsRecorded: "Salaam",
        sharedAgencyPermitNumber: "LACRA-AGN-041-2026",
        countyAsRecorded: "Grand Gedeh",
        agentRecordIssuedOn: "2026-08-31",
        agentRecordExpiresOn: null, // source states expiry before issue date — left blank pending confirmation
        candidateAgencySourceRecordId: null,
        notes: "Agent record states expiry 30 August 2026, before issue. Confirm date and parent Agency for permit 041.",
    },
    {
        sourceRecordId: "LACRA-AGENT-HIST-007",
        name: "Sekou K. Sheriff",
        agencyNameAsRecorded: "Salam",
        sharedAgencyPermitNumber: "LACRA-AGN-041-2026",
        countyAsRecorded: "Grand Gedeh",
        agentRecordIssuedOn: "2026-08-31",
        agentRecordExpiresOn: "2027-08-30",
        candidateAgencySourceRecordId: null,
        notes: "Confirm parent Agency for permit 041.",
    },
];

export interface AgencyConflict {
    permitNumber: string;
    namesAsRecorded: string[];
    evidence: string;
    reviewAction: string;
}

export const AGENCY_CONFLICTS: AgencyConflict[] = [
    {
        permitNumber: "LACRA-AGN-030-2026",
        namesAsRecorded: ["ID Cocoa Incorporated", "Cocoa Incorporated"],
        evidence:
            "The Agency certificate QR identifies ID Cocoa Incorporated. The Ousmane Sow Agent QR identifies Cocoa Incorporated. The T. Abraham Browne Agent QR identifies ID Cocoa Incorporated. All carry permit 030.",
        reviewAction: "Confirm the legal Agency identity and Agent affiliation before public verification.",
    },
    {
        permitNumber: "LACRA-AGN-041-2026",
        namesAsRecorded: ["Salaams Trading LLC", "Eric & Karbore Farmers Enterprise Inc."],
        evidence:
            "The later Agency register and saved Agency QR identify Salaams Trading LLC. An earlier record identifies Eric & Karbore Farmers Enterprise Inc., Grand Gedeh, issued 2026-08-18, expires 2027-08-17, under the same number.",
        reviewAction: "Confirm the correct holder and Agent affiliations before public verification.",
    },
];

// The five Local Produce Buyer register people excluded from that earlier
// import pending confirmation of which Agency (if any) they belong to.
// Carried forward here, untouched, purely for cross-reference on the
// Agency import's preview screen — this importer creates NO records for
// these five names; they remain exactly as the LPB import already left
// them (unassigned, LOCAL_BUYER-category, not linked to any Agency).
export const EXCLUDED_LOCAL_PRODUCE_BUYER_NAMES_UNASSIGNED: string[] = [
    "Jonathan B. Davis",
    "Lawrence P. Smith",
    "Moses A. Diapleh",
    "Prosper G. Cooper",
    "Vivian Z. N. Yarbah",
];
