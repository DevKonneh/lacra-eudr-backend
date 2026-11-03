-- Identity Verification feature — explicit production migration (UP)
--
-- WHY THIS EXISTS: this codebase normally relies on TypeORM's
-- `synchronize: true` (see src/data-source.ts) for schema evolution, with
-- no formal migration files. That is acceptable for additive, low-risk
-- changes in dev, but per the explicit correction on this feature: a
-- schema-verification script run against 18 local records does not
-- establish production safety, and `synchronize: true` should not be
-- relied on for a production deploy. This file is the reviewed, explicit
-- migration for the Identity Verification feature's schema changes.
--
-- SCOPE — exactly two kinds of changes, both additive/non-destructive:
--   1. Four new NULLABLE columns on "farmer" (no existing column altered,
--      dropped, or retyped; no data in any existing column is touched).
--   2. Three new values added to the existing
--      "farmer_audit_log_action_enum" Postgres enum type (no existing
--      enum value removed or renamed).
-- Neither operation can lose data for any existing row. This is the SAME
-- additive category that src/migrateToCommodities.ts documents as safe,
-- NOT the enum->varchar column-type-change category that caused the past
-- data-loss incident referenced there.
--
-- PRE-REQUISITE: take a full database backup/snapshot immediately before
-- running this (see migrations/2026_identity_verification/README.md).
--
-- IDEMPOTENCY: every statement below is written to be safely re-runnable
-- (IF NOT EXISTS / DO $$ ... guards), so re-applying this file after a
-- partial failure does not error or duplicate anything.
--
-- Run with (see README.md for the full procedure):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2026_identity_verification/up.sql

BEGIN;

-- 1. New nullable columns on "farmer".
--    Column names are double-quoted because this codebase's TypeORM
--    entities use camelCase column names directly (no SnakeNamingStrategy
--    configured in data-source.ts), so the actual Postgres column names
--    are case-sensitive camelCase, matching Farmer.ts exactly.
ALTER TABLE "farmer"
    ADD COLUMN IF NOT EXISTS "identityVerifiedAt" timestamp without time zone NULL;

ALTER TABLE "farmer"
    ADD COLUMN IF NOT EXISTS "identityVerifiedByUserId" character varying NULL;

ALTER TABLE "farmer"
    ADD COLUMN IF NOT EXISTS "identityVerifiedByName" character varying NULL;

ALTER TABLE "farmer"
    ADD COLUMN IF NOT EXISTS "identityStatusReason" text NULL;

-- 2. New enum values on farmer_audit_log_action_enum.
--    ALTER TYPE ... ADD VALUE cannot run inside the same transaction as a
--    later statement that USES the new value in this same session on
--    older Postgres versions, but it CAN be combined with other DDL in
--    the same transaction as long as the new value isn't referenced by a
--    DML statement in that same transaction (which it isn't here — we
--    only add the values, we don't insert rows using them). Postgres 12+
--    (this environment: 15.18) supports IF NOT EXISTS on ADD VALUE,
--    making this safe to re-run.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'farmer_audit_log_action_enum'
          AND e.enumlabel = 'IDENTITY_VERIFIED'
    ) THEN
        ALTER TYPE "farmer_audit_log_action_enum" ADD VALUE 'IDENTITY_VERIFIED';
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'farmer_audit_log_action_enum'
          AND e.enumlabel = 'IDENTITY_CONFLICT_FLAGGED'
    ) THEN
        ALTER TYPE "farmer_audit_log_action_enum" ADD VALUE 'IDENTITY_CONFLICT_FLAGGED';
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'farmer_audit_log_action_enum'
          AND e.enumlabel = 'IDENTITY_REVERTED_TO_UNVERIFIED'
    ) THEN
        ALTER TYPE "farmer_audit_log_action_enum" ADD VALUE 'IDENTITY_REVERTED_TO_UNVERIFIED';
    END IF;
END$$;

COMMIT;

-- NOTE: the "farmer"."identityStatus" column and its
-- farmer_identitystatus_enum type (Verified/Unverified/Conflict) already
-- existed before this feature (from an earlier migration) and are NOT
-- touched by this file. This migration only adds the 4 new metadata
-- columns and the 3 new audit-action enum values layered on top of it.
