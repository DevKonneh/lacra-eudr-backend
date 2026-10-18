import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, CreateDateColumn, UpdateDateColumn } from "typeorm";
import { Farmer } from "./Farmer";
import { Plot } from "./Plot";

// LEGACY enum, kept only so old code/seed data that still references
// CropType.COCOA etc. keeps compiling. It is NO LONGER the schema type of
// Farm.cropType (see below) — the multi-commodity model (Plot +
// PlotCommodity, in Plot.ts / PlotCommodity.ts) is now the source of
// truth for what a farm actually grows. This enum's string VALUES
// ("Cocoa", "Coffee", ...) are still used as free-text Commodity master
// names during the one-off migration/backfill (see migrateToCommodities.ts).
export enum CropType {
    COCOA = "Cocoa",
    COFFEE = "Coffee",
    PALM = "Palm",
    RUBBER = "Rubber",
    CASSAVA = "Cassava",
    VEGETABLES = "Vegetables",
    OTHER = "Other"
}

@Entity()
export class Farm {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column()
    name!: string;

    // LEGACY / DERIVED field — retained (rather than dropped) so every
    // existing record and every piece of code that still reads
    // `farm.cropType` (ReportsController's crop-breakdown report,
    // ExportController's CSV export, ShipmentController/TransferController's
    // display projections, RiskService's deforestation-risk categorization,
    // FarmsList/FarmDetails/FarmerProfile UI) keeps working without a
    // breaking change, per the explicit instruction to "preserve all
    // completed work and existing records."
    //
    // Going forward this is auto-derived (not user-entered) as the name of
    // this farm's PRIMARY, active commodity across all its plots — kept in
    // sync by FarmController whenever commodities are added/updated/
    // deactivated (see FarmController.syncLegacyCropType()). It is no
    // longer a strict enum column (a farm's real commodity list can now
    // contain anything in the Commodity master table, not just the 7
    // original hardcoded values), and it is nullable because a
    // brand-new farm has no commodities yet until "Add Commodity" is used.
    @Column({ type: "varchar", nullable: true })
    cropType!: string | null;

    // Stores either a Point or a Polygon
    @Column({
        type: 'geometry',
        spatialFeatureType: 'Geometry',
        srid: 4326 // Standard GPS coordinates
    })
    location!: object;

    @Column({
        type: "enum",
        enum: ["Low", "Medium", "High"],
        default: "Low"
    })
    riskLevel!: string;

    @Column({ nullable: true })
    lastRiskAssessmentDate!: Date;

    @Column({ type: "float", nullable: true })
    totalAreaHa!: number;

    @Column({ nullable: true })
    ownershipType!: string; // Owned, Rented, etc.

    @Column({ nullable: true })
    ownershipDocument!: string; // Path to doc

    @Column({ nullable: true })
    farmRegistrationStatus!: string; // Registered / Not Registered

    @Column({ nullable: true })
    numberOfTrees!: number;

    @Column({ nullable: true })
    yearsInCultivation!: number;

    @Column({ nullable: true })
    harvestSeason!: string;

    @Column({ nullable: true })
    averageYield!: string;

    @Column({ type: "text", nullable: true })
    farmNotes!: string;

    @Column({ nullable: true })
    manualSizeInput!: string;

    @Column({ nullable: true })
    manualSizeUnit!: string;

    @Column({ nullable: true })
    buyers!: string;

    @Column({ default: false })
    useChemicals!: boolean;

    @Column({ default: false })
    extensionServices!: boolean;

    @Column({ nullable: true })
    farmAddress!: string;

    @Column("simple-array", { nullable: true })
    farmPhotos!: string[];

    // EUDR-standard boundary evidence: one entry per GPS point captured while
    // walking/marking the farm boundary (minimum 4 points -> land polygon).
    // Each entry ties a specific coordinate to the photo taken AT that exact
    // point, which is what distinguishes this from a generic photo gallery -
    // it's per-point, geotagged, timestamped proof of the physical boundary.
    // Shape: [{ sequence, lat, lng, accuracy, timestamp, photoUrl }, ...]
    @Column("jsonb", { nullable: true })
    boundaryEvidence!: {
        sequence: number;
        lat: number;
        lng: number;
        accuracy?: number;
        timestamp?: string;
        photoUrl: string;
    }[];

    // ─── GeoID (FAO OpenForis) ────────────────────────────────────────────────
    // A globally-unique, geometry-derived UUIDv8 minted by the FAO GeoID API.
    // The same polygon/point always produces the same GeoID (content-addressed),
    // so this field is stable and safe to share publicly across systems
    // (WHIMO, EUDR auditors, downstream buyers) without exposing raw coordinates
    // or any farmer PII.
    @Column({ nullable: true, unique: true })
    geoId!: string;

    // Durable resolver URI returned by the GeoID API alongside the geoid.
    // e.g. "https://data.fao.org/geoid/019f3c…"
    @Column({ nullable: true })
    geoIdUri!: string;

    // Per-farm QR code (data URL) encoding the farm-scan public endpoint.
    // This is what traders / WHIMO scan — it is farm-specific, NOT the
    // farmer-profile QR that already exists on the Farmer entity.
    @Column({ type: "text", nullable: true })
    farmQrCode!: string;

    @ManyToOne(() => Farmer, (farmer) => farmer.farms)
    farmer!: Farmer;

    // One farm can have multiple plots (NEW). A "plot" is a physical
    // subdivision — either a separately-drawn subplot (commodities in
    // separate physical areas) or the single auto-created default plot
    // that represents the farm's whole/shared area (single-commodity or
    // intercropped case). See Plot.ts for full rationale.
    @OneToMany(() => Plot, (plot) => plot.farm, { cascade: true })
    plots!: Plot[];

    // --- GPS polygon / farm-area geometry validation (see
    // GeometryValidationService.ts) ---
    //
    // These columns cache the RESULT of the most recent geometry
    // validation run (performed on every create/offlineSync, and
    // re-runnable on demand via the Data Correction Queue for legacy
    // records). They exist so:
    //   1. The frontend can display calculated area / declared area /
    //      difference / GPS accuracy / coordinate count / geometry
    //      status / overlap status WITHOUT re-running the (relatively
    //      expensive) turf.js + PostGIS validation on every page load.
    //   2. RiskService.analyzeFarm() can gate on `geometryStatus` before
    //      running compliance analysis, without re-validating every time.
    //   3. Existing farms with invalid geometry can be identified for the
    //      Data Correction Queue purely via a WHERE clause on this column
    //      — no need to re-run validation across the whole table live.
    //
    // "Missing" (the enum default) is deliberately chosen over nullable/
    // undefined so every pre-existing farm row (created before this
    // feature existed) is automatically treated as needing a compliance
    // gate check, rather than silently defaulting to "valid".
    @Column({
        type: "enum",
        enum: ["Valid", "Needs Review", "Invalid", "Missing"],
        default: "Missing",
    })
    geometryStatus!: string;

    // Calculated polygon area (turf.area), independent of the
    // user/inspector-declared totalAreaHa above. Nullable because it
    // cannot be computed for farms with no real polygon yet.
    @Column({ type: "float", nullable: true })
    calculatedAreaHa!: number | null;

    @Column({ type: "float", nullable: true })
    areaDifferenceHa!: number | null;

    @Column({ type: "float", nullable: true })
    areaDifferencePercent!: number | null;

    // GPS accuracy (meters) captured while walking/marking the boundary,
    // if the client supplied one (see boundaryEvidence[].accuracy above,
    // or a dedicated accuracy field from the polygon-drawing UI).
    @Column({ type: "float", nullable: true })
    gpsAccuracyM!: number | null;

    @Column({ type: "int", default: 0 })
    coordinateCount!: number;

    @Column({ default: false })
    overlapsExistingFarm!: boolean;

    // Full structured validation result (errors/warnings/every individual
    // check's boolean outcome) from the last GeometryValidationService
    // run — kept as jsonb so the complete diagnostic detail is available
    // (e.g. for the Data Correction Queue and FarmDetails page) without
    // needing a dozen more individual columns.
    @Column("jsonb", { nullable: true })
    geometryValidationDetails!: any;

    @Column({ nullable: true })
    lastGeometryValidatedAt!: Date;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
