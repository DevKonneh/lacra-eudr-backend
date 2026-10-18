import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { Batch } from "./Batch";
import { Business } from "./Business";
import { Farmer } from "./Farmer";
import { Farm } from "./Farm";
import { Plot } from "./Plot";
import { PlotCommodity } from "./PlotCommodity";

export enum TransferType {
    PURCHASE = "PURCHASE",
    HANDOVER = "HANDOVER",
    RECEIVE = "RECEIVE"
}

@Entity()
export class Transfer {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => Batch)
    @JoinColumn()
    batch!: Batch;

    @Column()
    batchId!: string;

    @ManyToOne(() => Business, { nullable: true })
    @JoinColumn()
    fromBusiness?: Business;

    @Column({ nullable: true })
    fromBusinessId?: string;

    @ManyToOne(() => Farmer, { nullable: true })
    @JoinColumn()
    fromFarmer?: Farmer;

    @Column({ nullable: true })
    fromFarmerId?: string;

    // Traceability source (denormalized from the linked Batch at transfer
    // time, when available) — "each harvest and transaction must identify
    // its exact farm, plot and commodity source." Nullable: a transfer's
    // batch may pool produce with no single attributable farm/plot.
    @ManyToOne(() => Farm, { nullable: true })
    @JoinColumn()
    sourceFarm?: Farm;

    @Column({ nullable: true })
    sourceFarmId?: string;

    @ManyToOne(() => Plot, { nullable: true })
    @JoinColumn()
    sourcePlot?: Plot;

    @Column({ nullable: true })
    sourcePlotId?: string;

    @ManyToOne(() => PlotCommodity, { nullable: true })
    @JoinColumn()
    sourcePlotCommodity?: PlotCommodity;

    @Column({ nullable: true })
    sourcePlotCommodityId?: string;

    @ManyToOne(() => Business, { nullable: true })
    @JoinColumn()
    toBusiness?: Business;

    @Column({ nullable: true })
    toBusinessId?: string;

    @Column({ type: "float", default: 0 })
    quantityKg!: number;

    @Column({ type: "date" })
    transferDate!: Date;

    @Column({
        type: "simple-enum",
        enum: TransferType
    })
    type!: TransferType;

    @Column({ type: "text", nullable: true })
    notes?: string;

    @CreateDateColumn()
    createdAt!: Date;
}
