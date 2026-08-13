import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { Batch } from "./Batch";
import { Business } from "./Business";
import { Farmer } from "./Farmer";

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
