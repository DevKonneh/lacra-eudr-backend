import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Forest } from "../entities/Forest";
import { SatelliteAlert } from "../entities/SatelliteAlert";
import { successResponse, errorResponse } from "../utils/response";

export class SatelliteController {

    /**
     * National forest-cover trend.
     *
     * There is NO historical time-series store in this system, so a forest-cover
     * trend cannot be derived. This endpoint previously returned a HARDCODED
     * array (85%, 84%, 83.5%, 83%, 82.8%) presented to staff as measured national
     * figures, plus a hardcoded "trend: STABLE (Monitored)" and "Deforestation
     * rate has decreased to 0.2%". Those numbers were never computed from
     * anything - they were typed into the source.
     *
     * Returning fabricated national statistics alongside real per-farm satellite
     * results is actively misleading (staff would reasonably conclude LACRA
     * monitors national forest cover, and that deforestation is falling). This
     * now reports the figures as UNAVAILABLE and returns only the counts that
     * genuinely exist in the database.
     */
    async getTemporalAnalysis(req: Request, res: Response) {
        try {
            const forestRepo = AppDataSource.getRepository(Forest);

            // The only real, derivable numbers: how many reference forest /
            // protected-area polygons are loaded, and how many are HIGH risk.
            const forestCount = await forestRepo.count();
            const highRiskCount = await forestRepo.count({ where: { riskLevel: "HIGH" as any } });

            return successResponse(res, {
                region: "National Overview",
                // No national risk verdict exists; per-plot Whisp results are the
                // only satellite evidence this system produces.
                riskLevel: null,
                trend: null,
                // Explicitly unavailable rather than an empty array: an empty
                // array renders as "no data yet", whereas these figures have
                // never existed at all. The UI must show an unavailable state.
                historyAvailable: false,
                history: [],
                unavailableReason:
                    "No national forest-cover time series is stored in this system. Forest-cover trends and national deforestation rates are not computed here. Per-farm satellite assessment is available on demand from the farm's risk analysis page.",
                stats: {
                    // Real counts of the reference dataset, not national coverage.
                    totalForests: forestCount,
                    highRiskForests: highRiskCount
                }
            });
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error fetching satellite data", [error.message], 500);
        }
    }

    async getAlerts(req: Request, res: Response) {
        try {
            const alertRepo = AppDataSource.getRepository(SatelliteAlert);
            const alerts = await alertRepo.find({
                relations: ["farm", "farm.farmer"],
                order: { detectedAt: "DESC" },
                take: 100
            });
            return successResponse(res, alerts);
        } catch (error: any) {
            console.error(error);
            return errorResponse(res, "Error fetching satellite alerts", [error.message], 500);
        }
    }

    getTileConfig(_req: Request, res: Response) {
        return successResponse(res, {
            satellite: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            topographic: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png"
        });
    }
}
