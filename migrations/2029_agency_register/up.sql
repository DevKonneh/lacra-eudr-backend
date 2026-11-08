-- Phase 3: Agency Register — staging migration (UP).
--
-- Status: PROPOSED FOR REVIEW. NOT applied to production.
--
-- Generated to match exactly what TypeORM `synchronize: true` would
-- create (verified column-for-column against a disposable copy of
-- eudr_db, eudr_db_agency_staging, with DB_SYNCHRONIZE=false set so this
-- file itself — not synchronize — is what was tested). Does not touch any
-- existing table/column other than adding new, nullable columns to
-- `certificate` (safe, backwards-compatible with existing rows/readers,
-- identical in kind to the 2028 Local Produce Buyer migration).
--
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2029_agency_register/up.sql

BEGIN;

-- 1. New columns on the existing `certificate` table — staffing-flag
--    support only. (verificationToken, buyerDisplayName, county,
--    isPubliclyBlocked, publicBlockReason, stagedPermitNumber,
--    sourceRecordId, isHistoricalImport, importRawData,
--    agencyCertificateId already exist from the 2028 migration and are
--    reused as-is for Agency certificates; permitOrLicenceType = 'AGENCY'
--    is what distinguishes them.)
ALTER TABLE certificate
    ADD COLUMN IF NOT EXISTS "staffingFlagged" boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "staffingFlagReason" text;

-- 2. New enum types for AgentPersonnel's role/status columns (TypeORM's
--    "simple-enum" creates a genuine native Postgres enum type — verified
--    empirically, consistent with the 2027 migration's note on this).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_personnel_role_enum') THEN
        CREATE TYPE "agent_personnel_role_enum" AS ENUM ('AGENT', 'CLERK');
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_personnel_status_enum') THEN
        CREATE TYPE "agent_personnel_status_enum" AS ENUM ('ACTIVE', 'INACTIVE', 'REPLACED');
    END IF;
END$$;

-- 3. New table: agent_personnel — one row per Agent or Clerk staffed at
--    an Agency. See src/entities/AgentPersonnel.ts for full field
--    documentation.
CREATE TABLE IF NOT EXISTS agent_personnel (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    "agencyCertificateId" uuid,
    role "agent_personnel_role_enum" NOT NULL,
    "fullName" character varying NOT NULL,
    "permitNumber" character varying,
    county character varying,
    "nationalId" character varying,
    phone character varying,
    status "agent_personnel_status_enum" NOT NULL DEFAULT 'ACTIVE',
    "appointedAt" timestamp without time zone,
    "deactivatedAt" timestamp without time zone,
    "deactivationReason" text,
    "verificationToken" character varying,
    "isPubliclyBlocked" boolean NOT NULL DEFAULT false,
    "publicBlockReason" text,
    "requiresAgencyConfirmation" boolean NOT NULL DEFAULT false,
    "historyLog" jsonb NOT NULL DEFAULT '[]',
    "sourceRecordId" character varying,
    "isHistoricalImport" boolean NOT NULL DEFAULT false,
    "importRawData" jsonb,
    "createdAt" timestamp without time zone NOT NULL DEFAULT now(),
    "updatedAt" timestamp without time zone NOT NULL DEFAULT now()
);

-- IDEMPOTENCY: constraint additions are guarded (pg_constraint lookup)
-- so re-applying this file after a partial failure, or simply re-running
-- it, never errors on "constraint already exists" — matches the 2027
-- migration's "every statement safely re-runnable" standard.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UQ_agent_personnel_verificationToken') THEN
        ALTER TABLE agent_personnel ADD CONSTRAINT "UQ_agent_personnel_verificationToken" UNIQUE ("verificationToken");
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UQ_agent_personnel_sourceRecordId') THEN
        ALTER TABLE agent_personnel ADD CONSTRAINT "UQ_agent_personnel_sourceRecordId" UNIQUE ("sourceRecordId");
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_agent_personnel_agencyCertificateId') THEN
        ALTER TABLE agent_personnel ADD CONSTRAINT "FK_agent_personnel_agencyCertificateId"
            FOREIGN KEY ("agencyCertificateId") REFERENCES certificate(id) ON DELETE SET NULL;
    END IF;
END$$;

-- 4. New table: agency_import_run — audit trail of every Agency Register
--    preview/apply import run, mirroring local_produce_buyer_import_run.
CREATE TABLE IF NOT EXISTS agency_import_run (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    source character varying NOT NULL,
    "isDryRun" boolean NOT NULL DEFAULT false,
    "performedByUserId" character varying,
    "performedByName" character varying,
    "matchedAgencyCount" integer NOT NULL DEFAULT 0,
    "addedAgencyCount" integer NOT NULL DEFAULT 0,
    "conflictAgencyCount" integer NOT NULL DEFAULT 0,
    "totalAgencySourceRecords" integer NOT NULL DEFAULT 0,
    "matchedPersonnelCount" integer NOT NULL DEFAULT 0,
    "addedPersonnelCount" integer NOT NULL DEFAULT 0,
    "totalPersonnelSourceRecords" integer NOT NULL DEFAULT 0,
    "detailsJson" text,
    "createdAt" timestamp without time zone NOT NULL DEFAULT now()
);

COMMIT;

-- NOTE: This migration does NOT run the historical 11-Agency / 7-Agent
-- import. The import is a separate, explicit, idempotent application-level
-- step (AgencyImportService.apply(), exposed as
-- POST /api/agencies/import/apply, ADMIN-only) that must be run manually
-- by staff AFTER this schema migration and AFTER reviewing the dry-run
-- reconciliation report — per the same explicit review gate used for the
-- 2028 Local Produce Buyer import. Do not fold the import into this
-- migration.
--
-- NOTE: This migration does NOT add a renewal workflow. The staffing
-- requirement's "before renewing" enforcement
-- (AgencyStaffingService.assertWizardStaffingMet()) is written and ready,
-- but no renewal endpoint exists anywhere in this codebase for ANY
-- application category yet — building one is an explicitly deferred,
-- separate follow-up, not part of this migration or this feature's
-- current scope.
