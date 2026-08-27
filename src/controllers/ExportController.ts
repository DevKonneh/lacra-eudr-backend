import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Farmer } from "../entities/Farmer";
import { Farm } from "../entities/Farm";
import { RiskAssessment } from "../entities/RiskAssessment";

/**
 * CSV Export for the Farmer & Farm Registry.
 *
 * One row per FARM (not per farmer) — a farmer with N farms produces N rows,
 * each sharing the same farmer_id but with its own unique farm_id/polygon.
 * Restricted to ADMIN (see export.routes.ts) since this is a full data dump.
 */

const CSV_COLUMNS = [
    "farmer_id",
    "farm_id",
    "qr_code_value",
    "farmer_name",
    "gender",
    "phone_number",
    "national_id",
    "county",
    "district",
    "community",
    "farm_name",
    "commodity",
    "farm_size_hectares",
    "latitude",
    "longitude",
    "polygon_wkt",
    "coordinate_system",
    "whimo_polygon_id",
    "mapping_source",
    "mapped_by",
    "mapping_date",
    "deforestation_status",
    "verification_status",
    "registration_date",
    "record_status",
    "last_updated",
] as const;

/**
 * Escape a single CSV field per RFC 4180: wrap in quotes and double any
 * embedded quotes whenever the value contains a comma, quote, or line break.
 * Values are always returned as plain strings — callers decide formatting
 * (e.g. forcing text-preservation with a leading apostrophe is NOT used here
 * since Excel/Sheets/most tools handle a quoted numeric-looking string fine
 * without corrupting leading zeros as long as it's quoted).
 */
function csvEscape(value: unknown): string {
    if (value === null || value === undefined) return "";
    const str = String(value);
    if (str === "") return "";
    if (/[",\n\r]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

function toCsvRow(values: unknown[]): string {
    return values.map(csvEscape).join(",") + "\r\n";
}

/** YYYY-MM-DD, blank if no valid date. */
function formatDate(date: Date | string | null | undefined): string {
    if (!date) return "";
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
}

/**
 * GeoJSON ring coordinates are [lng, lat]. Converts a GeoJSON Point/Polygon
 * geometry (as stored on Farm.location) into:
 *  - a representative [lat, lng] centroid-ish point (first vertex for a
 *    Polygon, or the Point's own coordinate)
 *  - a WKT string (POLYGON(...) or POINT(...))
 * Returns nulls if the geometry is missing/unrecognized so the CSV field is
 * simply left blank rather than throwing.
 */
function geometryToLatLngAndWkt(location: any): {
    lat: number | null;
    lng: number | null;
    wkt: string | null;
} {
    if (!location || typeof location !== "object") {
        return { lat: null, lng: null, wkt: null };
    }

    const type = location.type;
    const coordinates = location.coordinates;

    if (type === "Point" && Array.isArray(coordinates) && coordinates.length >= 2) {
        const [lng, lat] = coordinates;
        return {
            lat: typeof lat === "number" ? lat : null,
            lng: typeof lng === "number" ? lng : null,
            wkt: `POINT (${lng} ${lat})`,
        };
    }

    if (type === "Polygon" && Array.isArray(coordinates) && coordinates.length > 0) {
        const outerRing: [number, number][] = coordinates[0];
        if (!Array.isArray(outerRing) || outerRing.length === 0) {
            return { lat: null, lng: null, wkt: null };
        }

        // Centroid = simple average of the ring's vertices (excluding the
        // closing duplicate point if present). Good enough for a
        // representative lat/lng column; the full shape is preserved
        // losslessly in polygon_wkt.
        const pts = outerRing.filter(
            (p) => Array.isArray(p) && p.length >= 2 && typeof p[0] === "number" && typeof p[1] === "number"
        );
        const uniquePts =
            pts.length > 1 &&
            pts[0][0] === pts[pts.length - 1][0] &&
            pts[0][1] === pts[pts.length - 1][1]
                ? pts.slice(0, -1)
                : pts;

        let lat: number | null = null;
        let lng: number | null = null;
        if (uniquePts.length > 0) {
            const sumLng = uniquePts.reduce((sum, p) => sum + p[0], 0);
            const sumLat = uniquePts.reduce((sum, p) => sum + p[1], 0);
            lng = sumLng / uniquePts.length;
            lat = sumLat / uniquePts.length;
        }

        const ringWkt = outerRing
            .map((p) => `${p[0]} ${p[1]}`)
            .join(", ");
        const wkt = `POLYGON ((${ringWkt}))`;

        return { lat, lng, wkt };
    }

    return { lat: null, lng: null, wkt: null };
}

/** Truncate a number to a fixed number of decimals as a string, or "" if null. */
function formatCoord(n: number | null, decimals = 7): string {
    if (n === null || n === undefined || isNaN(n)) return "";
    return n.toFixed(decimals);
}

export class ExportController {
    private farmRepository = AppDataSource.getRepository(Farm);
    private riskRepository = AppDataSource.getRepository(RiskAssessment);

    /**
     * GET /api/export/farmers-farms.csv
     * Streams a UTF-8 CSV, one row per farm, joined to its parent farmer.
     * ADMIN-only (enforced in the route).
     */
    async exportFarmersFarmsCsv(req: Request, res: Response) {
        try {
            const farms = await this.farmRepository.find({
                relations: ["farmer"],
                order: { createdAt: "ASC" },
            });

            // Pull the latest risk assessment per farm (for deforestation /
            // verification-adjacent status) in one query rather than N+1.
            const farmIds = farms.map((f) => f.id);
            let latestRiskByFarmId = new Map<string, RiskAssessment>();
            if (farmIds.length > 0) {
                const assessments = await this.riskRepository
                    .createQueryBuilder("risk")
                    .where("risk.farmId IN (:...farmIds)", { farmIds })
                    .orderBy("risk.createdAt", "DESC")
                    .getMany();
                for (const a of assessments) {
                    if (!latestRiskByFarmId.has(a.farmId)) {
                        latestRiskByFarmId.set(a.farmId, a);
                    }
                }
            }

            // UTF-8 BOM so Excel (Windows) correctly detects encoding
            // instead of mis-rendering non-ASCII characters.
            const BOM = "\uFEFF";

            res.setHeader("Content-Type", "text/csv; charset=utf-8");
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="lacra_farmer_farm_registry_${formatDate(new Date())}.csv"`
            );

            res.write(BOM);
            res.write(toCsvRow(CSV_COLUMNS as unknown as string[]));

            for (const farm of farms) {
                const farmer = farm.farmer;
                if (!farmer) continue; // orphaned farm safety guard — should not happen

                const { lat, lng, wkt } = geometryToLatLngAndWkt(farm.location);
                const risk = latestRiskByFarmId.get(farm.id);

                const fullName = [farmer.firstName, farmer.lastName].filter(Boolean).join(" ").trim();

                // The stored `qrCode` column holds a rendered base64 PNG data
                // URL (the QR image itself), not the value encoded inside it
                // — that would bloat the CSV with huge base64 blobs and
                // isn't human-readable. Instead export the actual public
                // profile URL that was encoded into the QR at registration
                // time (see FarmerController.create), i.e. the real
                // "qr_code_value".
                const qrCodeValue = farmer.qrCode
                    ? `${process.env.FRONTEND_URL || "http://localhost:5173"}/public/farmers/${farmer.id}`
                    : "";

                const row = [
                    farmer.farmerId || "",                         // farmer_id
                    farm.id || "",                                  // farm_id
                    qrCodeValue,                                     // qr_code_value
                    fullName,                                        // farmer_name
                    farmer.gender || "",                             // gender
                    farmer.phoneNumber || "",                        // phone_number
                    farmer.nationalId || "",                         // national_id
                    farmer.region || "",                             // county (stored in `region`, see AuthController mapping)
                    farmer.district || "",                           // district
                    farmer.community || "",                          // community
                    farm.name || "",                                 // farm_name
                    farm.cropType || "",                             // commodity
                    farm.totalAreaHa != null ? farm.totalAreaHa : "",// farm_size_hectares
                    formatCoord(lat),                                // latitude
                    formatCoord(lng),                                // longitude
                    wkt || "",                                       // polygon_wkt
                    wkt ? "EPSG:4326" : "",                          // coordinate_system
                    "",                                              // whimo_polygon_id (not yet tracked — left blank)
                    farm.boundaryEvidence && farm.boundaryEvidence.length > 0
                        ? "GPS Field Mapping"
                        : (farm.location ? "Manual/Office Entry" : ""), // mapping_source
                    farmer.enumeratorName || "",                     // mapped_by
                    formatDate(farm.createdAt),                      // mapping_date
                    risk ? (risk.deforestationRisk ? "Flagged" : "Clear") : "",  // deforestation_status
                    farmer.identityStatus || "",                     // verification_status
                    formatDate(farmer.createdAt),                    // registration_date
                    farmer.isActive ? "Active" : "Inactive",         // record_status
                    formatDate(farm.updatedAt || farmer.updatedAt),  // last_updated
                ];

                res.write(toCsvRow(row));
            }

            res.end();
        } catch (error: any) {
            console.error("Error exporting farmers/farms CSV:", error);
            // Only attempt a JSON error response if nothing has been
            // streamed yet (headers not sent) — otherwise the CSV stream is
            // already open and we can only terminate the connection.
            if (!res.headersSent) {
                res.status(500).json({
                    status: false,
                    message: "Error exporting CSV",
                    errors: [error.message],
                });
            } else {
                res.end();
            }
        }
    }
}
