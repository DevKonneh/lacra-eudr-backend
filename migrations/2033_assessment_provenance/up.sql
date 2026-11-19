-- Migration 2033: Assessment provenance & failure visibility (UP).
--
-- Status: PROPOSED FOR REVIEW. NOT applied to production.
--
-- Context: the risk-assessment pipeline could previously persist a
-- "successful" RiskAssessment row derived from either (a) a randomised mock
-- when WHISP_API_KEY was unset, or (b) a name heuristic ("farm name contains
-- the word risk") when the live Whisp call failed. Both wrote farm.riskLevel
-- AND farm.lastRiskAssessmentDate, so a failure became indistinguishable from
-- a verified verdict everywhere in the UI and in every report.
--
-- This migration adds the schema needed to (1) record provenance on new
-- assessments, (2) conservatively mark every pre-existing assessment row as
-- UNVERIFIED so it must be reassessed before supporting a compliance claim,
-- and (3) store failed attempts separately so they are visible but can never
-- be read as a verdict.
--
-- Additive only. No existing column is altered or dropped, and no existing
-- row is deleted or rewritten - only new columns with safe defaults plus one
-- new table. All existing rows remain valid after this runs.
--
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2033_assessment_provenance/up.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Provenance columns on the existing risk_assessment table.
-- ---------------------------------------------------------------------------

-- Where the row came from: 'whisp_live' (verified satellite result) or 'mock'
-- (fabricated). NULL means a legacy row predating provenance tracking.
ALTER TABLE risk_assessment
    ADD COLUMN IF NOT EXISTS source character varying;

-- TRUE only when Whisp returned a completed analysis with usable properties.
-- NOT NULL DEFAULT false is deliberate: it makes every pre-existing row
-- unverified by default instead of silently trusting old data.
ALTER TABLE risk_assessment
    ADD COLUMN IF NOT EXISTS "whispVerified" boolean NOT NULL DEFAULT false;

-- Set when a row's provenance cannot be established; the original record is
-- preserved untouched for audit, only marked for reassessment.
ALTER TABLE risk_assessment
    ADD COLUMN IF NOT EXISTS "flaggedForReassessment" boolean NOT NULL DEFAULT false;

ALTER TABLE risk_assessment
    ADD COLUMN IF NOT EXISTS "flagReason" character varying;

-- ---------------------------------------------------------------------------
-- 2. Conservative backfill: flag every pre-existing assessment for review.
-- ---------------------------------------------------------------------------
--
-- Rationale: we cannot prove which historical rows came from the mock path.
-- Rather than guess (or delete evidence), every row that exists BEFORE this
-- migration is marked unverified and flagged for reassessment. Rows created
-- after this migration carry their own provenance and are unaffected.
--
-- This only touches the two flag columns. riskLevel, overallRisk, dates and
-- every evidentiary field are left exactly as they were.
UPDATE risk_assessment
SET "flaggedForReassessment" = true,
    "flagReason" = 'Pre-provenance record: source could not be verified (created before assessment provenance tracking). Retained for audit; reassess before relying on this result.',
    "whispVerified" = false
WHERE source IS NULL
  AND "whispVerified" IS NOT TRUE;

-- ---------------------------------------------------------------------------
-- 3. New table: assessment_attempt (visible record of FAILED attempts).
-- ---------------------------------------------------------------------------
--
-- Deliberately has no risk-level, overlap or boolean verdict columns, so no
-- query or report can ever read a failed attempt as a compliance result.
CREATE TABLE IF NOT EXISTS assessment_attempt (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    "farmId" uuid,
    "farmNameSnapshot" character varying,
    "attemptedAt" timestamp without time zone NOT NULL DEFAULT now(),
    outcome character varying NOT NULL DEFAULT 'failed',
    "failureCode" character varying,
    message text NOT NULL,
    "httpStatus" integer,
    retryable boolean NOT NULL DEFAULT false,
    detail jsonb
);

-- Support "which farms currently have no verified assessment?" and per-farm
-- attempt history without a full table scan.
CREATE INDEX IF NOT EXISTS idx_assessment_attempt_farm_attempted
    ON assessment_attempt ("farmId", "attemptedAt" DESC);

CREATE INDEX IF NOT EXISTS idx_risk_assessment_flagged
    ON risk_assessment ("flaggedForReassessment")
    WHERE "flaggedForReassessment" = true;

COMMIT;

-- NOTE: This migration intentionally does NOT re-run any assessment. Reassessment
-- is an explicit, staff-triggered action (POST /api/risk/assess/:farmId) so that
-- each new verdict is a deliberate, auditable event rather than a bulk overwrite.
--
-- NOTE: Per the project owner's instruction, this migration must be run on
-- STAGING ONLY and reviewed before anything is applied to production.
