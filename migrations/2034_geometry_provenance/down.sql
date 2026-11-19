-- Rollback for 2034_geometry_provenance/up.sql. Reviewed but NOT applied to
-- any environment. Drops only what up.sql added: three columns on `farm` and
-- the two review-queue indexes; does not touch any other table/column, and does
-- not modify any geometry, verdict or date.
--
-- *** SAFETY GUARD: refuses to run if any boundary review flag is set. ***
-- Mirrors the 2028/2029/2032/2033 guard (row EXISTENCE, not just non-NULL
-- values): a set `boundaryReviewFlag` is the only record that a farm's stored
-- boundary is not survey evidence. Dropping this schema would silently return
-- those farms to looking like ordinary surveyed boundaries, and any future
-- assessment over the legacy generated square would no longer be refused.
-- down.sql refuses rather than discard that signal.
--
-- NOTE: dropping `geometrySource` / `boundaryReviewFlag` /
-- `boundaryReviewReason` deliberately does NOT change `farm.location`,
-- `farm.riskLevel` or `farm.lastRiskAssessmentDate`. Reverting this schema
-- returns the system to the old behaviour (generated squares indistinguishable
-- from surveyed boundaries) - it must not also rewrite historical farm state.

BEGIN;

DO $$
DECLARE
    flagged_count integer;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'farm'
          AND column_name = 'boundaryReviewFlag'
    ) THEN
        EXECUTE 'SELECT COUNT(*) FROM farm WHERE "boundaryReviewFlag" = true'
            INTO flagged_count;
        IF flagged_count > 0 THEN
            RAISE EXCEPTION
                'Refusing to run down.sql: % farm row(s) carry "boundaryReviewFlag" = true. Dropping this schema now would permanently lose the only record that those boundaries are not survey evidence. See migrations/2034_geometry_provenance/README.md before proceeding.',
                flagged_count;
        END IF;
    END IF;
END
$$;

DROP INDEX IF EXISTS idx_farm_geometry_source;
DROP INDEX IF EXISTS idx_farm_boundary_review;

ALTER TABLE farm DROP COLUMN IF EXISTS "boundaryReviewReason";
ALTER TABLE farm DROP COLUMN IF EXISTS "boundaryReviewFlag";
ALTER TABLE farm DROP COLUMN IF EXISTS "geometrySource";

COMMIT;
