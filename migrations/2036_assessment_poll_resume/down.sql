-- Migration 2036: Resumable WHISP polling (DOWN).
--
-- Status: PROPOSED FOR REVIEW. NOT applied to production.
--
-- DESTRUCTIVE-BY-NATURE: dropping these columns discards the analysis tokens
-- that in-flight jobs are holding. Any job whose analysis was still running at
-- the time of rollback can no longer be resumed, so its result would have to be
-- re-submitted after the rollback. The guard below refuses while that would
-- actually lose something.

DO $$
DECLARE
    in_flight integer;
BEGIN
    SELECT count(*) INTO in_flight
    FROM assessment_job
    WHERE "analysisInFlight" = true;

    IF in_flight > 0 THEN
        RAISE EXCEPTION
            'Refusing to drop resumable-polling columns: % job(s) have an analysis in flight. '
            'Rolling back now would discard their WHISP tokens and force those parcels to be '
            're-submitted (a second Earth Engine analysis). Wait for them to finish, or set '
            'analysisInFlight = false on those rows if their results are being abandoned '
            'deliberately.', in_flight;
    END IF;
END $$;

DROP INDEX IF EXISTS idx_assessment_job_polling;

ALTER TABLE assessment_job
    DROP COLUMN IF EXISTS "pollCount",
    DROP COLUMN IF EXISTS "analysisInFlight",
    DROP COLUMN IF EXISTS "lastPolledAt",
    DROP COLUMN IF EXISTS "pollDeadlineAt",
    DROP COLUMN IF EXISTS "whispToken";
