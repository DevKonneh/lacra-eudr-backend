import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn, UpdateDateColumn } from "typeorm";
import { Farmer } from "./Farmer";

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

    @Column({
        type: "enum",
        enum: CropType,
    })
    cropType!: CropType;

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

    @ManyToOne(() => Farmer, (farmer) => farmer.farms)
    farmer!: Farmer;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
