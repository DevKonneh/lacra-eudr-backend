import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Farmer } from "../entities/Farmer";
import { Farm } from "../entities/Farm";
import { Shipment } from "../entities/Shipment";
import { successResponse, errorResponse } from "../utils/response";

export class ReportsController {
    private farmerRepository = AppDataSource.getRepository(Farmer);
    private farmRepository = AppDataSource.getRepository(Farm);

    async getDashboardStats(req: Request, res: Response) {
        try {
            const totalFarmers = await this.farmerRepository.count();
            const totalFarms = await this.farmRepository.count();

            // LIVE risk counts, pulled directly from Farm.riskLevel - the field that
            // RiskService.analyzeFarm() actually writes after each real Whisp/satellite
            // assessment (see farm.riskLevel = overallRisk in RiskService.ts). This is the
            // SAME risk data shown on the Risk Analysis page and Farm Details page.
            //
            // NOTE: this replaces a previous, disconnected calculation that instead counted
            // farms whose polygon geometrically intersected 4 hand-drawn reference forest
            // boxes (Sapo/Gola/Kakum/Tai National Parks) seeded via RiskService.seedForests().
            // None of the real registered farms fall inside those illustrative boxes, so that
            // query always returned 0 "High Risk" / 100% compliant regardless of each farm's
            // actual, per-farm Whisp-driven risk assessment - which is why the dashboard looked
            // hardcoded/stuck even after a farm was correctly flagged Medium/High elsewhere in
            // the app. Farms that have never been assessed yet default to riskLevel="Low"
            // (see Farm entity default), so they correctly count as compliant until assessed.
            const highRiskCount = await this.farmRepository.count({ where: { riskLevel: "High" } });
            const mediumRiskCount = await this.farmRepository.count({ where: { riskLevel: "Medium" } });
            const lowRiskCount = await this.farmRepository.count({ where: { riskLevel: "Low" } });

            // "Compliant" = no EUDR risk flags at all (Low risk). Medium-risk farms (e.g.
            // pending legal document review, or Whisp's own "more_info_needed" verdict) are
            // NOT counted as compliant, since they still require follow-up before certification.
            const compliantFarms = lowRiskCount;
            const activeRisksQuery = highRiskCount;

            // Avoid division by zero
            const complianceRate = totalFarms > 0 ? (compliantFarms / totalFarms) * 100 : 0;

            // --- New Stats for Charts ---

            // 1. Shipment Status Stats
            const shipmentRepo = AppDataSource.getRepository(Shipment);
            const shipments = await shipmentRepo.find();
            const shipmentStats = {
                DRAFT: shipments.filter(s => s.status === 'DRAFT').length,
                VALIDATED: shipments.filter(s => s.status === 'VALIDATED').length,
                ISSUED: shipments.filter(s => s.status === 'ISSUED').length,
                SHIPPED: shipments.filter(s => s.status === 'SHIPPED').length,
            };

            // 2. Farmer Registration Trend (Last 6 Months)
            // Note: In a real app with huge data, do this aggregation in SQL. 
            // For MVP, we can fetch dates or simplified SQL group by.
            const rawTrend = await this.farmerRepository
                .createQueryBuilder("farmer")
                .select("TO_CHAR(farmer.createdAt, 'Mon')", "month")
                .addSelect("COUNT(farmer.id)", "count")
                .groupBy("month")
                .addGroupBy("EXTRACT(MONTH FROM farmer.createdAt)") // Order by month number
                .orderBy("EXTRACT(MONTH FROM farmer.createdAt)", "ASC")
                .getRawMany();

            // Map to clean format (if data is sparse, you might want to fill gaps, but let's keep it simple)
            const registrationTrend = rawTrend.map(r => ({
                month: r.month.trim(), // PG sometimes adds padding
                count: parseInt(r.count)
            }));

            // Fallback for demo if no trend data (since seeder bulk creates in one month)
            if (registrationTrend.length <= 1) {
                // Mock previous months for the "Trend" demo
                const months = ['Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan'];
                const result = months.map(m => {
                    if (m === 'Jan') return { month: m, count: totalFarmers }; // Current month has real data
                    return { month: m, count: Math.floor(Math.random() * 5) }; // Mock past data
                });
                // Assign the mock if real data is boring
                registrationTrend.splice(0, registrationTrend.length, ...result);
            }

            return successResponse(res, {
                totalFarmers,
                totalFarms,
                activeRisks: activeRisksQuery,
                mediumRisks: mediumRiskCount,
                compliantFarms,
                complianceRate: parseFloat(complianceRate.toFixed(1)),
                shipmentStats,
                registrationTrend
            });

        } catch (error: any) {
            console.error("Error generating reports", error);
            return errorResponse(res, "Error generating reports", [error.message], 500);
        }
    }

    /**
     * EUDR Farm-Mapping Admin Stats:
     * - Total farmers / total farms mapped
     * - Gender breakdown (Male / Female / Other / Unspecified)
     * - Crop-type breakdown (per CropType enum), e.g. "Cocoa Farms: 38, Rubber Farms: 27"
     * - Farms grouped by having a real polygon boundary vs a single-point/no boundary
     */
    async getFarmMappingStats(req: Request, res: Response) {
        try {
            const totalFarmers = await this.farmerRepository.count();
            const totalFarms = await this.farmRepository.count();

            // Gender breakdown (simple query, sorted in-memory to avoid composite-index issues)
            const genderRaw = await this.farmerRepository
                .createQueryBuilder("farmer")
                .select("COALESCE(farmer.gender, 'Unspecified')", "gender")
                .addSelect("COUNT(farmer.id)", "count")
                .groupBy("farmer.gender")
                .getRawMany();

            const genderBreakdown = {
                Male: 0,
                Female: 0,
                Other: 0,
                Unspecified: 0
            } as Record<string, number>;
            for (const row of genderRaw) {
                const key = (row.gender || 'Unspecified').trim();
                const count = parseInt(row.count, 10);
                if (key in genderBreakdown) {
                    genderBreakdown[key] += count;
                } else {
                    genderBreakdown[key] = (genderBreakdown[key] || 0) + count;
                }
            }

            // Crop-type breakdown (number of farms per crop)
            const cropRaw = await this.farmRepository
                .createQueryBuilder("farm")
                .select("farm.cropType", "cropType")
                .addSelect("COUNT(farm.id)", "count")
                .groupBy("farm.cropType")
                .getRawMany();

            const cropBreakdown = cropRaw.map(r => ({
                cropType: r.cropType,
                count: parseInt(r.count, 10)
            })).sort((a, b) => b.count - a.count);

            // Farms with a real drawn Polygon boundary vs synthetic/point-only
            const allFarms = await this.farmRepository.find({ select: ["id", "location"] });
            let farmsWithPolygon = 0;
            let farmsWithPointOnly = 0;
            for (const f of allFarms) {
                const loc = f.location as any;
                if (loc && loc.type === 'Polygon') farmsWithPolygon++;
                else farmsWithPointOnly++;
            }

            return successResponse(res, {
                totalFarmers,
                totalFarms,
                genderBreakdown,
                cropBreakdown,
                farmsWithPolygon,
                farmsWithPointOnly
            });
        } catch (error: any) {
            console.error("Error generating farm mapping stats", error);
            return errorResponse(res, "Error generating farm mapping stats", [error.message], 500);
        }
    }
}
