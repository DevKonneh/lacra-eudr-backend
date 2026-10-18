import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Farmer } from "../entities/Farmer";
import { Farm } from "../entities/Farm";
import { Shipment } from "../entities/Shipment";
import { Batch } from "../entities/Batch";
import { License, LicenseStatus } from "../entities/License";
import { Permit, PermitStatus } from "../entities/Permit";
import { Inspection, InspectionStatus } from "../entities/Inspection";
import { QualityControl, QCResult } from "../entities/QualityControl";
import { successResponse, errorResponse } from "../utils/response";

/**
 * Shared shape for the query-string filters every dashboard indicator
 * (and its underlying drill-down) can be scoped by. All are OPTIONAL —
 * an unfiltered request returns platform-wide totals exactly as before.
 *
 *   dateFrom / dateTo   - ISO date strings, applied to the record's own
 *                          "registered/created" timestamp:
 *                            Farmer  -> farmer.createdAt
 *                            Farm    -> farm.createdAt
 *   county               - matched against Farmer.region (the field this
 *                           codebase already uses AS "county" - see
 *                           FarmerController.search()'s `county: f.region`
 *                           projection). Applied to farms via their
 *                           owning farmer's region.
 *   district              - Farmer.district (farms via owning farmer).
 *   commodity             - Farm's active commodity name. Checked against
 *                           BOTH the new Plot/PlotCommodity model AND the
 *                           legacy farm.cropType column, so it works
 *                           whether or not a farm has been migrated.
 *   gender                - Farmer.gender (Male/Female/Other).
 *   complianceStatus      - "Compliant" | "Needs Review" | "High Risk"
 *                           mapped onto Farm.riskLevel + geometryStatus
 *                           using the EXACT SAME rule as compliantFarms
 *                           below, so a filtered count always matches an
 *                           unfiltered one restricted to that bucket.
 *   verificationStatus    - Farmer.identityStatus (Verified/Unverified/Conflict).
 */
interface DashboardFilters {
    dateFrom?: string;
    dateTo?: string;
    county?: string;
    district?: string;
    commodity?: string;
    gender?: string;
    complianceStatus?: string;
    verificationStatus?: string;
}

function readFilters(req: Request): DashboardFilters {
    const q = req.query;
    const str = (v: any): string | undefined => {
        const s = Array.isArray(v) ? v[0] : v;
        return typeof s === "string" && s.trim() !== "" ? s.trim() : undefined;
    };
    return {
        dateFrom: str(q.dateFrom),
        dateTo: str(q.dateTo),
        county: str(q.county),
        district: str(q.district),
        commodity: str(q.commodity),
        gender: str(q.gender),
        complianceStatus: str(q.complianceStatus),
        verificationStatus: str(q.verificationStatus),
    };
}

// "Compliant" / "Needs Review" / "High Risk" bucket definitions - a
// SINGLE authoritative mapping used both to COUNT each bucket for the
// dashboard's risk-distribution pie AND to FILTER farms/farmers when a
// bucket's number or pie-slice is clicked, so the two can never disagree.
//   Compliant:    riskLevel = Low   AND geometryStatus = Valid
//   Needs Review: riskLevel = Medium, OR (riskLevel = Low but geometry
//                 is not yet Valid - i.e. compliance can't be certified)
//   High Risk:    riskLevel = High
function complianceStatusWhereSql(alias: string, status: string): { sql: string; params: Record<string, any> } {
    if (status === "Compliant") {
        return { sql: `${alias}.riskLevel = :cs_low AND ${alias}.geometryStatus = :cs_valid`, params: { cs_low: "Low", cs_valid: "Valid" } };
    }
    if (status === "High Risk") {
        return { sql: `${alias}.riskLevel = :cs_high`, params: { cs_high: "High" } };
    }
    // "Needs Review" (default / anything else recognized)
    return {
        sql: `(${alias}.riskLevel = :cs_medium OR (${alias}.riskLevel = :cs_low2 AND ${alias}.geometryStatus != :cs_valid2))`,
        params: { cs_medium: "Medium", cs_low2: "Low", cs_valid2: "Valid" },
    };
}

export class ReportsController {
    private farmerRepository = AppDataSource.getRepository(Farmer);
    private farmRepository = AppDataSource.getRepository(Farm);

    /**
     * Builds a Farm query-builder with every applicable filter applied via
     * a LEFT JOIN to `farmer` (needed for county/district/gender/
     * verificationStatus, which live on Farmer) and a LEFT JOIN to
     * `plots`/`plotCommodities` (needed for the commodity filter's
     * multi-commodity check). Shared by every farm-based indicator so the
     * "Ensure all dashboard totals match ... Farm Registry" requirement
     * holds by construction - every count is filtered identically.
     */
    private farmQuery(filters: DashboardFilters) {
        // IMPORTANT: do NOT LEFT JOIN plot/plotCommodity here. A farm can
        // have multiple plots (and a plot multiple active commodities), so
        // joining them fans a single farm row out into N rows. That fanout
        // is harmless for getCount()-style queries (TypeORM's getCount()
        // always does a COUNT(DISTINCT farm.id) under the hood) but it
        // SILENTLY INFLATES any SUM()/AVG() built on top of this same
        // query builder - e.g. totalMappedHectares summed farm.totalAreaHa
        // once per joined plot/commodity row instead of once per farm,
        // overstating the real hectare total. The commodity filter below
        // uses an EXISTS subquery instead, which has identical filtering
        // semantics without introducing any row fanout.
        const qb = this.farmRepository
            .createQueryBuilder("farm")
            .leftJoin("farm.farmer", "farmer");

        if (filters.dateFrom) qb.andWhere("farm.createdAt >= :dateFrom", { dateFrom: filters.dateFrom });
        if (filters.dateTo) qb.andWhere("farm.createdAt <= :dateTo", { dateTo: filters.dateTo + " 23:59:59" });
        if (filters.county) qb.andWhere("farmer.region ILIKE :county", { county: filters.county });
        if (filters.district) qb.andWhere("farmer.district ILIKE :district", { district: filters.district });
        if (filters.gender) qb.andWhere("farmer.gender = :gender", { gender: filters.gender });
        if (filters.verificationStatus) qb.andWhere("farmer.identityStatus = :vs", { vs: filters.verificationStatus });
        if (filters.commodity) {
            qb.andWhere(
                `(EXISTS (
                    SELECT 1 FROM plot p
                    INNER JOIN plot_commodity pc ON pc."plotId" = p.id
                    WHERE p."farmId" = farm.id AND p."isActive" = true AND pc."isActive" = true
                      AND pc."commodityName" ILIKE :commodity
                ) OR farm.cropType ILIKE :commodity)`,
                { commodity: `%${filters.commodity}%` }
            );
        }
        if (filters.complianceStatus) {
            const { sql, params } = complianceStatusWhereSql("farm", filters.complianceStatus);
            qb.andWhere(sql, params);
        }
        return qb;
    }

    /** Same idea as farmQuery(), but rooted on Farmer for farmer-based indicators. */
    private farmerQuery(filters: DashboardFilters) {
        const qb = this.farmerRepository
            .createQueryBuilder("farmer")
            .leftJoin("farmer.farms", "farm");

        if (filters.dateFrom) qb.andWhere("farmer.createdAt >= :dateFrom", { dateFrom: filters.dateFrom });
        if (filters.dateTo) qb.andWhere("farmer.createdAt <= :dateTo", { dateTo: filters.dateTo + " 23:59:59" });
        if (filters.county) qb.andWhere("farmer.region ILIKE :county", { county: filters.county });
        if (filters.district) qb.andWhere("farmer.district ILIKE :district", { district: filters.district });
        if (filters.gender) qb.andWhere("farmer.gender = :gender", { gender: filters.gender });
        if (filters.verificationStatus) qb.andWhere("farmer.identityStatus = :vs", { vs: filters.verificationStatus });
        return qb;
    }

    /**
     * Main dashboard indicator set. Every number below has ONE, clearly
     * separate calculation - per the "do not combine verification,
     * completeness and compliance into one percentage" rule, each of
     * verifiedFarmerRate / geometryValidRate / complianceRate is returned
     * independently and NEVER blended together.
     *
     * Accepts the DashboardFilters query params documented above; every
     * count/breakdown respects them identically, and `reportingPeriod` +
     * `generatedAt` are echoed back so the UI can show what window the
     * numbers describe and when they were computed.
     */
    async getDashboardStats(req: Request, res: Response) {
        try {
            const filters = readFilters(req);

            // ---- Farmer indicators ----
            const totalFarmers = await this.farmerQuery(filters).getCount();
            const verifiedFarmers = await this.farmerQuery(filters)
                .andWhere("farmer.identityStatus = :verified", { verified: "Verified" })
                .getCount();

            const genderRaw = await this.farmerQuery(filters)
                .select("COALESCE(farmer.gender, 'Unspecified')", "gender")
                .addSelect("COUNT(DISTINCT farmer.id)", "count")
                .groupBy("farmer.gender")
                .getRawMany();
            const genderBreakdown = { Male: 0, Female: 0, Other: 0, Unspecified: 0 } as Record<string, number>;
            for (const row of genderRaw) {
                const key = (row.gender || "Unspecified").trim();
                const count = parseInt(row.count, 10);
                genderBreakdown[key] = (genderBreakdown[key] || 0) + count;
            }

            // ---- Farm indicators ----
            const totalFarms = await this.farmQuery(filters).getCount();

            const totalMappedHectaresRaw = await this.farmQuery(filters)
                .select("COALESCE(SUM(farm.totalAreaHa), 0)", "sum")
                .getRawOne();
            const totalMappedHectares = parseFloat(totalMappedHectaresRaw?.sum || "0");

            const farmsWithValidPolygons = await this.farmQuery(filters)
                .andWhere("farm.geometryStatus = :valid", { valid: "Valid" })
                .getCount();

            const farmsNeedingCorrection = await this.farmQuery(filters)
                .andWhere("farm.geometryStatus IN (:...needsCorrection)", { needsCorrection: ["Invalid", "Needs Review", "Missing"] })
                .getCount();

            const compliantFarms = await this.farmQuery(filters)
                .andWhere("farm.riskLevel = :low AND farm.geometryStatus = :valid2", { low: "Low", valid2: "Valid" })
                .getCount();
            const mediumRiskFarms = await this.farmQuery(filters)
                .andWhere("(farm.riskLevel = :medium OR (farm.riskLevel = :low3 AND farm.geometryStatus != :valid3))", { medium: "Medium", low3: "Low", valid3: "Valid" })
                .getCount();
            const highRiskFarms = await this.farmQuery(filters)
                .andWhere("farm.riskLevel = :high", { high: "High" })
                .getCount();

            // Avoid division by zero; compliance % is ALWAYS reported
            // separately from verification/geometry rates (never blended).
            const complianceRate = totalFarms > 0 ? (compliantFarms / totalFarms) * 100 : 0;
            const verifiedFarmerRate = totalFarmers > 0 ? (verifiedFarmers / totalFarmers) * 100 : 0;
            const geometryValidRate = totalFarms > 0 ? (farmsWithValidPolygons / totalFarms) * 100 : 0;

            // Farms by county (Farmer.region, the field this codebase uses
            // as "county" everywhere else - see module doc comment above).
            const countyRaw = await this.farmQuery(filters)
                .select("COALESCE(farmer.region, 'Unspecified')", "county")
                .addSelect("COUNT(DISTINCT farm.id)", "count")
                .groupBy("farmer.region")
                .orderBy("count", "DESC")
                .getRawMany();
            const farmsByCounty = countyRaw.map((r) => ({ county: r.county, count: parseInt(r.count, 10) }));

            // Farms by commodity - uses the NEW Plot/PlotCommodity model
            // first (distinct active commodity names across a farm's
            // active plots), falling back to the legacy single cropType
            // column only for farms that have no PlotCommodity rows at
            // all yet (pre-migration records). This avoids the old bug of
            // only ever reflecting a farm's single legacy cropType.
            // This query WANTS the plot/plotCommodity fanout (it groups by
            // commodity name and counts DISTINCT farms per group), so the
            // join is added locally here rather than in the shared
            // farmQuery() builder used by every other (non-grouped) count/
            // sum indicator above.
            const commodityFromPlotsRaw = await this.farmQuery(filters)
                .leftJoin("farm.plots", "plot")
                .leftJoin("plot.plotCommodities", "pc")
                .andWhere("pc.isActive = true")
                .andWhere("plot.isActive = true")
                .select("pc.commodityName", "commodity")
                .addSelect("COUNT(DISTINCT farm.id)", "count")
                .groupBy("pc.commodityName")
                .getRawMany();
            const farmsByCommodity = commodityFromPlotsRaw.map((r) => ({ commodity: r.commodity, count: parseInt(r.count, 10) }));
            if (farmsByCommodity.length === 0) {
                // No farm has been through the multi-commodity flow yet
                // in this filtered set - fall back to legacy cropType so
                // the indicator is never silently empty.
                const legacyRaw = await this.farmQuery(filters)
                    .andWhere("farm.cropType IS NOT NULL")
                    .select("farm.cropType", "commodity")
                    .addSelect("COUNT(DISTINCT farm.id)", "count")
                    .groupBy("farm.cropType")
                    .getRawMany();
                farmsByCommodity.push(...legacyRaw.map((r) => ({ commodity: r.commodity, count: parseInt(r.count, 10) })));
            }
            farmsByCommodity.sort((a, b) => b.count - a.count);

            // ---- Licenses & Permits ----
            // "Active" = currently valid for use (LICENSE_ISSUED/ACTIVE for
            // licenses, PERMIT_ISSUED for permits - the only Permit status
            // that represents a finished, usable permit) AND (no validTo
            // set, OR validTo is still in the future). "Expiring" = active
            // AND validTo falls within the next 30 days (configurable
            // below via EXPIRING_WINDOW_DAYS).
            const EXPIRING_WINDOW_DAYS = 30;
            const now = new Date();
            const expiringCutoff = new Date(now.getTime() + EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

            const licenseRepo = AppDataSource.getRepository(License);
            const permitRepo = AppDataSource.getRepository(Permit);

            const activeLicenses = await licenseRepo
                .createQueryBuilder("license")
                .where("license.status IN (:...activeStatuses)", { activeStatuses: [LicenseStatus.LICENSE_ISSUED, LicenseStatus.ACTIVE] })
                .andWhere("(license.validTo IS NULL OR license.validTo >= :now)", { now })
                .getCount();
            const expiringLicenses = await licenseRepo
                .createQueryBuilder("license")
                .where("license.status IN (:...activeStatuses2)", { activeStatuses2: [LicenseStatus.LICENSE_ISSUED, LicenseStatus.ACTIVE] })
                .andWhere("license.validTo IS NOT NULL AND license.validTo >= :now2 AND license.validTo <= :cutoff", { now2: now, cutoff: expiringCutoff })
                .getCount();

            const activePermits = await permitRepo
                .createQueryBuilder("permit")
                .where("permit.status = :issued", { issued: PermitStatus.PERMIT_ISSUED })
                .andWhere("(permit.validTo IS NULL OR permit.validTo >= :now3)", { now3: now })
                .getCount();
            const expiringPermits = await permitRepo
                .createQueryBuilder("permit")
                .where("permit.status = :issued2", { issued2: PermitStatus.PERMIT_ISSUED })
                .andWhere("permit.validTo IS NOT NULL AND permit.validTo >= :now4 AND permit.validTo <= :cutoff2", { now4: now, cutoff2: expiringCutoff })
                .getCount();

            // ---- Inspections & Quality ----
            const inspectionRepo = AppDataSource.getRepository(Inspection);
            const activeInspections = await inspectionRepo
                .createQueryBuilder("inspection")
                .where("inspection.status IN (:...activeInspStatuses)", { activeInspStatuses: [InspectionStatus.SCHEDULED, InspectionStatus.IN_PROGRESS] })
                .getCount();

            const qcRepo = AppDataSource.getRepository(QualityControl);
            const pendingQualityTests = await qcRepo
                .createQueryBuilder("qc")
                .where("qc.result = :pending", { pending: QCResult.PENDING })
                .getCount();

            // ---- Traceability & Shipments ----
            // "Traceable batches" = batches that can be traced back to a
            // specific farm/plot/commodity source (Task A's traceability
            // model) rather than an unattributed pooled batch.
            const batchRepo = AppDataSource.getRepository(Batch);
            const traceableBatches = await batchRepo
                .createQueryBuilder("batch")
                .where("batch.farmId IS NOT NULL")
                .getCount();
            const totalBatches = await batchRepo.count();

            // "Active shipments" = any shipment that has left DRAFT (i.e.
            // is actually moving through the export pipeline: VALIDATED,
            // ISSUED, or SHIPPED) as opposed to an unsubmitted draft.
            const shipmentRepo = AppDataSource.getRepository(Shipment);
            const shipments = await shipmentRepo.find();
            const shipmentStats = {
                DRAFT: shipments.filter((s) => s.status === "DRAFT").length,
                VALIDATED: shipments.filter((s) => s.status === "VALIDATED").length,
                ISSUED: shipments.filter((s) => s.status === "ISSUED").length,
                SHIPPED: shipments.filter((s) => s.status === "SHIPPED").length,
            };
            const activeShipments = shipmentStats.VALIDATED + shipmentStats.ISSUED + shipmentStats.SHIPPED;

            // ---- Registration trend (last 6 real calendar months, zero-filled) ----
            const trendQb = this.farmerRepository
                .createQueryBuilder("farmer")
                .select("TO_CHAR(farmer.createdAt, 'YYYY-MM')", "monthKey")
                .addSelect("COUNT(farmer.id)", "count")
                .groupBy("TO_CHAR(farmer.createdAt, 'YYYY-MM')")
                .orderBy("TO_CHAR(farmer.createdAt, 'YYYY-MM')", "ASC");
            if (filters.county) trendQb.andWhere("farmer.region ILIKE :county", { county: filters.county });
            if (filters.district) trendQb.andWhere("farmer.district ILIKE :district", { district: filters.district });
            if (filters.gender) trendQb.andWhere("farmer.gender = :gender", { gender: filters.gender });
            if (filters.verificationStatus) trendQb.andWhere("farmer.identityStatus = :vs", { vs: filters.verificationStatus });
            const rawTrend = await trendQb.getRawMany();
            const countByMonthKey = new Map<string, number>(rawTrend.map((r) => [r.monthKey, parseInt(r.count, 10)]));
            const registrationTrend: { month: string; count: number }[] = [];
            for (let i = 5; i >= 0; i--) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
                const monthLabel = d.toLocaleString("en-US", { month: "short" });
                registrationTrend.push({ month: monthLabel, count: countByMonthKey.get(monthKey) || 0 });
            }

            // Reporting period: explicit if the caller supplied a date
            // range filter, otherwise "All time" (the platform's full
            // history) - always stated so the UI never leaves users
            // guessing what window a number covers.
            const reportingPeriod = filters.dateFrom || filters.dateTo
                ? `${filters.dateFrom || 'Earliest record'} to ${filters.dateTo || 'Present'}`
                : "All time";

            return successResponse(res, {
                reportingPeriod,
                generatedAt: now.toISOString(),
                filtersApplied: filters,

                // Farmer indicators
                totalFarmers,
                verifiedFarmers,
                verifiedFarmerRate: parseFloat(verifiedFarmerRate.toFixed(1)),
                genderBreakdown,

                // Farm / geometry indicators
                totalFarms,
                totalMappedHectares: parseFloat(totalMappedHectares.toFixed(2)),
                farmsWithValidPolygons,
                farmsNeedingCorrection,
                geometryValidRate: parseFloat(geometryValidRate.toFixed(1)),

                // Compliance / risk indicators (kept SEPARATE from verification/geometry rates)
                compliantFarms,
                mediumRiskFarms,
                highRiskFarms,
                complianceRate: parseFloat(complianceRate.toFixed(1)),

                // Legacy aliases (kept so any not-yet-updated caller of this
                // endpoint doesn't break): activeRisks === highRiskFarms,
                // mediumRisks === mediumRiskFarms, geometryNeedsAttentionCount === farmsNeedingCorrection.
                activeRisks: highRiskFarms,
                mediumRisks: mediumRiskFarms,
                geometryNeedsAttentionCount: farmsNeedingCorrection,

                // Breakdown indicators
                farmsByCounty,
                farmsByCommodity,

                // Licensing
                activeLicenses,
                expiringLicenses,
                activePermits,
                expiringPermits,
                expiringWindowDays: EXPIRING_WINDOW_DAYS,

                // Inspectorate / QC / traceability / logistics
                activeInspections,
                pendingQualityTests,
                traceableBatches,
                totalBatches,
                activeShipments,
                shipmentStats,

                registrationTrend,
            });
        } catch (error: any) {
            console.error("Error generating reports", error);
            return errorResponse(res, "Error generating reports", [error.message], 500);
        }
    }

    /**
     * LEGACY endpoint - kept for backward compatibility with any caller
     * still hitting /reports/farm-mapping-stats directly. Its data is now
     * a strict subset of getDashboardStats() above (which is the endpoint
     * the rebuilt Dashboard.tsx actually calls), reimplemented here using
     * the SAME farmQuery/farmerQuery filtering helpers so the two never
     * drift apart. `farmsWithPolygon` here is now based on the real
     * `geometryStatus` field rather than a raw GeoJSON type check, fixing
     * the previous bug where a nominally-Polygon-typed but geometrically
     * INVALID farm still counted as "has polygon".
     */
    async getFarmMappingStats(req: Request, res: Response) {
        try {
            const filters = readFilters(req);
            const totalFarmers = await this.farmerQuery(filters).getCount();
            const totalFarms = await this.farmQuery(filters).getCount();

            const genderRaw = await this.farmerQuery(filters)
                .select("COALESCE(farmer.gender, 'Unspecified')", "gender")
                .addSelect("COUNT(DISTINCT farmer.id)", "count")
                .groupBy("farmer.gender")
                .getRawMany();
            const genderBreakdown = { Male: 0, Female: 0, Other: 0, Unspecified: 0 } as Record<string, number>;
            for (const row of genderRaw) {
                const key = (row.gender || "Unspecified").trim();
                genderBreakdown[key] = (genderBreakdown[key] || 0) + parseInt(row.count, 10);
            }

            const cropRaw = await this.farmQuery(filters)
                .select("farm.cropType", "cropType")
                .addSelect("COUNT(DISTINCT farm.id)", "count")
                .groupBy("farm.cropType")
                .getRawMany();
            const cropBreakdown = cropRaw
                .filter((r) => r.cropType)
                .map((r) => ({ cropType: r.cropType, count: parseInt(r.count, 10) }))
                .sort((a, b) => b.count - a.count);

            const farmsWithPolygon = await this.farmQuery(filters).andWhere("farm.geometryStatus = :valid", { valid: "Valid" }).getCount();
            const farmsWithPointOnly = totalFarms - farmsWithPolygon;

            return successResponse(res, {
                totalFarmers,
                totalFarms,
                genderBreakdown,
                cropBreakdown,
                farmsWithPolygon,
                farmsWithPointOnly,
            });
        } catch (error: any) {
            console.error("Error generating farm mapping stats", error);
            return errorResponse(res, "Error generating farm mapping stats", [error.message], 500);
        }
    }

    /**
     * Calculation-details endpoint for the "compliance percentage" drill-
     * down: returns the exact numerator/denominator and rule text behind
     * complianceRate, plus the SAME filters, so clicking the compliance %
     * on the dashboard can open a page that shows precisely how it was
     * computed (per the "Clicking the compliance percentage opens its
     * calculation details" requirement).
     */
    async getComplianceCalculationDetails(req: Request, res: Response) {
        try {
            const filters = readFilters(req);
            const totalFarms = await this.farmQuery(filters).getCount();
            const compliantFarms = await this.farmQuery(filters)
                .andWhere("farm.riskLevel = :low AND farm.geometryStatus = :valid", { low: "Low", valid: "Valid" })
                .getCount();
            const nonCompliantFarms = totalFarms - compliantFarms;
            const complianceRate = totalFarms > 0 ? (compliantFarms / totalFarms) * 100 : 0;

            return successResponse(res, {
                rule: "A farm is Compliant only if riskLevel = 'Low' AND geometryStatus = 'Valid'. Any farm with Medium/High risk, or with an Invalid/Needs Review/Missing GPS boundary, is excluded from the numerator even if its risk assessment alone shows Low.",
                numerator: compliantFarms,
                denominator: totalFarms,
                nonCompliantFarms,
                complianceRate: parseFloat(complianceRate.toFixed(1)),
                filtersApplied: filters,
            });
        } catch (error: any) {
            console.error("Error generating compliance calculation details", error);
            return errorResponse(res, "Error generating compliance calculation details", [error.message], 500);
        }
    }
}
