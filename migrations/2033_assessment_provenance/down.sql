-- Rollback for 2033_assessment_provenance/up.sql. Reviewed but NOT applied to
-- any environment. Drops only what up.sql added: four columns on
-- `risk_assessment` and the `assessment_attempt` table; does not touch any
-- other table/column, and does not restore or delete any assessment data.
--
-- *** SAFETY GUARD: refuses to run if any failed-attempt record exists. ***
-- Mirrors the 2028/2029/2032 guard (row EXISTENCE, not just non-NULL values):
-- once an attempt row exists it is the only evidence that a given farm's
-- assessment failed, so dropping this schema would silently make those farms
-- look merely "never assessed" again. down.sql refuses rather than discard it.
--
-- NOTE: dropping `flaggedForReassessment` / `flagReason` / `source` /
-- `whispVerified` deliberately does NOT change farm.riskLevel or
-- farm.lastRiskAssessmentDate. Reverting this schema returns the system to the
-- old behaviour (unverified results indistinguishable from verified ones) - it
-- must not also rewrite historical farm state.

BEGIN;

DO $$
DECLARE
    attempt_count integer;
BEGIN
    IF to_regclass('public.assessment_attempt') IS NOT NULL THEN
        SELECT COUNT(*) INTO attempt_count FROM assessment_attempt;
        IF attempt_count > 0 THEN
            RAISE EXCEPTION
                'Refusing to run down.sql: % assessment_attempt row(s) already exist. Dropping this schema now would permanently lose the only record of those failed assessments. See migrations/2033_assessment_provenance/README.md before proceeding.',
                attempt_count;
        END IF;
    END IF;
END
$$;

DROP TABLE IF EXISTS assessment_attempt;

ALTER TABLE risk_assessment DROP COLUMN IF EXISTS "flagReason";
ALTER TABLE risk_assessment DROP COLUMN IF EXISTS "flaggedForReassessment";
ALTER TABLE risk_assessment DROP COLUMN IF EXISTS "whispVerified";
ALTER TABLE risk_assessment DROP COLUMN IF EXISTS source;

COMMIT;
