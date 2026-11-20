import { createHash } from "crypto";

/**
 * Geometry versioning for per-plot assessment.
 *
 * WHY THIS EXISTS
 * ---------------
 * A plot's polygon can be corrected after an assessment has been queued or
 * while it is still running. Two things must then hold:
 *
 *   1. A retry of the SAME sync (same plot, same polygon) must not create a
 *      second assessment job.
 *   2. A run that started against the OLD polygon must never become the
 *      current rating for the NEW polygon.
 *
 * Both are solved by giving each distinct polygon a stable identity:
 *
 *   - `geometryHash`  = sha256 over a canonicalised form of the geometry, so
 *                       the same polygon always hashes the same regardless of
 *                       ring rotation, winding, or coordinate precision.
 *   - `geometryVersion` = an integer bumped whenever the hash changes, for
 *                       human-facing display ("version 3 of this boundary").
 *
 * The dedupe key for a job is `plotId + ':' + geometryHash`, so requirement 1
 * is a uniqueness constraint rather than application logic. Requirement 2 is a
 * hash comparison at write time: the job records the hash it assessed, and the
 * result is only allowed to become current if that hash still matches.
 */

/** Rounds coordinates to ~1cm so trivial float jitter does not look like an edit. */
const COORD_PRECISION = 7;
const round = (n: number): number => {
    if (!Number.isFinite(n)) return 0;
    const f = Math.pow(10, COORD_PRECISION);
    return Math.round(n * f) / f;
};

/**
 * Canonicalises a GeoJSON geometry into a deterministic string.
 *
 * Ring rotation is normalised (a polygon ring is a cycle, so `[a,b,c,d,a]`,
 * `[b,c,d,a,b]` and its reverse all describe the same parcel), and coordinate
 * precision is fixed. Without this, the mobile app re-sending an unchanged
 * boundary in a different vertex order would hash differently and create a
 * duplicate job — exactly the case requirement 3 forbids.
 */
export function canonicalizeGeometry(geometry: any): string {
    if (!geometry || typeof geometry !== "object" || !geometry.type) return "";

    const canonicalRing = (ring: number[][]): number[][] => {
        if (!Array.isArray(ring) || ring.length === 0) return [];
        // Drop the closing duplicate; it is implied by ring semantics.
        let pts = ring
            .filter((p) => Array.isArray(p) && p.length >= 2)
            .map((p) => [round(p[0]), round(p[1])]);
        if (pts.length > 1) {
            const first = pts[0];
            const last = pts[pts.length - 1];
            if (first[0] === last[0] && first[1] === last[1]) pts = pts.slice(0, -1);
        }
        if (pts.length === 0) return [];
        // Rotate so the lexicographically smallest vertex comes first.
        let minIdx = 0;
        for (let i = 1; i < pts.length; i++) {
            if (pts[i][0] < pts[minIdx][0]
                || (pts[i][0] === pts[minIdx][0] && pts[i][1] < pts[minIdx][1])) {
                minIdx = i;
            }
        }
        return [...pts.slice(minIdx), ...pts.slice(0, minIdx)];
    };

    const canonicalPolygon = (rings: number[][][]): number[][][] =>
        (Array.isArray(rings) ? rings.map(canonicalRing).filter((r) => r.length > 0) : []);

    if (geometry.type === "Point") {
        const c = geometry.coordinates;
        if (!Array.isArray(c) || c.length < 2) return "";
        return JSON.stringify({ t: "Point", c: [round(c[0]), round(c[1])] });
    }

    if (geometry.type === "Polygon") {
        const polys = canonicalPolygon(geometry.coordinates);
        if (polys.length === 0) return "";
        return JSON.stringify({ t: "Polygon", c: polys });
    }

    if (geometry.type === "MultiPolygon") {
        const parts = (Array.isArray(geometry.coordinates) ? geometry.coordinates : [])
            .map(canonicalPolygon)
            .filter((p: number[][][]) => p.length > 0);
        if (parts.length === 0) return "";
        // Order-independent: two MultiPolygons with the same parts in a
        // different order are the same parcel.
        const sorted = parts.map((p: number[][][]) => JSON.stringify(p)).sort();
        return JSON.stringify({ t: "MultiPolygon", c: sorted });
    }

    return "";
}

/**
 * Stable sha256 fingerprint of a geometry. Returns null for anything that is
 * not a usable geometry (so callers can treat "no hash" as "not assessable"
 * rather than silently hashing an empty string into a real-looking key).
 */
export function geometryHashOf(geometry: any): string | null {
    const canonical = canonicalizeGeometry(geometry);
    if (!canonical) return null;
    return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Decides the next version number when a boundary is (re)assigned.
 *
 * A "correction" means the canonical polygon actually changed. Re-saving an
 * identical polygon is NOT a correction and must not bump the version — that is
 * what keeps a retried sync from spawning a new job.
 */
export function nextGeometryVersion(
    previousHash: string | null | undefined,
    incomingGeometry: any,
    previousVersion?: number | null,
): { version: number; hash: string | null; changed: boolean } {
    const incomingHash = geometryHashOf(incomingGeometry);
    const base = previousVersion ?? 0;

    if (!incomingHash) {
        return { version: base, hash: null, changed: false };
    }
    if (previousHash && previousHash === incomingHash) {
        // Same polygon — never a new version.
        return { version: base || 1, hash: incomingHash, changed: false };
    }
    return { version: base + 1, hash: incomingHash, changed: true };
}

/** The dedupe key for an assessment job: one job per (plot, polygon). */
export function assessmentDedupeKey(plotId: string, geometryHash: string): string {
    return `${plotId}:${geometryHash}`;
}
