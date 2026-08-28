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

            // 2. Farmer Registration Trend - last 6 REAL calendar months, zero-filled.
            //
            // Groups actual farmer.createdAt timestamps by calendar month (YYYY-MM, not just
            // "Mon" text, to avoid silently merging e.g. Jan 2025 and Jan 2026 into one bucket)
            // and always returns exactly the last 6 months ending with the current month, with
            // 0 for any month that had no registrations. This is real data - a month can
            // legitimately show 0 if nobody registered that month, and that's shown as-is
            // rather than being masked or replaced.
            // NOTE: group/order by the raw expression (not the "monthKey" alias) - Postgres
            // folds unquoted mixed-case aliases to lowercase, so referencing "monthKey" in
            // GROUP BY/ORDER BY throws 'column "monthkey" does not exist'. TypeORM's raw
            // result object still exposes the alias as given (r.monthKey) since that part is
            // just the SELECT column name, unaffected by the GROUP/ORDER BY clause issue.
            const rawTrend = await this.farmerRepository
                .createQueryBuilder("farmer")
                .select("TO_CHAR(farmer.createdAt, 'YYYY-MM')", "monthKey")
                .addSelect("COUNT(farmer.id)", "count")
                .groupBy("TO_CHAR(farmer.createdAt, 'YYYY-MM')")
                .orderBy("TO_CHAR(farmer.createdAt, 'YYYY-MM')", "ASC")
                .getRawMany();

            const countByMonthKey = new Map<string, number>(
                rawTrend.map(r => [r.monthKey, parseInt(r.count, 10)])
            );

            const now = new Date();
            const registrationTrend: { month: string; count: number }[] = [];
            for (let i = 5; i >= 0; i--) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                const monthLabel = d.toLocaleString('en-US', { month: 'short' });
                registrationTrend.push({ month: monthLabel, count: countByMonthKey.get(monthKey) || 0 });
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
