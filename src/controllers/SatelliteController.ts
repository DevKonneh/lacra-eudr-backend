import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Forest } from "../entities/Forest";
import { SatelliteAlert } from "../entities/SatelliteAlert";
import { successResponse, errorResponse } from "../utils/response";

export class SatelliteController {

    async getTemporalAnalysis(req: Request, res: Response) {
        try {
            // Real Data Analysis:
            // 1. Get total area of protected forests
            const forestRepo = AppDataSource.getRepository(Forest);

            // Note: ST_Area on 4326 returns degrees squared, which is not useful directly for "km2".
            // We'll just return the COUNT of protected areas for now, or assume proper projection in a real app.
            // For the demo, we show "Protected Areas Monitored"
            const forestCount = await forestRepo.count();
            const highRiskCount = await forestRepo.count({ where: { riskLevel: "HIGH" as any } });

            // Mock History Data for the Chart (hard to generate real historical data without a time-series DB)
            const data = [
                { year: '2020', forestCover: 85, deforestationRate: 0.5 },
                { year: '2021', forestCover: 84, deforestationRate: 1.2 },
                { year: '2022', forestCover: 83.5, deforestationRate: 0.8 },
                { year: '2023', forestCover: 83, deforestationRate: 0.6 },
                { year: '2024', forestCover: 82.8, deforestationRate: 0.2 },
            ];

            return successResponse(res, {
                region: "National Overview",
                riskLevel: highRiskCount > 0 ? "HIGH - Forests Detected" : "LOW - Clear",
                trend: "STABLE (Monitored)",
                history: data,
                stats: {
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
