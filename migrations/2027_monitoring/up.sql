-- CMIS Monitoring feature — explicit production migration (UP)
--
-- WHY THIS EXISTS: same rationale as migrations/2026_identity_verification/
-- up.sql — this codebase normally relies on TypeORM's `synchronize: true`
-- for schema evolution in dev, but that is not an acceptable production
-- deploy strategy for this feature, which adds new ENUM values (including
-- one to a column read on every authenticated request: "user"."role") and
-- 4 entirely new tables. This file is the reviewed, explicit migration.
--
-- SCOPE:
--   1. One new value added to the existing "user_role_enum" Postgres enum
--      type: FIELD_SUPERVISOR.
--   2. Two new values added to the existing "user_audit_log_action_enum"
--      Postgres enum type: SUPERVISOR_CHANGED, TERRITORY_CHANGED.
--   3. Three new NULLABLE columns on "user": "supervisorId" (uuid),
--      "assignedCounty" (varchar), "assignedDistrict" (varchar). No
--      existing column is altered, dropped, or retyped.
--   4. Two new enum TYPES created from scratch (they do not exist yet, so
--      "ALTER TYPE ... ADD VALUE" does not apply — these are genuinely new
--      types backing genuinely new tables):
--        - "field_event_type_enum": CHECK_IN, CHECK_OUT, FARM_RECORD_CAPTURE
--        - "sign_in_attempt_outcome_enum": SUCCESS, FAILED, BLOCKED
--   5. Four new tables: "field_event", "mobile_sync_status",
--      "sign_in_attempt", "user_session" — with columns/types/defaults/
--      indexes matching exactly what TypeORM's `synchronize: true` would
--      generate from the corresponding entities (verified by running
--      `synchronize: true` once against a disposable clone database,
--      `eudr_monitoring_discover`, cloned from a genuine pre-migration
--      baseline, and inspecting the resulting schema with `\d` /
--      `pg_enum` — see README.md "How this was tested").
--
-- This migration is purely additive — no existing column, enum value, row,
-- or table is altered, retyped, or dropped. "user"."supervisorId" is a
-- plain uuid column (NOT a foreign key constraint), matching the entity
-- definition (User.ts), which intentionally avoids a FK/relation here to
-- sidestep `synchronize: true` complications and unwanted circular
-- relations at existing call sites — see User.ts comment on supervisorId.
--
-- PRE-REQUISITE: take a full database backup/snapshot immediately before
-- running this (see README.md).
--
-- IDEMPOTENCY: every statement is written to be safely re-runnable
-- (IF NOT EXISTS / DO $$ ... guards), so re-applying this file after a
-- partial failure does not error or duplicate anything.
--
-- Run with (see README.md for the full procedure):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2027_monitoring/up.sql

BEGIN;

-- 1. New enum value on user_role_enum.
-- NOTE: "simple-enum" columns (as used on User.role) create a genuine
-- native Postgres enum type, identical in this respect to `type: "enum"`
-- — verified empirically against the real database. This ADD VALUE step
-- is therefore required, not skippable.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'user_role_enum'
          AND e.enumlabel = 'FIELD_SUPERVISOR'
    ) THEN
        ALTER TYPE "user_role_enum" ADD VALUE 'FIELD_SUPERVISOR';
    END IF;
END$$;

-- 2. New enum values on user_audit_log_action_enum.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'user_audit_log_action_enum'
          AND e.enumlabel = 'SUPERVISOR_CHANGED'
    ) THEN
        ALTER TYPE "user_audit_log_action_enum" ADD VALUE 'SUPERVISOR_CHANGED';
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'user_audit_log_action_enum'
          AND e.enumlabel = 'TERRITORY_CHANGED'
    ) THEN
        ALTER TYPE "user_audit_log_action_enum" ADD VALUE 'TERRITORY_CHANGED';
    END IF;
END$$;

-- 3. New nullable columns on "user".
--    Column names are double-quoted camelCase, matching this codebase's
--    convention (no SnakeNamingStrategy configured in data-source.ts).
ALTER TABLE "user"
    ADD COLUMN IF NOT EXISTS "supervisorId" uuid NULL;

ALTER TABLE "user"
    ADD COLUMN IF NOT EXISTS "assignedCounty" character varying NULL;

ALTER TABLE "user"
    ADD COLUMN IF NOT EXISTS "assignedDistrict" character varying NULL;

-- 4. New enum types for the new tables below. These are brand-new types,
--    so they are created with CREATE TYPE (guarded via pg_type existence
--    check, since CREATE TYPE has no native IF NOT EXISTS clause).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'field_event_type_enum'
    ) THEN
        CREATE TYPE "field_event_type_enum" AS ENUM (
            'CHECK_IN', 'CHECK_OUT', 'FARM_RECORD_CAPTURE'
        );
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'sign_in_attempt_outcome_enum'
    ) THEN
        CREATE TYPE "sign_in_attempt_outcome_enum" AS ENUM (
            'SUCCESS', 'FAILED', 'BLOCKED'
        );
    END IF;
END$$;

-- 5a. New table: field_event
--     Idempotent-ingestion key: UNIQUE ("enumeratorId", "eventId") — this
--     is what the check-in/check-out and farm-capture recording logic
--     relies on via `.orIgnore()` upserts to make retried submissions safe.
--     "enumeratorId" is a plain character-varying column (NOT a foreign
--     key), matching FieldEvent.ts, which derives it from the
--     authenticated request rather than trusting client input, but does
--     not enforce referential integrity against "user" at the DB level
--     (same deliberate relation-avoidance pattern as User.supervisorId).
CREATE TABLE IF NOT EXISTS "field_event" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "eventId" character varying NOT NULL,
    "enumeratorId" character varying NOT NULL,
    "type" "field_event_type_enum" NOT NULL,
    "assignmentContext" character varying NULL,
    "latitude" double precision NULL,
    "longitude" double precision NULL,
    "gpsAccuracyM" double precision NULL,
    "capturedAt" timestamp without time zone NOT NULL,
    "receivedAt" timestamp without time zone NOT NULL DEFAULT now(),
    CONSTRAINT "PK_bb70dc6a11cb5241c336b4c4d5b" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IDX_3c04917cd2841746663b114125"
    ON "field_event" ("enumeratorId", "eventId");

CREATE INDEX IF NOT EXISTS "IDX_fb0317ac0aea492f991e6101e4"
    ON "field_event" ("enumeratorId", "capturedAt");

-- 5b. New table: mobile_sync_status
--     One row per user (UNIQUE "userId"), upserted on every reported sync
--     cycle. "lastPendingReportedAt" records when the lastPendingCount was
--     reported (not "now"), so a stale UI can show "as of <timestamp>"
--     while the device is offline.
CREATE TABLE IF NOT EXISTS "mobile_sync_status" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "userId" character varying NOT NULL,
    "lastSuccessfulSyncAt" timestamp without time zone NULL,
    "lastPendingCount" integer NULL,
    "lastPendingReportedAt" timestamp without time zone NULL,
    "lastSyncError" text NULL,
    "lastSyncErrorAt" timestamp without time zone NULL,
    "createdAt" timestamp without time zone NOT NULL DEFAULT now(),
    "updatedAt" timestamp without time zone NOT NULL DEFAULT now(),
    CONSTRAINT "PK_43169d1c77d64aeeeba5e1412ef" PRIMARY KEY ("id"),
    CONSTRAINT "UQ_5f51deba6051a6decc76eed9c23" UNIQUE ("userId")
);

-- 5c. New table: sign_in_attempt
--     "userId" nullable uuid (no FK) — a resolved userId when the email
--     matched a real account, NULL for unknown-account attempts. Per
--     explicit privacy-by-design requirement: no password, token, raw IP,
--     or raw email string is ever persisted here, only this resolved
--     userId (nullable) and a short "reason" string.
CREATE TABLE IF NOT EXISTS "sign_in_attempt" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "userId" uuid NULL,
    "outcome" "sign_in_attempt_outcome_enum" NOT NULL,
    "reason" character varying NULL,
    "platform" character varying NULL,
    "createdAt" timestamp without time zone NOT NULL DEFAULT now(),
    CONSTRAINT "PK_7708f8d7d88593210f3d359f81d" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "IDX_87a16dee20780a7fdee6af2ded"
    ON "sign_in_attempt" ("userId", "createdAt");

-- 5d. New table: user_session
--     Per-tab-session heartbeat rows, aggregated per user by most recent
--     "lastHeartbeatAt"/"lastInteractionAt" to derive Online/Idle/Offline
--     presence. UNIQUE ("userId", "tabId") — one row per opaque
--     client-generated tab id per authenticated user, upserted on each
--     heartbeat so heartbeats work for backgrounded tabs without needing
--     window/tab focus.
CREATE TABLE IF NOT EXISTS "user_session" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "userId" character varying NOT NULL,
    "tabId" character varying NOT NULL,
    "lastHeartbeatAt" timestamp without time zone NOT NULL,
    "lastInteractionAt" timestamp without time zone NULL,
    "createdAt" timestamp without time zone NOT NULL DEFAULT now(),
    "updatedAt" timestamp without time zone NOT NULL DEFAULT now(),
    CONSTRAINT "PK_adf3b49590842ac3cf54cac451a" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IDX_556421aa8bee97bb40b8f67540"
    ON "user_session" ("userId", "tabId");

COMMIT;

-- NOTE: "user"."supervisorId" is intentionally NOT a foreign key
-- constraint (see User.ts comment) — validation that a supervisor exists
-- and holds the FIELD_SUPERVISOR role is enforced at the application
-- layer (UserController.validateSupervisor()), not at the database layer.
-- This mirrors the existing "enumeratorId" / "userId" string columns on
-- the new field_event / sign_in_attempt / user_session tables, which are
-- also deliberately not foreign keys, for the same `synchronize: true`
-- compatibility reasons documented in those entities.
