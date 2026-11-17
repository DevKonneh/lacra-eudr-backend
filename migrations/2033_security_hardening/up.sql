-- 2033 — Security Hardening (session revocation + audit coverage)
--
-- WHY THIS EXISTS: same rationale as prior explicit migrations in this
-- directory — this codebase relies on TypeORM `synchronize: true` in dev,
-- but staging/production run with DB_SYNCHRONIZE=false, so any new column
-- or enum value needs an explicit, reviewed migration.
--
-- SCOPE (purely additive — no existing column, enum value, row, or table
-- is altered, retyped, or dropped):
--   1. One new NOT NULL column on "user": "tokenVersion" (integer,
--      default 0). Every JWT now embeds the tokenVersion that was live at
--      issuance time; authMiddleware compares it against the live DB
--      value on every request. Bumping this column on a user instantly
--      invalidates every previously-issued token for that account —
--      this is the mechanism behind admin-triggered session revocation
--      and behind "password reset/change invalidates existing sessions".
--   2. Two new values added to the existing "user_audit_log_action_enum"
--      Postgres enum type:
--        - SESSIONS_REVOKED        (admin explicitly revoked a user's
--          active sessions, or a password reset/change forced one)
--        - PERMISSION_GROUP_CHANGED (an account's assignedRole/"Permission
--          Group" was changed — this was previously NOT audited at all;
--          UserController.update() silently changed assignedRoleId with
--          no corresponding UserAuditLog entry before this change)
--
-- PRE-REQUISITE: take a database backup/snapshot before running this,
-- same as every prior migration in this directory.
--
-- IDEMPOTENCY: every statement is guarded (IF NOT EXISTS / DO $$ checks),
-- so re-applying this file after a partial failure does not error.
--
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2033_security_hardening/up.sql

BEGIN;

-- 1. New NOT NULL column on "user", defaulted so existing rows are valid
--    the instant the column is added (no separate backfill pass needed).
ALTER TABLE "user"
    ADD COLUMN IF NOT EXISTS "tokenVersion" integer NOT NULL DEFAULT 0;

-- 2. New enum values on user_audit_log_action_enum.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'user_audit_log_action_enum'
          AND e.enumlabel = 'SESSIONS_REVOKED'
    ) THEN
        ALTER TYPE "user_audit_log_action_enum" ADD VALUE 'SESSIONS_REVOKED';
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'user_audit_log_action_enum'
          AND e.enumlabel = 'PERMISSION_GROUP_CHANGED'
    ) THEN
        ALTER TYPE "user_audit_log_action_enum" ADD VALUE 'PERMISSION_GROUP_CHANGED';
    END IF;
END$$;

COMMIT;

-- NOTE: Postgres cannot use a freshly-added enum value inside the SAME
-- transaction it was added in (ALTER TYPE ... ADD VALUE is transactional
-- since PG12 but the new label isn't visible to other commands in that
-- same transaction block). Both DO blocks above are each already in their
-- own implicit single-statement scope outside of any application INSERT,
-- and this file's only consumer (the Node app, started AFTER this
-- migration completes and commits) opens its own fresh connection/
-- transaction per request, so this is not an issue in practice — noted
-- here for anyone tempted to combine this migration with an app-level
-- INSERT using the new value in one script.
