import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm";

export enum RiskLevel {
    LOW = "LOW",
    MEDIUM = "MEDIUM",
    HIGH = "HIGH"
}

@Entity()
export class Forest {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column()
    name!: string;

    @Column({
        type: "enum",
        enum: RiskLevel,
        default: RiskLevel.HIGH
    })
    riskLevel!: RiskLevel;

    @Column("geometry", {
        spatialFeatureType: "MultiPolygon",
        srid: 4326
    })
    geom!: object;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
