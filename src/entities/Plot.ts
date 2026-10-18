import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, CreateDateColumn, UpdateDateColumn } from "typeorm";
import { Farm } from "./Farm";
import { PlotCommodity } from "./PlotCommodity";

/**
 * A physical subdivision of a Farm.
 *
 * WHY THIS EXISTS: a single Farm's boundary polygon may in practice be
 * farmed as several distinct plots (e.g. a cocoa block + a separate coffee
 * block within the same registered farm), OR it may be farmed as ONE
 * shared plot carrying several intercropped commodities (e.g. cocoa +
 * plantain grown together on the same land). Either way, "Plot" is the
 * physical-area concept; "which commodities grow on it" is captured by the
 * PlotCommodity join rows below (Plot <-> Commodity, many-to-many via a
 * rich join entity carrying per-planting attributes).
 *
 * Every Farm gets AT LEAST ONE Plot. For a simple single-commodity farm
 * (e.g. "cocoa only"), a single default Plot is created automatically
 * (isDefault = true, reusing the farm's own boundary/area) so existing
 * single-commodity farms and new ones behave identically without forcing
 * the user to explicitly draw a separate plot polygon.
 *
 * If commodities occupy SEPARATE physical areas, separate Plot rows (each
 * with its own polygon + areaHa) are created. If commodities are
 * INTERCROPPED on the same land, they all attach (via PlotCommodity) to
 * the SAME single Plot, so their combined area is never double-counted
 * (see Farm.plots + FarmController's area-validation logic).
 */
@Entity()
export class Plot {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    // Human-friendly label, e.g. "Plot A", "Cocoa Block", or just reuses
    // the farm name for the default single-plot case.
    @Column()
    name!: string;

    @ManyToOne(() => Farm, (farm) => farm.plots, { onDelete: "CASCADE" })
    farm!: Farm;

    @Column()
    farmId!: string;

    // Own boundary polygon, only meaningful when this plot occupies a
    // physically separate area from the rest of the farm. Nullable because
    // the auto-created "default" plot (single-commodity / fully
    // intercropped case) simply shares the farm's own polygon instead of
    // needing a second, redundant one.
    @Column({ type: "geometry", spatialFeatureType: "Geometry", srid: 4326, nullable: true })
    boundary!: object | null;

    // Area of THIS plot specifically. For the default/shared plot this
    // mirrors farm.totalAreaHa; for a separately-drawn subplot this is its
    // own calculated/declared area, used by the "total subplot area must
    // not exceed farm area" validation.
    @Column({ type: "float", nullable: true })
    areaHa!: number | null;

    // True for the single auto-created plot that represents "the whole
    // farm, undivided" — used for backward compatibility with
    // single-commodity farms and the intercropped-shared-polygon case.
    @Column({ default: false })
    isDefault!: boolean;

    @Column({ default: true })
    isActive!: boolean;

    @OneToMany(() => PlotCommodity, (pc) => pc.plot, { cascade: true })
    plotCommodities!: PlotCommodity[];

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
