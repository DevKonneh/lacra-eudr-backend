-- Migration 2034: Farm geometry provenance (UP).
--
-- Status: PROPOSED FOR REVIEW. NOT applied to production.
--
-- Context: FarmController.create() used to accept a lat/lng-only submission and
-- store a synthetic Polygon — an axis-aligned square spanning exactly 0.002°
-- (±0.001°) around the point, roughly 222 m per side / ~4.9 ha. Downstream
-- nothing could distinguish that square from a real field survey:
--
--   1. GeometryValidationService saw a plausible closed polygon, so it passed
--      validation and was submitted to Whisp as the farm's actual parcel. The
--      resulting satellite verdict described a shape that does not exist on
--      the ground.
--   2. Maps and reports drew it as a surveyed boundary.
--
-- The code fix (same release) stores a single coordinate as a GeoJSON Point and
-- records provenance explicitly. This migration adds the columns that hold that
-- provenance, plus the flag used to route uncertain boundaries to a human
-- reviewer.
--
-- EVERYTHING HERE IS ADDITIVE AND NON-DESTRUCTIVE.
--   * No farm row is deleted.
--   * No farm.location is altered, reshaped, simplified or replaced.
--   * No farm.riskLevel / lastRiskAssessmentDate is touched.
-- Historical geometry and historical verdicts stay exactly as recorded so the
-- audit trail of what was previously submitted remains intact.
--
-- `farm.location` is a PostGIS `geometry` column (SRID 4326), NOT jsonb, so the
-- backfill below uses PostGIS accessors rather than JSON operators.
--
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2034_geometry_provenance/up.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Provenance columns on the existing farm table.
-- ---------------------------------------------------------------------------

-- HOW this farm's geometry came to exist:
--   'surveyed'         -> a real boundary polygon captured in the field.
--   'recorded_point'   -> a single GPS coordinate. A location, NOT a boundary.
--   'generated_buffer' -> the legacy synthetic ±0.001° square. NOT a survey.
--   NULL               -> unknown / legacy row (see backfill below).
ALTER TABLE farm
    ADD COLUMN IF NOT EXISTS "geometrySource" character varying;

-- Set when the boundary cannot be trusted as survey evidence and needs a human
-- to confirm or re-map it. The original geometry is never modified; this only
-- surfaces the record in the review queue.
ALTER TABLE farm
    ADD COLUMN IF NOT EXISTS "boundaryReviewFlag" boolean NOT NULL DEFAULT false;

ALTER TABLE farm
    ADD COLUMN IF NOT EXISTS "boundaryReviewReason" character varying;

-- ---------------------------------------------------------------------------
-- 2. Backfill: identify legacy auto-generated squares.
-- ---------------------------------------------------------------------------
--
-- Deliberately strict. A genuine surveyed plot could coincidentally be a
-- near-square rectangle, so we only claim "generated" when the stored shape
-- matches the machine signature EXACTLY:
--
--   * a single Polygon
--   * exactly 5 points (a closed 4-corner ring)
--   * closed and simple
--   * identical to its own bounding-box envelope (i.e. axis-aligned rectangle)
--   * bounding-box span exactly 0.002° in BOTH axes
--
-- A real survey never lands on those exact numbers. Anything not matching is
-- left alone entirely — we do not guess.
--
-- Nothing is rewritten: only `geometrySource` and the review-queue columns are
-- set on rows that match. The geometry itself is never touched.

UPDATE farm f
SET "geometrySource" = 'generated_buffer',
    "boundaryReviewFlag" = true,
    "boundaryReviewReason" =
        'Boundary matches the legacy auto-generated square (±0.001° around a single point). This is not survey evidence — the reported satellite result, if any, described a shape that does not exist on the ground. Re-map the real parcel before relying on or repeating an assessment.'
WHERE f.location IS NOT NULL
  AND NOT ST_IsEmpty(f.location)
  AND GeometryType(f.location) = 'POLYGON'
  AND ST_NPoints(f.location) = 5
  AND ST_IsClosed(f.location)
  AND ST_IsSimple(f.location)
  -- Axis-aligned rectangle: the shape equals its own bounding-box envelope.
  AND ST_Equals(f.location, ST_Envelope(f.location))
  -- Exact machine span in both axes (tolerance absorbs float representation).
  AND abs((ST_XMax(f.location) - ST_XMin(f.location)) - 0.002) < 1e-9
  AND abs((ST_YMax(f.location) - ST_YMin(f.location)) - 0.002) < 1e-9
  -- And the area matches 0.002° x 0.002° exactly.
  AND abs(ST_Area(f.location) - 0.000004) < 1e-12;

-- ---------------------------------------------------------------------------
-- 3. Backfill: classify the remaining historical rows.
-- ---------------------------------------------------------------------------
--
-- Points are recorded locations, never boundaries. Anything polygon-shaped
-- that did NOT match the synthetic signature above is treated as a surveyed
-- boundary — that is what it was submitted as, and we must not relabel real
-- survey work as suspect. Rows with no usable geometry keep NULL provenance
-- (unknown), which the API and UI report as unverified.

UPDATE farm
SET "geometrySource" = 'recorded_point'
WHERE "geometrySource" IS NULL
  AND location IS NOT NULL
  AND NOT ST_IsEmpty(location)
  AND GeometryType(location) = 'POINT';

UPDATE farm
SET "geometrySource" = 'surveyed'
WHERE "geometrySource" IS NULL
  AND location IS NOT NULL
  AND NOT ST_IsEmpty(location)
  AND GeometryType(location) IN ('POLYGON', 'MULTIPOLYGON');

-- ---------------------------------------------------------------------------
-- 4. Review queue for point-only farms.
-- ---------------------------------------------------------------------------
--
-- A recorded point is a legitimate location but cannot serve as an assessed
-- boundary (current policy blocks point-only assessment). Flag those rows so
-- staff can see which farms still need a surveyed boundary. This is a work
-- queue marker only — it never blocks anything by itself and never edits the
-- stored geometry.

UPDATE farm
SET "boundaryReviewFlag" = true,
    "boundaryReviewReason" = COALESCE(
        "boundaryReviewReason",
        'Recorded GPS point only — no surveyed boundary. A boundary must be surveyed before this farm can be assessed.'
    )
WHERE "geometrySource" = 'recorded_point'
  AND "boundaryReviewFlag" IS NOT TRUE;

-- ---------------------------------------------------------------------------
-- 5. Indexes for the boundary review queue.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_farm_boundary_review
    ON farm ("boundaryReviewFlag")
    WHERE "boundaryReviewFlag" = true;

CREATE INDEX IF NOT EXISTS idx_farm_geometry_source
    ON farm ("geometrySource");

COMMIT;

-- NOTE: This migration never touches farm.riskLevel, farm.lastRiskAssessmentDate
-- or any risk_assessment row. Historical verdicts computed over a generated
-- square are left exactly as they were recorded — they are evidence of what was
-- previously reported and must remain available for audit. Marking the geometry
-- as generated is what tells staff those verdicts cannot be relied on.
--
-- NOTE: Per the project owner's instruction, this migration is reviewed and run
-- on STAGING ONLY. Nothing is applied to production.
