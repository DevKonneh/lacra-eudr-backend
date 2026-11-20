import "reflect-metadata";
import {
    canonicalizeGeometry,
    geometryHashOf,
    nextGeometryVersion,
    assessmentDedupeKey,
} from "../GeometryVersioning";

/**
 * Geometry canonicalisation + versioning.
 *
 * WHY THESE TESTS MATTER MORE THAN THEY LOOK
 * ------------------------------------------
 * Every guarantee the automatic-assessment feature makes rests on "is this the
 * SAME polygon as before?". If canonicalisation is too strict, a retried sync
 * that re-sends an identical boundary in a different vertex order hashes
 * differently and creates a DUPLICATE job — the exact thing requirement 3
 * forbids. If it is too loose, a genuinely corrected boundary hashes the same
 * and is never re-assessed — silently keeping a stale verdict.
 *
 * These are pure functions, so they are tested directly with no DB or network.
 */

/** A real-shaped surveyed parcel in Liberia (not a rectangle). */
const PARCEL = {
    type: "Polygon",
    coordinates: [[
        [-10.8100, 6.2900],
        [-10.8050, 6.2912],
        [-10.8031, 6.2960],
        [-10.8099, 6.2951],
        [-10.8100, 6.2900], // closed ring
    ]],
};

describe("canonicalizeGeometry — same parcel, different representation", () => {
    it("ignores which vertex the ring starts at", () => {
        const ring = PARCEL.coordinates[0].slice(0, -1); // drop closing point
        // Re-emit the same cycle starting from index 2.
        const rotated = [...ring.slice(2), ...ring.slice(0, 2)];
        const poly = { type: "Polygon", coordinates: [[...rotated, rotated[0]]] };

        expect(canonicalizeGeometry(poly)).toBe(canonicalizeGeometry(PARCEL));
        expect(geometryHashOf(poly)).toBe(geometryHashOf(PARCEL));
    });

    it("ignores ring winding direction (clockwise vs counter-clockwise)", () => {
        const reversed = [...PARCEL.coordinates[0]].reverse();
        const poly = { type: "Polygon", coordinates: [reversed] };

        expect(geometryHashOf(poly)).toBe(geometryHashOf(PARCEL));
    });

    it("ignores float jitter below ~1cm (7 decimal places)", () => {
        const jittered = {
            type: "Polygon",
            coordinates: [PARCEL.coordinates[0].map(([x, y]) => [x + 1e-11, y - 1e-11])],
        };
        expect(geometryHashOf(jittered)).toBe(geometryHashOf(PARCEL));
    });

    it("ignores a redundant closing point being present or absent", () => {
        const open = {
            type: "Polygon",
            coordinates: [PARCEL.coordinates[0].slice(0, -1)],
        };
        expect(geometryHashOf(open)).toBe(geometryHashOf(PARCEL));
    });

    it("treats MultiPolygon parts as unordered", () => {
        const a = { type: "Polygon", coordinates: [[[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]].map(p => p)][0]] };
        const partA = { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] };
        const partB = { type: "Polygon", coordinates: [[[5, 5], [5, 6], [6, 6], [6, 5], [5, 5]]] };

        const mp1 = { type: "MultiPolygon", coordinates: [partA.coordinates, partB.coordinates] };
        const mp2 = { type: "MultiPolygon", coordinates: [partB.coordinates, partA.coordinates] };

        expect(geometryHashOf(mp1)).toBe(geometryHashOf(mp2));
        expect(a.type).toBe("Polygon");
    });
});

describe("canonicalizeGeometry — DIFFERENT parcels must not collide", () => {
    it("a genuinely moved vertex changes the hash", () => {
        const moved = {
            type: "Polygon",
            coordinates: [PARCEL.coordinates[0].map(([x, y], i) => (i === 2 ? [x + 0.0002, y] : [x, y]))],
        };
        expect(geometryHashOf(moved)).not.toBe(geometryHashOf(PARCEL));
    });

    it("a different shape with the same bounding box changes the hash", () => {
        // Same bbox as PARCEL, different interior vertex.
        const sameBBox = {
            type: "Polygon",
            coordinates: [[
                [-10.8100, 6.2900],
                [-10.8031, 6.2900],
                [-10.8031, 6.2960],
                [-10.8100, 6.2960],
                [-10.8100, 6.2900],
            ]],
        };
        expect(geometryHashOf(sameBBox)).not.toBe(geometryHashOf(PARCEL));
    });

    it("returns null for absent / unusable geometry rather than hashing an empty string", () => {
        // Critical: a null hash must mean "not assessable", so it can never be
        // turned into a real-looking dedupe key.
        expect(geometryHashOf(null)).toBeNull();
        expect(geometryHashOf(undefined)).toBeNull();
        expect(geometryHashOf({} as any)).toBeNull();
        expect(geometryHashOf({ type: "Polygon", coordinates: [] } as any)).toBeNull();
    });
});

describe("nextGeometryVersion — a retry must never look like a correction", () => {
    it("re-saving an identical polygon does NOT bump the version", () => {
        const first = nextGeometryVersion(null, PARCEL, 0);
        expect(first.changed).toBe(true);
        expect(first.version).toBe(1);

        const retry = nextGeometryVersion(first.hash, PARCEL, first.version);
        expect(retry.changed).toBe(false);
        expect(retry.version).toBe(1);
        expect(retry.hash).toBe(first.hash);
    });

    it("a corrected polygon DOES bump the version", () => {
        const first = nextGeometryVersion(null, PARCEL, 0);
        const moved = {
            type: "Polygon",
            coordinates: [PARCEL.coordinates[0].map(([x, y], i) => (i === 1 ? [x, y + 0.0003] : [x, y]))],
        };
        const second = nextGeometryVersion(first.hash, moved, first.version);

        expect(second.changed).toBe(true);
        expect(second.version).toBe(2);
        expect(second.hash).not.toBe(first.hash);
    });

    it("a retry that differs only by vertex order is NOT a correction", () => {
        const first = nextGeometryVersion(null, PARCEL, 0);
        const ring = PARCEL.coordinates[0].slice(0, -1);
        const rotated = [...ring.slice(3), ...ring.slice(0, 3)];
        const retried = { type: "Polygon", coordinates: [[...rotated, rotated[0]]] };

        const again = nextGeometryVersion(first.hash, retried, first.version);
        expect(again.changed).toBe(false);
        expect(again.version).toBe(1);
    });
});

describe("assessmentDedupeKey", () => {
    it("is stable for the same plot + polygon, and differs per plot", () => {
        const h = geometryHashOf(PARCEL)!;
        expect(assessmentDedupeKey("plot-a", h)).toBe(assessmentDedupeKey("plot-a", h));
        expect(assessmentDedupeKey("plot-a", h)).not.toBe(assessmentDedupeKey("plot-b", h));
    });

    it("differs when the polygon changes, which is what allows a new job", () => {
        const h1 = geometryHashOf(PARCEL)!;
        const moved = {
            type: "Polygon",
            coordinates: [PARCEL.coordinates[0].map(([x, y], i) => (i === 2 ? [x + 0.0002, y] : [x, y]))],
        };
        const h2 = geometryHashOf(moved)!;
        expect(assessmentDedupeKey("plot-a", h1)).not.toBe(assessmentDedupeKey("plot-a", h2));
    });
});
