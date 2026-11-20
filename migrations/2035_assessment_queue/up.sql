-- Migration 2035: Automatic per-plot assessment queue (UP).
--
-- Status: PROPOSED FOR REVIEW. NOT applied to production.
--
-- Context: risk assessments were only created when a member of staff clicked
-- "Assess". A farm synced from the Farm Mapping app could therefore sit with no
-- satellite evidence indefinitely, and nothing in the admin panel told staff
-- that a plot had never been checked. Automatic assessment now runs per PLOT:
-- the moment CMIS commits a plot with an eligible surveyed polygon, a job row is
-- inserted and a background worker performs the WhISP call.
--
-- This migration adds the schema that makes that safe:
--
--   1. plot.geometryHash / geometryVersion — a stable identity for a polygon,
--      so "the same boundary synced twice" is distinguishable from "a corrected
--      boundary". Without this, a retried sync would either create duplicate
--      jobs or fail to notice a real correction.
--   2. risk_assessment.plotId / geometryHash / geometryVersion /
--      supersededByGeometryChange — so a verdict records WHICH parcel and WHICH
--      polygon version it describes, and a verdict produced against an older
--      boundary can be kept for history while being excluded from being the
--      plot's current rating.
--   3. assessment_job — the durable queue itself (status, attempts, backoff,
--      dedupe key).
--
-- ADDITIVE AND NON-DESTRUCTIVE THROUGHOUT
--   * No row is deleted, and no existing column is altered or dropped.
--   * No farm.location / plot.boundary is reshaped, simplified or replaced.
--   * No farm.riskLevel / lastRiskAssessmentDate is touched — historical
--     verdicts keep exactly the meaning they had.
--   * Existing risk_assessment rows keep plotId = NULL, which is accurate:
--     they describe a whole farm boundary, not a specific plot.
--
-- NOTE ON plotId ON EXISTING ASSESSMENTS: pre-existing rows are left NULL rather
-- than guessed onto a plot. Attributing a farm-wide verdict to one subplot would
-- fabricate a per-plot result that no assessment ever produced.
--
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2035_assessment_queue/up.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Plot geometry versioning.
-- ---------------------------------------------------------------------------

-- sha256 of the canonicalised boundary (vertex order/winding normalised,
-- coordinates rounded). NULL means "not yet computed" for pre-existing rows.
ALTER TABLE plot
    ADD COLUMN IF NOT EXISTS "geometryHash" character varying;

-- Human-facing counter, bumped ONLY when the canonical polygon changes.
ALTER TABLE plot
    ADD COLUMN IF NOT EXISTS "geometryVersion" integer NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 2. Per-plot attribution on assessments.
-- ---------------------------------------------------------------------------

-- The plot a verdict describes. NULL for legacy farm-wide rows (accurate, not
-- missing data). ON DELETE SET NULL so history survives a plot being removed.
ALTER TABLE risk_assessment
    ADD COLUMN IF NOT EXISTS "plotId" uuid;

-- The polygon this verdict was produced from, so it can be proven to describe
-- the plot's CURRENT boundary before being shown as a current rating.
ALTER TABLE risk_assessment
    ADD COLUMN IF NOT EXISTS "geometryHash" character varying;

ALTER TABLE risk_assessment
    ADD COLUMN IF NOT EXISTS "geometryVersion" integer;

-- TRUE when the boundary was corrected while the check was running/finished.
-- The row is retained as evidence about that shape but excluded from "current".
ALTER TABLE risk_assessment
    ADD COLUMN IF NOT EXISTS "supersededByGeometryChange" boolean NOT NULL DEFAULT false;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'risk_assessment_plotId_fkey'
          AND table_name = 'risk_assessment'
    ) THEN
        ALTER TABLE risk_assessment
            ADD CONSTRAINT "risk_assessment_plotId_fkey"
            FOREIGN KEY ("plotId") REFERENCES plot(id) ON DELETE SET NULL;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. The assessment queue.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS assessment_job (
    id                          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),

    "plotId"                    uuid,
    "farmId"                    uuid,
    "plotNameSnapshot"          character varying,

    -- sha256 of the polygon this job assesses. The currency check at write time
    -- compares this against the plot's live hash.
    "geometryHash"              character varying,
    "geometryVersion"           integer NOT NULL DEFAULT 0,

    -- = plotId + ':' + geometryHash. UNIQUE, so a retried sync of an unchanged
    -- boundary collides with the existing row instead of duplicating the job.
    -- This is what makes deduplication a database guarantee rather than an
    -- application check that two concurrent syncs could race past.
    "dedupeKey"                 character varying NOT NULL,

    -- queued | assessing | completed | failed | boundary_review
    -- Stored as varchar (not an enum) so a future state does not require a
    -- schema migration on a table that holds in-flight work.
    status                      character varying NOT NULL DEFAULT 'queued',

    attempts                    integer NOT NULL DEFAULT 0,

    -- Earliest time the worker may pick this up. Drives retry backoff.
    "nextAttemptAt"             timestamp,

    "failureCode"               character varying,
    "lastError"                 text,
    retryable                   boolean NOT NULL DEFAULT false,
    "boundaryReviewReason"      text,

    "assessmentId"              character varying,

    "startedAt"                 timestamp,
    "finishedAt"                timestamp,
    "createdAt"                 timestamp NOT NULL DEFAULT now(),
    "updatedAt"                 timestamp NOT NULL DEFAULT now(),

    CONSTRAINT assessment_job_plot_fk
        FOREIGN KEY ("plotId") REFERENCES plot(id) ON DELETE CASCADE,
    CONSTRAINT assessment_job_farm_fk
        FOREIGN KEY ("farmId") REFERENCES farm(id) ON DELETE CASCADE
);

-- THE dedupe guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assessment_job_dedupe
    ON assessment_job ("dedupeKey");

-- Worker pickup: due queued jobs, oldest first.
CREATE INDEX IF NOT EXISTS idx_assessment_job_due
    ON assessment_job (status, "nextAttemptAt")
    WHERE status = 'queued';

-- Panel lookup by plot.
CREATE INDEX IF NOT EXISTS idx_assessment_job_plot
    ON assessment_job ("plotId", "createdAt" DESC);

-- Panel lookup by farm.
CREATE INDEX IF NOT EXISTS idx_assessment_job_farm
    ON assessment_job ("farmId", "createdAt" DESC);

-- Per-plot verdict history.
CREATE INDEX IF NOT EXISTS idx_risk_assessment_plot
    ON risk_assessment ("plotId", "createdAt" DESC);

-- ---------------------------------------------------------------------------
-- 4. Conservative backfill of plot.geometryHash.
-- ---------------------------------------------------------------------------
--
-- Deliberately does NOT attempt to compute sha256 in SQL. The canonicalisation
-- the application uses (ring rotation, winding, coordinate rounding) is not
-- reproducible in plain SQL without duplicating that logic — and a hash that
-- disagreed with the application's would look like a boundary change on every
-- single plot, queueing a flood of spurious assessments.
--
-- Leaving it NULL is the safe default: the application treats "no hash" as
-- "cannot prove this verdict describes the current polygon", so no legacy
-- verdict is ever presented as current for a plot. AssessmentQueueService
-- fills the hash the first time each plot is enqueued or saved.

-- ---------------------------------------------------------------------------
-- 5. Mark pre-existing assessments as NOT current for any plot.
-- ---------------------------------------------------------------------------
--
-- `supersededByGeometryChange` defaults to false, but these rows also have
-- plotId = NULL, so the "current finding" test (which requires a matching
-- plotId + geometryHash) already excludes them. Nothing to rewrite — flagged
-- here so the intent is explicit rather than accidental.

COMMIT;
