-- Phase 2: Local Produce Buyer Register — production migration.
-- Generated to match exactly what TypeORM `synchronize: true` created in
-- local staging (verified column-for-column against eudr_db). Proposed
-- for review ONLY — NOT applied to production. Does not touch any
-- existing table/column other than adding new, nullable columns to
-- `certificate` (safe, backwards-compatible with existing rows/readers).

BEGIN;

-- 1. New columns on the existing `certificate` table.
ALTER TABLE certificate
    ADD COLUMN IF NOT EXISTS "verificationToken" character varying,
    ADD COLUMN IF NOT EXISTS "buyerDisplayName" character varying,
    ADD COLUMN IF NOT EXISTS "county" character varying,
    ADD COLUMN IF NOT EXISTS "locality" character varying,
    ADD COLUMN IF NOT EXISTS "predecessorCertificateId" uuid,
    ADD COLUMN IF NOT EXISTS "agencyCertificateId" uuid,
    ADD COLUMN IF NOT EXISTS "isPubliclyBlocked" boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "publicBlockReason" text,
    ADD COLUMN IF NOT EXISTS "stagedPermitNumber" character varying,
    ADD COLUMN IF NOT EXISTS "sourceRecordId" character varying,
    ADD COLUMN IF NOT EXISTS "isHistoricalImport" boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "importRawData" jsonb;

-- 2. Uniqueness constraints (verificationToken, sourceRecordId) — NOTE the
--    pre-existing UNIQUE constraint on certificateNumber is untouched and
--    is NOT relaxed, per the approved decision.
ALTER TABLE certificate
    ADD CONSTRAINT "UQ_certificate_verificationToken" UNIQUE ("verificationToken");
ALTER TABLE certificate
    ADD CONSTRAINT "UQ_certificate_sourceRecordId" UNIQUE ("sourceRecordId");

-- 3. Self-referencing foreign keys for renewal chain and agency linkage.
ALTER TABLE certificate
    ADD CONSTRAINT "FK_certificate_predecessorCertificateId"
        FOREIGN KEY ("predecessorCertificateId") REFERENCES certificate(id);
ALTER TABLE certificate
    ADD CONSTRAINT "FK_certificate_agencyCertificateId"
        FOREIGN KEY ("agencyCertificateId") REFERENCES certificate(id);

-- 4. New tables.
CREATE TABLE IF NOT EXISTS local_produce_buyer_sequence (
    id integer PRIMARY KEY DEFAULT 1,
    "lastNumber" integer NOT NULL DEFAULT 0,
    "updatedAt" timestamp without time zone
);

CREATE TABLE IF NOT EXISTS local_produce_buyer_import_run (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    source character varying NOT NULL,
    "isDryRun" boolean NOT NULL DEFAULT false,
    "performedByUserId" character varying,
    "performedByName" character varying,
    "matchedCount" integer NOT NULL DEFAULT 0,
    "addedCount" integer NOT NULL DEFAULT 0,
    "conflictCount" integer NOT NULL DEFAULT 0,
    "totalSourceRecords" integer NOT NULL DEFAULT 0,
    "detailsJson" text,
    "createdAt" timestamp without time zone NOT NULL DEFAULT now()
);

-- 5. Seed the sequence row (idempotent) — allocateNext()/ensureMinimum()
--    also self-initialise defensively if this is ever skipped, but seeding
--    it explicitly here means the row exists before first app boot.
INSERT INTO local_produce_buyer_sequence (id, "lastNumber", "updatedAt")
VALUES (1, 0, now())
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- NOTE: This migration does NOT run the historical 83-record import.
-- The import is a separate, explicit, idempotent application-level step
-- (LocalProduceBuyerImportService.apply(), exposed as
-- POST /api/local-produce-buyers/import/apply, ADMIN-only) that must be
-- run manually by staff AFTER this schema migration and AFTER reviewing
-- the dry-run reconciliation report — per the explicit review gate agreed
-- with the project owner. Do not fold the import into this migration.
