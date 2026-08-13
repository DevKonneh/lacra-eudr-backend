import { AppDataSource } from "../data-source";
import { Farm } from "../entities/Farm";
import { RiskAssessment, RiskLevel, OverlapResult } from "../entities/RiskAssessment";
import { SatelliteAlert } from "../entities/SatelliteAlert";
import { NotificationService } from "./NotificationService";
import { FarmDocument, DocumentStatus } from "../entities/FarmDocument";
import { Forest, RiskLevel as ForestRiskLevel } from "../entities/Forest";

import { WhispService, WhispAnalysisResult, WhispRiskLabel } from "./WhispService";
import { CropType } from "../entities/Farm";

/** Perennial tree crops map to Whisp's risk_pcrop label; annual crops map to risk_acrop. */
const PERENNIAL_CROPS = new Set<CropType>([CropType.COCOA, CropType.COFFEE, CropType.PALM, CropType.RUBBER]);
const ANNUAL_CROPS = new Set<CropType>([CropType.CASSAVA, CropType.VEGETABLES]);

export class RiskService {
    private farmRepo = AppDataSource.getRepository(Farm);
    private assessmentRepo = AppDataSource.getRepository(RiskAssessment);
    private documentRepo = AppDataSource.getRepository(FarmDocument);
    private forestRepo = AppDataSource.getRepository(Forest);
    private whispService = new WhispService();

    async analyzeFarm(farmId: string): Promise<RiskAssessment> {
        const farm = await this.farmRepo.findOne({
            where: { id: farmId },
            relations: ["farmer"]
        });

        if (!farm) throw new Error("Farm not found");

        // Call Open Foris Whisp for Deforestation Analysis
        const whispResult = await this.whispService.analyzeFarm(farmId, farm.location);

        // 1. Deforestation Risk Check (Enhanced with real Whisp EUDR indicators)
        // EUFO_2020 > 0 means the plot overlaps the EU's 2020 forest-cover baseline - the
        // primary EUDR deforestation signal. We also flag it if Whisp's own pre-computed
        // commodity-category risk label (matched to this farm's crop) comes back "high",
        // or if any post-2020 disturbance/tree-cover-loss event was detected on the plot.
        const commodityRiskLabel = this.getCommodityRiskLabel(whispResult, farm.cropType);
        const hasPostBaselineDisturbance = whispResult
            ? whispResult.annualEvents.some(e => e.year > 2020)
            : false;
        const deforestationRisk = whispResult
            ? (whispResult.eufo2020Ha > 0 || commodityRiskLabel === 'high' || hasPostBaselineDisturbance)
            : await this.checkDeforestation(farm); // Fallback to local logic

        // 2. Overlap Risk Check
        const overlapResult = await this.checkOverlap(farm);

        // 3. Legality/Document Check
        const legalityRisk = await this.checkLegality(farmId);

        // 4. Traceability/Identity Check
        const traceabilityRisk = await this.checkTraceability(farm);

        // Calculate Overall Risk
        const overallRisk = this.calculateRiskScore(deforestationRisk, overlapResult, legalityRisk, traceabilityRisk);

        // Save Assessment
        const assessment = this.assessmentRepo.create({
            farm,
            farmId: farm.id,
            deforestationRisk,
            overlapResult,
            legalityRisk,
            traceabilityRisk,
            overallRisk,
            whispAnalysisId: whispResult?.resultId,
            whispData: whispResult,
            details: {
                assessedAt: new Date(),
                notes: whispResult
                    ? `Analysis via Open Foris Whisp: EUFO_2020 overlap ${whispResult.eufo2020Ha.toFixed(3)} ha, ` +
                      `${farm.cropType} risk = ${commodityRiskLabel}${hasPostBaselineDisturbance ? ', post-2020 disturbance detected' : ''}.`
                    : "Automated local analysis (Whisp unavailable)",
                commodities: whispResult?.commodityOverlaps.map(c => c.commodity)
            }
        });

        await this.assessmentRepo.save(assessment);

        // Update Farm Status
        const previousRisk = farm.riskLevel;
        farm.riskLevel = overallRisk;
        farm.lastRiskAssessmentDate = new Date();
        await this.farmRepo.save(farm);

        // Create SatelliteAlert and notify when risk is HIGH
        if (overallRisk === RiskLevel.HIGH) {
            const alertRepo = AppDataSource.getRepository(SatelliteAlert);
            const alert = alertRepo.create({
                farm,
                farmId: farm.id,
                type: previousRisk !== overallRisk ? "RISK_CHANGE" : "DEFORESTATION",
                detectedAt: new Date(),
                status: "PENDING",
                metadata: { previousRisk: previousRisk || "Unknown", overlapResult }
            });
            await alertRepo.save(alert);

            await NotificationService.createForAdmins(
                "RISK_CHANGE",
                "High Risk Detected",
                `Farm "${farm.name}" (${farm.farmer?.firstName} ${farm.farmer?.lastName}) has been assessed as HIGH risk. ${overlapResult === OverlapResult.FOREST ? "Overlap with forest detected." : ""}`
            );
        }

        return assessment;
    }

    /**
     * Maps the farm's crop type to Whisp's pre-computed commodity-category risk label
     * (risk_pcrop for perennial tree crops, risk_acrop for annual crops, risk_timber otherwise).
     */
    private getCommodityRiskLabel(whispResult: WhispAnalysisResult | null, cropType: CropType): WhispRiskLabel {
        if (!whispResult) return 'unknown';
        if (PERENNIAL_CROPS.has(cropType)) return whispResult.riskPerennialCrop;
        if (ANNUAL_CROPS.has(cropType)) return whispResult.riskAnnualCrop;
        return whispResult.riskTimber;
    }

    private async checkDeforestation(farm: Farm): Promise<boolean> {
        // Mock Logic: If farm name contains "risk", simulate deforestation found
        // In reality, this would call Satellite API (Sentinel/GFW)
        if (farm.name.toLowerCase().includes("risk")) {
            return true;
        }
        return false;
    }

    private async checkOverlap(farm: Farm): Promise<OverlapResult> {
        // Check intersection with Forests/Protected Areas using PostGIS
        // Assuming 'location' is a GeoJSON Polygon
        // We use raw query for spatial intersection since TypeORM support varies

        try {
            // Check against Forests
            const forestOverlap = await this.forestRepo
                .createQueryBuilder("forest")
                .where("ST_Intersects(forest.geom, ST_GeomFromGeoJSON(:farmGeom))", {
                    farmGeom: JSON.stringify(farm.location)
                })
                .getOne();

            if (forestOverlap) return OverlapResult.FOREST;

            // Could also check against other farms here using separate query if needed
            // For now return NONE if no forest overlap
            return OverlapResult.NONE;

        } catch (error) {
            console.error("Spatial query error:", error);
            // Fallback for safety
            return OverlapResult.NONE;
        }
    }

    private async checkLegality(farmId: string): Promise<boolean> {
        const docs = await this.documentRepo.find({ where: { farmId } });

        // If no documents or any document is Invalid/Expired -> Risk
        if (docs.length === 0) return true;

        const hasInvalidDoc = docs.some(d => d.status === DocumentStatus.INVALID);
        if (hasInvalidDoc) return true;

        return false;
    }

    private async checkTraceability(farm: Farm): Promise<boolean> {
        // Identity Check: Only risk if identity is Conflict
        if (farm.farmer && farm.farmer.identityStatus === "Conflict") {
            return true;
        }
        return false;
    }

    private calculateRiskScore(
        deforestation: boolean,
        overlap: OverlapResult,
        legality: boolean,
        traceability: boolean
    ): RiskLevel {
        if (deforestation || overlap === OverlapResult.FOREST || overlap === OverlapResult.PROTECTED_AREA) {
            return RiskLevel.HIGH;
        }
        if (legality || traceability) {
            return RiskLevel.MEDIUM;
        }
        return RiskLevel.LOW;
    }

    async getHistory(farmId: string): Promise<RiskAssessment[]> {
        return this.assessmentRepo.find({
            where: { farmId },
            order: { createdAt: "DESC" }
        });
    }

    /**
     * Seeds/refreshes the reference `Forest` table used by checkOverlap()'s PostGIS
     * ST_Intersects query. Without any rows here, every farm's forest/protected-area
     * overlap check silently always returns OverlapResult.NONE.
     *
     * Idempotent: matches on `name` and updates the geometry if the entry already exists,
     * otherwise inserts a new row. Safe to call repeatedly (e.g. via POST /api/risk/seed).
     */
    async seedForests(): Promise<{ created: number; updated: number; total: number }> {
        const referenceForests: Array<{ name: string; riskLevel: ForestRiskLevel; geom: any }> = [
            {
                // Sapo National Park, Sinoe County, Liberia — largest protected rainforest in Liberia
                name: "Sapo National Park",
                riskLevel: ForestRiskLevel.HIGH,
                geom: {
                    type: "MultiPolygon",
                    coordinates: [[[
                        [-8.85, 5.10], [-8.35, 5.10], [-8.35, 5.60], [-8.85, 5.60], [-8.85, 5.10]
                    ]]]
                }
            },
            {
                // Gola Forest National Park, Liberia/Sierra Leone border — key remaining rainforest block
                name: "Gola Forest National Park",
                riskLevel: ForestRiskLevel.HIGH,
                geom: {
                    type: "MultiPolygon",
                    coordinates: [[[
                        [-10.90, 7.30], [-10.55, 7.30], [-10.55, 7.65], [-10.90, 7.65], [-10.90, 7.30]
                    ]]]
                }
            },
            {
                // Kakum National Park, Ghana — approximate bounding box
                name: "Kakum National Reserve",
                riskLevel: ForestRiskLevel.HIGH,
                geom: {
                    type: "MultiPolygon",
                    coordinates: [[[
                        [-1.50, 5.30], [-1.30, 5.30], [-1.30, 5.45], [-1.50, 5.45], [-1.50, 5.30]
                    ]]]
                }
            },
            {
                // Tai National Park, Cote d'Ivoire — UNESCO World Heritage rainforest, high EUDR relevance for cocoa
                name: "Tai National Park",
                riskLevel: ForestRiskLevel.HIGH,
                geom: {
                    type: "MultiPolygon",
                    coordinates: [[[
                        [-7.60, 5.75], [-7.10, 5.75], [-7.10, 6.35], [-7.60, 6.35], [-7.60, 5.75]
                    ]]]
                }
            },
        ];

        let created = 0;
        let updated = 0;

        for (const ref of referenceForests) {
            const existing = await this.forestRepo.findOne({ where: { name: ref.name } });
            if (existing) {
                existing.riskLevel = ref.riskLevel;
                existing.geom = ref.geom;
                await this.forestRepo.save(existing);
                updated++;
            } else {
                const forest = this.forestRepo.create({
                    name: ref.name,
                    riskLevel: ref.riskLevel,
                    geom: ref.geom
                });
                await this.forestRepo.save(forest);
                created++;
            }
        }

        const total = await this.forestRepo.count();
        return { created, updated, total };
    }
}
