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

        // 1. Deforestation Risk Check
        //
        // STANDARD: match Whisp's own official verdict exactly - the EU's own reference
        // methodology, and what an EU auditor testing against the Whisp API will expect
        // to see reflected in our system. We do NOT recompute our own approximation from
        // raw annual disturbance events. An earlier version of this code independently
        // flagged any post-2020 TMF_deg_* (degradation) event as automatic high risk -
        // but a real farm's own official Whisp HTML risk report (exported directly from
        // whisp.openforis.org on 2026-08-28) proved that mismatch: Whisp's own decision
        // tree did NOT count that same 0.077 ha 2024 degradation signal as "disturbance
        // after 2020" (Ind_04_disturbance_after_2020 = "no"), yet our code still flagged
        // the farm High. Trusting Whisp's own commodityRiskLabel directly removes that
        // divergence entirely.
        //
        // commodityRiskLabel is Whisp's pre-computed risk_pcrop / risk_acrop / risk_timber
        // field (whichever matches this farm's crop category) and can be one of three
        // real values - NOT just high/low:
        //   'high'             -> Whisp's own tree reached a definitive high-risk verdict.
        //   'low'              -> Whisp's own tree reached a definitive low-risk verdict.
        //   'more_info_needed' -> Whisp could not reach a definitive verdict (e.g. primary/
        //                         nat-regen forest present in 2020 with no clear later signal).
        //                         This is a real, distinct state - not equivalent to low -
        //                         so we surface it as our MEDIUM tier rather than silently
        //                         treating it as compliant.
        const commodityRiskLabel = this.getCommodityRiskLabel(whispResult, farm.cropType);
        const postBaselineEvents = whispResult
            ? whispResult.annualEvents.filter(e => e.year > 2020)
            : [];
        const deforestationRisk = whispResult
            ? commodityRiskLabel === 'high'
            : await this.checkDeforestation(farm); // Fallback to local logic (Whisp unavailable)
        const deforestationNeedsReview = whispResult ? commodityRiskLabel === 'more_info_needed' : false;

        // Build a plain-language, evidence-cited narrative explaining exactly WHY this
        // farm was classified the way it was - so an EU reviewer (or the farmer/inspector)
        // can see the actual satellite evidence behind the verdict, not just a label.
        const deforestationNarrative = this.buildDeforestationNarrative(
            whispResult, farm.cropType, commodityRiskLabel, postBaselineEvents, deforestationRisk
        );

        // 2. Overlap Risk Check
        const overlapResult = await this.checkOverlap(farm);

        // 3. Legality/Document Check
        const legalityRisk = await this.checkLegality(farmId);

        // 4. Traceability/Identity Check
        const traceabilityRisk = await this.checkTraceability(farm);

        // Calculate Overall Risk
        const overallRisk = this.calculateRiskScore(
            deforestationRisk, overlapResult, legalityRisk, traceabilityRisk, deforestationNeedsReview
        );

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
                notes: deforestationNarrative,
                narrative: deforestationNarrative,
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

    /**
     * Builds a plain-language, evidence-cited explanation of the deforestation
     * verdict, so an EU reviewer (or the farmer/inspector) can see exactly WHAT
     * satellite evidence led to the classification - not just a bare Yes/No label.
     *
     * Cites concrete numbers (hectares, years, dataset names) pulled straight from
     * the real Whisp/Earth Engine response, and is explicit about the EUDR
     * post-2020 cutoff rule so pre-2020 baseline forest overlap is never confused
     * with an actual violation.
     */
    private buildDeforestationNarrative(
        whispResult: WhispAnalysisResult | null,
        cropType: CropType,
        commodityRiskLabel: WhispRiskLabel,
        postBaselineEvents: WhispAnalysisResult['annualEvents'],
        deforestationRisk: boolean
    ): string {
        if (!whispResult) {
            return "Automated local analysis only (Open Foris Whisp satellite service was unavailable for this assessment) - " +
                   "no real satellite deforestation evidence could be retrieved for this plot.";
        }

        const lines: string[] = [];
        const area = whispResult.areaHa.toFixed(3);
        const loc = [whispResult.adminLevel1, whispResult.country].filter(Boolean).join(', ');

        lines.push(
            `Satellite analysis (Open Foris Whisp v${whispResult.whispVersion || 'n/a'}, Google Earth Engine) ` +
            `of a ${area} ha plot${loc ? ` in ${loc}` : ''}.`
        );

        const categoryLabel = this.cropCategoryLabel(cropType);
        const preCutoffEvents = whispResult.annualEvents.filter(e => e.year <= 2020);

        lines.push(
            `Whisp's own pre-computed ${categoryLabel} risk classification (${this.cropCategoryField(cropType)}) for this plot is "${commodityRiskLabel}" - ` +
            `this is the EU's own reference verdict for this plot and commodity category, and is what this system reports as the deforestation risk.`
        );

        if (commodityRiskLabel === 'high') {
            // HIGH: cite the specific post-2020 evidence, if Whisp surfaced any, for context.
            if (postBaselineEvents.length > 0) {
                const eventDescriptions = postBaselineEvents.map(e => {
                    const parts: string[] = [];
                    if (e.gfcLossHa) parts.push(`Hansen/GFC tree-cover loss ${e.gfcLossHa.toFixed(3)} ha`);
                    if (e.tmfDeforestationHa) parts.push(`JRC-TMF deforestation ${e.tmfDeforestationHa.toFixed(3)} ha`);
                    if (e.tmfDegradationHa) parts.push(`JRC-TMF degradation ${e.tmfDegradationHa.toFixed(3)} ha`);
                    if (e.raddAlertHa) parts.push(`RADD near-real-time alert ${e.raddAlertHa.toFixed(3)} ha`);
                    if (e.gladLAlertHa) parts.push(`GLAD-Landsat alert ${e.gladLAlertHa.toFixed(3)} ha`);
                    if (e.gladS2AlertHa) parts.push(`GLAD-Sentinel2 alert ${e.gladS2AlertHa.toFixed(3)} ha`);
                    return `${e.year}: ${parts.join(', ')}`;
                });
                lines.push(`Supporting evidence - post-2020 disturbance detected: ${eventDescriptions.join('; ')}.`);
            }
        } else if (commodityRiskLabel === 'more_info_needed') {
            // MORE INFO NEEDED: Whisp itself could not reach a definitive verdict. Explain the
            // likely reason (forest present in 2020 with no clear later signal either way) rather
            // than implying a clean pass.
            lines.push(
                `This means Whisp's decision tree could not conclusively determine low or high risk from ` +
                `available satellite signals alone (commonly because primary or naturally-regenerating forest ` +
                `was present on the plot as of the 2020 baseline, with no unambiguous later disturbance signal ` +
                `either way). This plot is flagged for manual/documentary review rather than auto-cleared.`
            );
        } else {
            // LOW/compliant: explain why, including addressing any pre-2020 baseline forest presence
            // so it's clear that was correctly NOT counted against the farm.
            lines.push(
                `No forest loss or degradation was counted by Whisp as occurring AFTER 31 Dec 2020 (the EUDR cutoff date) on this plot.`
            );
            if (whispResult.eufo2020Ha > 0) {
                lines.push(
                    `Note: this plot does overlap ${whispResult.eufo2020Ha.toFixed(3)} ha of the EU's 2020 forest-cover ` +
                    `BASELINE map (EUFO_2020), meaning the land was forested as of the reference snapshot date - but per ` +
                    `EUDR rules, this alone does not indicate non-compliance since Whisp did not count any disturbance ` +
                    `after the cutoff. This is disclosed for transparency, not counted as risk.`
                );
            }
        }

        if (preCutoffEvents.length > 0) {
            const years = preCutoffEvents.map(e => e.year).join(', ');
            lines.push(
                `Historical clearing/degradation signals were found for year(s) ${years}, all of which occurred ` +
                `BEFORE the EUDR cutoff.`
            );
        }

        if (whispResult.commodityOverlaps.length > 0) {
            const overlaps = whispResult.commodityOverlaps
                .map(c => `${c.commodity} (${c.datasetKey}): ${c.overlapHa.toFixed(3)} ha`)
                .join(', ');
            lines.push(`Commodity-mapping overlap detected: ${overlaps}.`);
        }

        return lines.join(' ');
    }

    /** Human-readable label for which Whisp risk category applies to a given crop. */
    private cropCategoryLabel(cropType: CropType): string {
        if (PERENNIAL_CROPS.has(cropType)) return 'perennial crop';
        if (ANNUAL_CROPS.has(cropType)) return 'annual crop';
        return 'timber';
    }

    /** Raw Whisp field name (risk_pcrop / risk_acrop / risk_timber) for a given crop's category. */
    private cropCategoryField(cropType: CropType): string {
        if (PERENNIAL_CROPS.has(cropType)) return 'risk_pcrop';
        if (ANNUAL_CROPS.has(cropType)) return 'risk_acrop';
        return 'risk_timber';
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
        traceability: boolean,
        deforestationNeedsReview: boolean = false
    ): RiskLevel {
        if (deforestation || overlap === OverlapResult.FOREST || overlap === OverlapResult.PROTECTED_AREA) {
            return RiskLevel.HIGH;
        }
        // Whisp itself could not reach a definitive low/high verdict for this commodity
        // category (risk_pcrop/risk_acrop/risk_timber = "more_info_needed") - surface this
        // as MEDIUM rather than silently treating it as compliant, since the EU's own tool
        // is flagging genuine uncertainty here, not a clean pass.
        if (legality || traceability || deforestationNeedsReview) {
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
