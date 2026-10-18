import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, ManyToMany, JoinTable } from "typeorm";
import { License } from "./License";
import { Farmer } from "./Farmer";
import { Farm } from "./Farm";
import { Plot } from "./Plot";
import { PlotCommodity } from "./PlotCommodity";

export enum BatchStatus {
    COLLECTED = "COLLECTED",
    IN_TRANSIT = "IN_TRANSIT",
    WAREHOUSE = "WAREHOUSE",
    PROCESSING = "PROCESSING",
    SHIPPED = "SHIPPED"
}

@Entity()
export class Batch {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ unique: true })
    batchId!: string;

    @Column({ type: "float", default: 0 })
    weightKg!: number;

    @Column()
    cropType!: string;

    // Traceability: "each harvest and transaction must identify its exact
    // farm, plot and commodity source." All three are OPTIONAL (nullable)
    // so existing batches created before this feature — and any batch
    // pooling produce from multiple farmers where a single farm/plot
    // cannot be attributed — remain valid. When a batch IS attributable to
    // one specific farm/plot/commodity (the common single-farmer-batch
    // case), these should be populated so downstream Shipment/Transfer
    // records can trace back to the exact source.
    @ManyToOne(() => Farm, { nullable: true })
    farm?: Farm;

    @Column({ nullable: true })
    farmId?: string;

    @ManyToOne(() => Plot, { nullable: true })
    plot?: Plot;

    @Column({ nullable: true })
    plotId?: string;

    @ManyToOne(() => PlotCommodity, { nullable: true })
    plotCommodity?: PlotCommodity;

    @Column({ nullable: true })
    plotCommodityId?: string;

    @Column({
        type: "simple-enum",
        enum: BatchStatus,
        default: BatchStatus.COLLECTED
    })
    status!: BatchStatus;

    @ManyToOne(() => License)
    createdBy!: License;

    @ManyToMany(() => Farmer)
    @JoinTable()
    farmers!: Farmer[];

    @Column({ nullable: true })
    qrCode!: string; // Base64 Data URL

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
