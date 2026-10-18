/**
 * Configurable tolerances/thresholds for GPS polygon & farm-area validation
 * (GeometryValidationService). Centralized here (rather than hardcoded
 * inline) so they can be tuned without touching validation logic, and so
 * the values actually used for a given assessment can be reported back to
 * the frontend/API consumer for transparency (per the requirement to
 * "report all validation rules [and] configurable tolerances").
 *
 * All of these can be overridden via environment variables so an ops team
 * can retune them per deployment without a code change/redeploy.
 */

const envFloat = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
};

export const GEO_VALIDATION_CONFIG = {
    /**
     * Liberia's approximate geographic bounding box (WGS84 decimal
     * degrees). Sourced from public administrative-boundary reference
     * data. Used as a coarse sanity check that submitted coordinates are
     * physically plausible for a Liberian farm — NOT a precise national
     * border check (a bounding box necessarily includes some area
     * outside Liberia's actual borders near the edges, and a true
     * point-in-country-polygon check would need a full national boundary
     * dataset we don't currently ship). Configurable in case a more
     * precise polygon/dataset is added later.
     */
    LIBERIA_BOUNDS: {
        south: envFloat("GEO_LIBERIA_SOUTH", 4.155),
        north: envFloat("GEO_LIBERIA_NORTH", 8.552),
        west: envFloat("GEO_LIBERIA_WEST", -11.608),
        east: envFloat("GEO_LIBERIA_EAST", -7.367),
    },

    /**
     * Minimum number of DISTINCT (non-duplicate) vertices required for a
     * valid polygon ring, not counting the closing point that repeats the
     * first coordinate. A triangle is the simplest valid polygon.
     */
    MIN_DISTINCT_VERTICES: 3,

    /**
     * Two coordinates are considered "duplicates" of each other if both
     * their latitude and longitude differ by less than this amount
     * (decimal degrees). ~0.0000001 deg ≈ 1cm at the equator — far finer
     * than any realistic GPS/field-mapping precision, so this only
     * catches genuine accidental duplicate points (e.g. a double-tap
     * while drawing), not distinct-but-nearby real vertices.
     */
    DUPLICATE_POINT_EPSILON_DEG: envFloat("GEO_DUPLICATE_EPSILON_DEG", 0.0000001),

    /**
     * Three points are considered collinear (i.e. contributing zero area,
     * a degenerate "spike" rather than a real corner) if the triangle
     * they form has an area smaller than this fraction of the polygon's
     * bounding-box diagonal squared. Expressed as a relative tolerance
     * rather than an absolute one so it scales correctly for both a
     * quarter-hectare garden plot and a multi-hundred-hectare estate.
     */
    COLLINEARITY_RELATIVE_TOLERANCE: envFloat("GEO_COLLINEARITY_TOLERANCE", 1e-9),

    /**
     * A polygon's calculated area must exceed this many hectares to be
     * treated as "greater than zero" (guards against floating-point
     * noise around exactly 0, e.g. 0.0000000003 ha from a degenerate
     * sliver polygon).
     */
    MIN_VALID_AREA_HA: envFloat("GEO_MIN_VALID_AREA_HA", 0.001),

    /**
     * Declared-vs-calculated area comparison: a difference is flagged as
     * "material" (Needs Review) when it exceeds BOTH this percentage AND
     * this absolute hectare floor (the absolute floor avoids flagging
     * tiny farms where a 20% difference is only a few square meters).
     */
    AREA_DIFFERENCE_PERCENT_TOLERANCE: envFloat("GEO_AREA_DIFF_PERCENT_TOLERANCE", 15),
    AREA_DIFFERENCE_ABSOLUTE_HA_FLOOR: envFloat("GEO_AREA_DIFF_ABS_HA_FLOOR", 0.05),

    /**
     * GPS accuracy (meters) captured at the time of boundary point
     * collection. Above this value, the reading is considered outside
     * approved tolerance for EUDR-grade farm-boundary mapping and a
     * warning is raised (does NOT block submission by itself).
     */
    GPS_ACCURACY_WARNING_THRESHOLD_M: envFloat("GEO_GPS_ACCURACY_WARNING_M", 15),

    /**
     * "Unusual shape" heuristic: the ratio of the polygon's actual area
     * to the area of its convex hull. A value close to 1 means the shape
     * is close to convex/regular; a very low ratio means a highly
     * irregular, spiky, or self-crossing-adjacent shape that is unusual
     * for a real farm boundary and warrants a manual look.
     */
    MIN_CONVEXITY_RATIO: envFloat("GEO_MIN_CONVEXITY_RATIO", 0.15),

    /**
     * "Unusual shape" heuristic 2: maximum plausible perimeter-to-area
     * ("compactness") ratio. Computed as perimeter_m / sqrt(area_m2).
     * A perfect circle is ~3.5; a square is ~4. Very long, thin slivers
     * produce much higher ratios. Farms above this are flagged as
     * unusually-shaped (not blocked — just surfaced for review).
     */
    MAX_COMPACTNESS_RATIO: envFloat("GEO_MAX_COMPACTNESS_RATIO", 12),

    /**
     * Farm-to-farm overlap: two farm polygons are considered "overlapping"
     * (as opposed to merely touching at a shared boundary edge) if their
     * intersection area exceeds this many square meters. Small values
     * guard against floating point/edge-snapping false positives from
     * two farms that share a legitimate boundary line.
     */
    OVERLAP_MIN_INTERSECTION_M2: envFloat("GEO_OVERLAP_MIN_INTERSECTION_M2", 1),
};

export type GeoValidationConfig = typeof GEO_VALIDATION_CONFIG;
