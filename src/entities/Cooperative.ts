import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm";

/**
 * Official CDA (Cooperative Development Agency) cooperative registry.
 *
 * Seeded from a real letter sent by CDA's Deputy Registrar to the
 * Registrar General (July 2026), listing cooperatives active in the
 * Cocoa, Oil Palm, Rubber and Coffee value chains across Liberia's
 * counties (see scripts/seedCooperatives.ts for the import).
 *
 * Replaces the mobile app's previous hardcoded 10-entry PLACEHOLDER list
 * (lib/data/cda_cooperatives.dart), which explicitly documented itself as
 * fake/illustrative data pending the real export. This is that real
 * export, now backend-managed so it can be corrected/extended by ADMIN
 * without an app rebuild (see CooperativeController).
 *
 * Deliberately NOT related to Farmer/Farm — a farmer's registration
 * still stores a free-text `cooperativeName`/`cooperativeId` snapshot
 * (see Farmer.cooperativeSource = 'CDA_REGISTRY' vs 'OTHER'), the same
 * way Commodity is a pure lookup table that PlotCommodity snapshots
 * from rather than foreign-keying to directly. This keeps a farmer's
 * historical record stable even if this registry is later corrected.
 */
@Entity()
export class Cooperative {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    // Stable human-readable slug (e.g. "nimba-zodoe-farmers-multipurpose-
    // cooperative-society"), generated once at seed time from name+county.
    // Used as an external-facing stable reference distinct from the DB's
    // internal uuid, and to detect/skip duplicates on re-seed.
    @Column({ unique: true })
    slug!: string;

    @Column()
    name!: string;

    @Column({ nullable: true })
    county!: string;

    @Column({ nullable: true })
    location!: string; // Free-text town/district, as published by CDA

    // One cooperative can be active in more than one commodity (a handful
    // of real entries in the source letter are, e.g. both Cocoa and
    // Rubber) — stored as a simple string array rather than a join table
    // since this is reference/display data, not a relation that needs to
    // be queried from the commodity side.
    @Column("simple-array", { nullable: true })
    commodities!: string[];

    @Column({ type: "int", nullable: true })
    membershipTotal!: number | null;

    @Column({ type: "int", nullable: true })
    membershipMale!: number | null;

    @Column({ type: "int", nullable: true })
    membershipFemale!: number | null;

    @Column({ nullable: true })
    contactName!: string;

    @Column({ nullable: true })
    contactRole!: string;

    @Column("simple-array", { nullable: true })
    contactPhones!: string[];

    // Full source text for membership/contact, kept verbatim in case the
    // parsed/structured fields above ever need manual reconciliation
    // against the original CDA letter.
    @Column({ type: "text", nullable: true })
    rawMembership!: string;

    @Column({ type: "text", nullable: true })
    rawContact!: string;

    // Soft-active flag so a cooperative can be retired/hidden from the
    // picker (e.g. found to be defunct) without losing historical farmer
    // records that already reference its name.
    @Column({ default: true })
    isActive!: boolean;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
