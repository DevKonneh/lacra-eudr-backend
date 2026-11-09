-- Phase 4: Exporter Register — staging migration (UP).
--
-- Status: PROPOSED FOR REVIEW. NOT applied to production.
--
-- Adds the schema needed for the Exporter Register feature (Exporters,
-- under Licensing & Permits, directly below Agencies):
--
-- 1. One new, nullable, additive column on `certificate`
--    (`disputedCounty`) — every other column the Exporter Register needs
--    (verificationToken, buyerDisplayName, county, isPubliclyBlocked,
--    publicBlockReason, stagedPermitNumber, sourceRecordId,
--    isHistoricalImport, importRawData, logoUrl) already exists from the
--    2028/2029/2030 migrations and is reused as-is for Exporter
--    certificates — permitOrLicenceType = 'EXPORTER' is what distinguishes
--    them from Local Produce Buyer / Agency rows.
-- 2. One new table: `exporter_import_run` (audit trail of every
--    preview/apply import run, mirroring local_produce_buyer_import_run
--    and agency_import_run).
-- 3. No existing column is altered or dropped; all existing rows remain
--    valid with the new `certificate.disputedCounty` column at its
--    default (NULL).
--
-- Generated to match exactly what TypeORM `synchronize: true` would
-- create — verified column-for-column against a disposable copy of
-- eudr_db (eudr_migration_test_2032, created via `createdb -T eudr_db`),
-- with DB_SYNCHRONIZE=false set so this file itself — not synchronize —
-- is what was tested, consistent with every prior migration in this
-- series.
--
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2032_exporter_register/up.sql

BEGIN;

-- 1. New column on the existing `certificate` table.
ALTER TABLE certificate
    ADD COLUMN IF NOT EXISTS "disputedCounty" character varying;

-- 2. New table: exporter_import_run — audit trail of every Exporter
--    Register preview/apply import run.
CREATE TABLE IF NOT EXISTS exporter_import_run (
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

COMMIT;

-- NOTE: This migration does NOT run the historical 12-record Exporter
-- import. The import is a separate, explicit, idempotent application-level
-- step (ExporterImportService.apply(), exposed as
-- POST /api/exporters/import/apply, ADMIN-only) that must be run manually
-- by staff AFTER this schema migration and AFTER reviewing the dry-run
-- reconciliation report — per the same explicit review gate used for the
-- 2028 Local Produce Buyer and 2029 Agency imports. Do not fold the import
-- into this migration.
--
-- NOTE: Per the project owner's explicit instruction, this migration (and
-- the subsequent import apply) must be run on STAGING ONLY and reviewed
-- (staging link, screenshots, import preview results) before anything is
-- applied to production.
