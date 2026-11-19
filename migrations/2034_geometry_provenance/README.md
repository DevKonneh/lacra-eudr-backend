# 2034 — Farm Geometry Provenance

**Status: PROPOSED FOR REVIEW. NOT applied to production.**

## Why this migration exists

`FarmController.create()` accepted a lat/lng-only submission and stored a
**synthetic Polygon** — an axis-aligned square spanning exactly `0.002°`
(`±0.001°`) around the point, roughly **222 m per side / ~4.9 ha**.

That square was indistinguishable from a real field survey downstream:

1. **It passed geometry validation.** `GeometryValidationService` saw a
   plausible, closed, simple polygon, so nothing blocked it.
2. **It reached Whisp as the parcel.** `RiskService` submitted it to Open Foris
   Whisp for deforestation analysis, and the returned verdict — which is an
   official due-diligence input — described a shape that does not exist on the
   ground.
3. **It was drawn and reported as a surveyed boundary** in maps, exports and
   the public profile.

The real-world consequence: a farmer whose plot is a 1.2 ha irregular field
could hold a satellite "Low risk" result computed over a 4.9 ha square centred
on one GPS pin — with an area figure, overlap percentages and a risk class that
belong to no real parcel.

The **code** fix (same release) changes what is stored and what may be
assessed:

- A lat/lng-only submission is stored as the GeoJSON **Point** it actually is,
  with `geometrySource = 'recorded_point'`.
- A client replaying the old square shape is classified
  `'generated_buffer'`, not `'surveyed'`.
- `RiskService.analyzeFarm()` refuses to call Whisp for a
  `'generated_buffer'` boundary and records the refusal reason.

This migration adds the **schema** for that provenance and the review queue for
boundaries that are not survey evidence.

## What this migration does

Additive only. Nothing is dropped, renamed or rewritten in place; every
existing row remains valid.

- **3 columns on `farm`:**
  - `geometrySource` — `'surveyed'` | `'recorded_point'` |
    `'generated_buffer'` | `NULL` (unknown).
  - `boundaryReviewFlag` — `boolean NOT NULL DEFAULT false`.
  - `boundaryReviewReason` — free text.
- **1 strict backfill of legacy generated squares.** Rows are labelled
  `'generated_buffer'` **only** when the stored geometry matches the machine
  signature exactly:
  - `GeometryType` is `POLYGON`
  - `ST_NPoints` is exactly `5` (a closed 4-corner ring)
  - closed and simple
  - `ST_Equals(geom, ST_Envelope(geom))` — an axis-aligned rectangle
  - span is exactly `0.002°` in both axes, and area is exactly `0.000004` deg²

  A genuine surveyed plot will essentially never satisfy all of those at once,
  so this does not mislabel real survey work. Anything not matching is left
  untouched — the migration does not guess.
- **1 classification backfill of remaining rows.** `POINT` →
  `'recorded_point'`; `POLYGON`/`MULTIPOLYGON` → `'surveyed'`; rows with no
  usable geometry keep `NULL` = unknown, which the API reports as unverified.
- **1 review-queue backfill.** `'recorded_point'` farms get
  `boundaryReviewFlag = true` and an explanatory reason, so staff can see which
  farms still need a surveyed boundary.
- **2 indexes** — the review queue and provenance lookups.

## What this migration deliberately does NOT do

- **Does not modify any geometry.** `farm.location` is read by the backfill and
  never written. No shape is deleted, simplified, snapped or regenerated. This
  matches `farm.location` being a PostGIS `geometry(Geometry,4326)` column, so
  the backfill uses `GeometryType`, `ST_NPoints`, `ST_IsClosed`, `ST_IsSimple`,
  `ST_Equals`, `ST_Envelope`, `ST_XMin/Max`, `ST_YMin/Max` and `ST_Area` rather
  than JSON operators.
- **Does not touch `farm.riskLevel` or `farm.lastRiskAssessmentDate`.** Verdicts
  previously computed over a generated square are retained exactly as recorded.
  They are evidence of what was reported and must stay available for audit.
  Marking the geometry as generated is what tells staff those verdicts cannot be
  relied on.
- **Does not touch `risk_assessment`.** That table is 2033's concern.
- **Does not run any assessment or reassessment.** Reassessment stays an
  explicit, staff-triggered, auditable action
  (`POST /api/risk/assess/:farmId`).

## Audit rule this enables

A farm boundary may be treated as survey evidence **only** when:

```sql
"geometrySource" = 'surveyed'
```

Everything else — recorded points, generated squares, and legacy `NULL` rows —
is **not** survey evidence. `RiskService` additionally refuses to assess any
boundary that resolves to `'generated_buffer'`, and the existing point-only
policy continues to block assessment of `'recorded_point'` farms.

### Finding affected farms

```sql
-- Farms whose earlier verdicts described a synthetic square.
SELECT id, name, "farmerId", "geometrySource", "boundaryReviewReason"
FROM farm
WHERE "geometrySource" = 'generated_buffer';

-- Boundary work queue (needs a surveyed boundary before assessment).
SELECT id, name, "farmerId", "geometrySource"
FROM farm
WHERE "boundaryReviewFlag" = true;

-- Legacy rows where provenance is genuinely unknown.
SELECT id, name FROM farm WHERE "geometrySource" IS NULL;
```

No row is deleted; all of the above are retained and flagged for human review.

## Rollback

`down.sql` drops only what `up.sql` added: three `farm` columns and two indexes.
It **refuses to run** if any farm has `boundaryReviewFlag = true`, because that
flag is the only record that a boundary is not survey evidence — dropping the
schema would quietly return those farms to looking like ordinary surveyed
boundaries. Reverting does **not** modify any geometry, verdict or date.

## Run with

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2034_geometry_provenance/up.sql
```

## Testing note

Follows the same review gate as every prior migration in this series: run on
**staging only** first, with `DB_SYNCHRONIZE=false`, and review the resulting
schema and backfill counts before anything is applied to production.

Local verification (PostgreSQL 17 + PostGIS 3.5) is recorded in the delivery
report: the migration is applied to a throwaway database seeded with a
generated square, a real polygon, a point-only farm and a no-geometry farm, and
the row-level outcome is checked against each case.
