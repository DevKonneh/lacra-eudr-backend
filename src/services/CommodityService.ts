import { AppDataSource } from "../data-source";
import { Commodity } from "../entities/Commodity";
import { Plot } from "../entities/Plot";
import { PlotCommodity, CroppingSystem, CommodityRole, ProductionStatus } from "../entities/PlotCommodity";
import { Farm } from "../entities/Farm";

/**
 * Shape of one "Add Commodity" form entry, as submitted from CreateFarm.tsx
 * / RegisterFarmer.tsx (JSON-stringified array field, same convention as
 * `boundaryGeoJson` elsewhere in this codebase).
 *
 * `plotGroup` is the mechanism that implements the workflow rule:
 *   - Commodities sharing the SAME plotGroup key are treated as occupying
 *     the SAME physical land (intercropped/mixed) — they are attached to
 *     ONE Plot, so that Plot's area is counted exactly once no matter how
 *     many commodities grow on it.
 *   - Commodities with DIFFERENT plotGroup keys (or no key at all vs. a
 *     key) occupy SEPARATE physical areas — each gets its own Plot, with
 *     its own optional boundary polygon + area.
 *   - Commodities with NO plotGroup at all fall back to the farm's single
 *     implicit "default" plot (reusing the farm's own boundary/area) —
 *     this is what makes the simple "one farm, one commodity" case work
 *     with zero extra plot-drawing UI.
 */
export interface CommodityInput {
    commodityName: string;
    role?: CommodityRole | string;
    croppingSystem?: CroppingSystem | string;
    plantedAreaHa?: number | string;
    plantingYear?: number | string;
    numberOfTrees?: number | string;
    estimatedAnnualProduction?: number | string;
    unitOfMeasurement?: string;
    productionStatus?: ProductionStatus | string;
    expectedHarvestPeriod?: string;

    // Grouping / physical-plot fields
    plotGroup?: string; // e.g. "A", "B" — arbitrary client-chosen key
    plotName?: string;
    plotBoundary?: any; // GeoJSON, only when this group has its own drawn polygon
    plotAreaHa?: number | string;

    // For updates to an existing PlotCommodity row
    id?: string;
    isActive?: boolean;
}

export interface BuildPlotsResult {
    plots: Plot[];
    totalSubplotAreaHa: number;
    warning: string | null;
}

const num = (v: number | string | undefined | null): number | null => {
    if (v === undefined || v === null || v === "") return null;
    const n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
};

const commodityRepo = () => AppDataSource.getRepository(Commodity);
const plotRepo = () => AppDataSource.getRepository(Plot);

/**
 * Finds an existing Commodity master row by name (case-insensitive), or
 * creates one. Keeps the master list de-duplicated regardless of casing
 * differences between form submissions ("Cocoa" vs "cocoa").
 */
export async function resolveCommodity(name: string): Promise<Commodity> {
    const trimmed = name.trim();
    const repo = commodityRepo();
    let commodity = await repo
        .createQueryBuilder("c")
        .where("LOWER(c.name) = LOWER(:name)", { name: trimmed })
        .getOne();
    if (!commodity) {
        commodity = repo.create({ name: trimmed, isActive: true });
        commodity = await repo.save(commodity);
    }
    return commodity;
}

/**
 * Builds (unsaved) Plot + PlotCommodity entities from a commodities form
 * payload for a BRAND NEW farm (i.e. no existing plots yet). Grouping by
 * `plotGroup` implements the "separate physical areas -> separate
 * subplots" vs. "intercropped -> shared polygon" workflow rule.
 *
 * Also computes `totalSubplotAreaHa` (the sum of each DISTINCT plot's
 * area, counted once per plot — never once per commodity, which is what
 * prevents the "duplicate area calculation" bug for intercropped
 * commodities sharing one polygon) and a `warning` string if that total
 * exceeds the farm's own calculated/declared total area.
 */
export async function buildPlotsForFarm(
    farm: Farm,
    commodities: CommodityInput[]
): Promise<BuildPlotsResult> {
    if (!commodities || commodities.length === 0) {
        return { plots: [], totalSubplotAreaHa: 0, warning: null };
    }

    // Group commodities by plotGroup key. Items with no plotGroup all
    // share a single synthetic group ("__default__") so they end up on
    // ONE plot together (the farm's own polygon) — this correctly covers
    // both "single commodity, no grouping needed" and "intercropped on
    // the shared farm polygon, no separate subplot drawn" cases.
    const groups = new Map<string, CommodityInput[]>();
    for (const c of commodities) {
        const key = c.plotGroup && c.plotGroup.trim() ? c.plotGroup.trim() : "__default__";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(c);
    }

    const plots: Plot[] = [];
    let totalSubplotAreaHa = 0;

    for (const [groupKey, items] of groups.entries()) {
        const first = items[0];
        const isDefaultGroup = groupKey === "__default__";

        const plot = new Plot();
        plot.name = isDefaultGroup
            ? farm.name
            : (first.plotName || `${farm.name} - Plot ${groupKey}`);
        plot.isDefault = isDefaultGroup;
        plot.isActive = true;

        // A separately-drawn subplot polygon/area takes priority; the
        // default (shared-farm-polygon) group instead reuses whatever
        // area the farm itself was declared/calculated to have, and has
        // no boundary of its own (it's just "the whole farm").
        const explicitAreaHa = num(first.plotAreaHa);
        if (!isDefaultGroup && first.plotBoundary) {
            plot.boundary = first.plotBoundary;
        } else {
            plot.boundary = null;
        }
        if (!isDefaultGroup && explicitAreaHa !== null) {
            plot.areaHa = explicitAreaHa;
        } else if (isDefaultGroup) {
            plot.areaHa = farm.totalAreaHa ?? null;
        } else {
            plot.areaHa = null;
        }

        if (plot.areaHa !== null && plot.areaHa !== undefined) {
            totalSubplotAreaHa += plot.areaHa;
        }

        plot.plotCommodities = await buildPlotCommodities(items);
        plots.push(plot);
    }

    const farmAreaHa = farm.totalAreaHa ?? null;
    let warning: string | null = null;
    // Only warn against the SEPARATELY-drawn subplots' area — the default
    // shared-farm-polygon group intentionally mirrors farm.totalAreaHa
    // itself, so it can never "exceed" it and shouldn't be double-added
    // to the comparison.
    const separateSubplotAreaHa = plots
        .filter((p) => !p.isDefault && p.areaHa !== null && p.areaHa !== undefined)
        .reduce((sum, p) => sum + (p.areaHa || 0), 0);

    if (farmAreaHa && separateSubplotAreaHa > farmAreaHa + 0.0001) {
        warning =
            `Total subplot area (${separateSubplotAreaHa.toFixed(2)} ha) exceeds ` +
            `the farm's calculated total area (${farmAreaHa.toFixed(2)} ha). ` +
            `Please review the drawn subplot boundaries.`;
    }

    return { plots, totalSubplotAreaHa: separateSubplotAreaHa, warning };
}

async function buildPlotCommodities(items: CommodityInput[]): Promise<PlotCommodity[]> {
    const result: PlotCommodity[] = [];
    for (const item of items) {
        const commodity = await resolveCommodity(item.commodityName);
        const pc = new PlotCommodity();
        pc.commodity = commodity;
        pc.commodityId = commodity.id;
        pc.commodityName = commodity.name;
        pc.role = (item.role as CommodityRole) || CommodityRole.PRIMARY;
        pc.croppingSystem = (item.croppingSystem as CroppingSystem) || CroppingSystem.MONOCROP;
        pc.plantedAreaHa = num(item.plantedAreaHa);
        pc.plantingYear = num(item.plantingYear);
        pc.numberOfTrees = num(item.numberOfTrees);
        pc.estimatedAnnualProduction = num(item.estimatedAnnualProduction);
        pc.unitOfMeasurement = item.unitOfMeasurement || "";
        pc.productionStatus = (item.productionStatus as ProductionStatus) || ProductionStatus.NOT_YET_PRODUCTIVE;
        pc.expectedHarvestPeriod = item.expectedHarvestPeriod || "";
        pc.isActive = item.isActive !== undefined ? item.isActive : true;
        result.push(pc);
    }
    return result;
}

/**
 * Derives the legacy Farm.cropType display field from a farm's current
 * active commodities — the PRIMARY active commodity's name across all its
 * (active) plots, falling back to the first active commodity found if
 * none is explicitly marked Primary, or null if the farm has none yet.
 * Kept in sync so old code paths that still read farm.cropType directly
 * (ReportsController, ExportController, RiskService, ShipmentController,
 * TransferController, FarmsList/FarmDetails UI) continue to show a
 * sensible value without modification.
 */
export function deriveLegacyCropType(plots: Plot[] | undefined): string | null {
    if (!plots || plots.length === 0) return null;
    const activeCommodities = plots
        .filter((p) => p.isActive)
        .flatMap((p) => p.plotCommodities || [])
        .filter((pc) => pc.isActive);
    if (activeCommodities.length === 0) return null;
    const primary = activeCommodities.find((pc) => pc.role === CommodityRole.PRIMARY);
    return (primary || activeCommodities[0]).commodityName;
}

/**
 * Re-fetches a farm's plots (with their commodities) and recomputes the
 * legacy cropType field. Call after any commodity add/update/deactivate
 * so `farm.cropType` stays in sync for old read paths.
 */
export async function refreshFarmPlotsAndLegacyCropType(farmId: string): Promise<{ plots: Plot[]; cropType: string | null }> {
    const plots = await plotRepo().find({
        where: { farmId },
        relations: ["plotCommodities", "plotCommodities.commodity"],
    });
    return { plots, cropType: deriveLegacyCropType(plots) };
}

/**
 * Computes total DISTINCT-plot area (never double-counted per commodity)
 * for an existing farm's plots, and returns a warning string if the
 * separately-drawn subplots' area exceeds the farm's own total area.
 * Used by the standalone "add/update commodity" endpoints (as opposed to
 * buildPlotsForFarm, which is used during initial farm creation).
 */
export function computeAreaWarning(farm: Farm, plots: Plot[]): string | null {
    const farmAreaHa = farm.totalAreaHa ?? null;
    if (!farmAreaHa) return null;
    const separateSubplotAreaHa = plots
        .filter((p) => p.isActive && !p.isDefault && p.areaHa !== null && p.areaHa !== undefined)
        .reduce((sum, p) => sum + (p.areaHa || 0), 0);
    if (separateSubplotAreaHa > farmAreaHa + 0.0001) {
        return (
            `Total subplot area (${separateSubplotAreaHa.toFixed(2)} ha) exceeds ` +
            `the farm's calculated total area (${farmAreaHa.toFixed(2)} ha). ` +
            `Please review the drawn subplot boundaries.`
        );
    }
    return null;
}
