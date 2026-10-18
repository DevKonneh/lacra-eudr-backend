import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn, UpdateDateColumn } from "typeorm";
import { Plot } from "./Plot";
import { Commodity } from "./Commodity";

/**
 * The many-to-many join between Plot and Commodity — this is where every
 * "Add Commodity" form field from the spec actually lives, since all of
 * them (planted area, planting year, number of trees, production, etc.)
 * describe a SPECIFIC commodity growing on a SPECIFIC plot, not the
 * commodity type in the abstract (that's Commodity.ts) nor the plot in the
 * abstract (that's Plot.ts).
 *
 * Multiple PlotCommodity rows can share the same Plot (intercropped case:
 * e.g. one row for cocoa + one row for plantain, both pointing at the same
 * shared Plot) — this is how "do not count the shared area separately for
 * each intercropped commodity" is enforced: the AREA lives on Plot, not
 * here, so summing plots (not plot-commodities) never double-counts.
 *
 * "Allow a user to add, update or deactivate a commodity without deleting
 * the farm" is implemented via `isActive` below — deactivating sets this
 * false rather than deleting the row, preserving history.
 */
export enum CroppingSystem {
    MONOCROP = "Monocrop",
    MIXED = "Mixed",
    INTERCROPPED = "Intercropped",
}

export enum CommodityRole {
    PRIMARY = "Primary",
    SECONDARY = "Secondary",
}

export enum ProductionStatus {
    NOT_YET_PRODUCTIVE = "Not Yet Productive",
    PRODUCING = "Producing",
    DECLINING = "Declining",
    DORMANT_SEASONAL = "Dormant / Off-season",
    ABANDONED = "Abandoned",
}

@Entity()
export class PlotCommodity {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => Plot, (plot) => plot.plotCommodities, { onDelete: "CASCADE" })
    plot!: Plot;

    @Column()
    plotId!: string;

    @ManyToOne(() => Commodity, { eager: true })
    commodity!: Commodity;

    @Column()
    commodityId!: string;

    // Denormalized convenience copy of the commodity's name at the time of
    // planting, so historical records/reports/audit-log text remain
    // readable even if the Commodity master record is later renamed.
    @Column()
    commodityName!: string;

    @Column({ type: "enum", enum: CommodityRole, default: CommodityRole.PRIMARY })
    role!: CommodityRole;

    @Column({ type: "enum", enum: CroppingSystem, default: CroppingSystem.MONOCROP })
    croppingSystem!: CroppingSystem;

    // Planted area attributable to THIS commodity. For a dedicated
    // (non-shared) plot this typically equals the plot's own areaHa. For
    // an intercropped plot shared by several commodities, this represents
    // each commodity's own claimed footprint for informational/reporting
    // purposes only — the AUTHORITATIVE, non-double-counted area used for
    // "does this exceed the farm's total area" validation is always the
    // Plot.areaHa (summed once per plot, not once per commodity).
    @Column({ type: "float", nullable: true })
    plantedAreaHa!: number | null;

    @Column({ type: "int", nullable: true })
    plantingYear!: number | null;

    @Column({ type: "int", nullable: true })
    numberOfTrees!: number | null;

    @Column({ type: "float", nullable: true })
    estimatedAnnualProduction!: number | null;

    @Column({ nullable: true })
    unitOfMeasurement!: string;

    @Column({ type: "enum", enum: ProductionStatus, default: ProductionStatus.NOT_YET_PRODUCTIVE })
    productionStatus!: ProductionStatus;

    // Free-text period, e.g. "September - December"
    @Column({ nullable: true })
    expectedHarvestPeriod!: string;

    // Soft-deactivate flag — "allow a user to add, update or deactivate a
    // commodity without deleting the farm". Deactivated commodities are
    // hidden from active displays (Farm Registry badges, FarmerProfile
    // commodity summary) but preserved for history/audit/reporting.
    @Column({ default: true })
    isActive!: boolean;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
