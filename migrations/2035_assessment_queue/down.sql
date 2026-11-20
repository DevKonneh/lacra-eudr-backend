-- Rollback for 2035_assessment_queue/up.sql. Reviewed but NOT applied to any
-- environment. Drops only what up.sql added.
--
-- *** SAFETY GUARD: refuses while the queue holds undelivered work. ***
-- Mirrors the 2033/2034 guard (row EXISTENCE, not just non-NULL values). A
-- 'queued' or 'assessing' job is the only record that a subtitle assessment was
-- requested but never completed. Dropping the table while such rows exist would
-- silently discard that request: the plot would look like it had simply never
-- been queued, so nobody would know a check was owed.
--
-- Resolve the queue first (let the worker drain it, or retry/fail the rows
-- explicitly), then re-run this rollback.
--
-- NOTE: dropping the per-plot columns deliberately does NOT alter
-- farm.riskLevel, farm.lastRiskAssessmentDate, farm.location or plot.boundary.
-- Reverting the schema returns the system to assessment-on-click; it must not
-- rewrite historical verdicts or geometry.

BEGIN;

DO $$
DECLARE
    outstanding integer;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'assessment_job'
    ) THEN
        EXECUTE 'SELECT count(*) FROM assessment_job WHERE status IN (''queued'', ''assessing'')'
            INTO outstanding;
        IF outstanding > 0 THEN
            RAISE EXCEPTION
                'Refusing to drop the assessment queue: % job(s) are still queued or running. '
                'Let the worker finish, or mark them failed, then re-run this rollback.', outstanding;
        END IF;
    END IF;
END $$;

-- 3. Queue table (indexes and FKs go with it).
DROP TABLE IF EXISTS assessment_job;

-- 2. Per-plot attribution on assessments.
ALTER TABLE risk_assessment
    DROP CONSTRAINT IF EXISTS risk_assessment_plotId_fkey;

DROP INDEX IF EXISTS idx_risk_assessment_plot;

ALTER TABLE risk_assessment
    DROP COLUMN IF EXISTS "supersededByGeometryChange",
    DROP COLUMN IF EXISTS "geometryVersion",
    DROP COLUMN IF EXISTS "geometryHash",
    DROP COLUMN IF EXISTS "plotId";

-- 1. Plot geometry versioning.
ALTER TABLE plot
    DROP COLUMN IF EXISTS "geometryVersion",
    DROP COLUMN IF EXISTS "geometryHash";

COMMIT;
