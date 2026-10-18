import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

/**
 * Master/reference list of commodities (Cocoa, Coffee, Rubber, Plantain, ...).
 *
 * IMPORTANT: per the multi-commodity-per-farm spec, "a commodity must not
 * own the farm record" — this entity intentionally has NO relation back to
 * Farm/Farmer/Plot. It is pure reference data (a lookup table), analogous
 * to a dropdown's option list. The actual per-farm, per-plot planting
 * details (area, year, trees, production, status, etc.) live on the
 * PlotCommodity join entity, which is the thing that references a specific
 * Plot + a specific Commodity together.
 */
@Entity()
export class Commodity {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ unique: true })
    name!: string;

    // Optional grouping, e.g. "Perennial", "Annual" — mirrors the
    // PERENNIAL_CROPS/ANNUAL_CROPS distinction RiskService.ts already makes
    // for the legacy CropType enum, so risk logic can eventually look this
    // up instead of relying on a hardcoded enum set.
    @Column({ nullable: true })
    category!: string;

    @Column({ default: true })
    isActive!: boolean;

    @CreateDateColumn()
    createdAt!: Date;
}
