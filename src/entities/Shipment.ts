import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToMany, JoinTable } from "typeorm";
import { Batch } from "./Batch";

export enum ShipmentStatus {
    DRAFT = "DRAFT",
    VALIDATED = "VALIDATED",
    ISSUED = "ISSUED", // DDS Issued
    SHIPPED = "SHIPPED"
}

@Entity()
export class Shipment {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ unique: true })
    shipmentId!: string;

    @Column()
    destinationCountry!: string;

    @Column()
    vesselName!: string;

    @Column({ nullable: true })
    ddsNumber!: string;

    @Column({
        type: "simple-enum",
        enum: ShipmentStatus,
        default: ShipmentStatus.DRAFT
    })
    status!: ShipmentStatus;

    @ManyToMany(() => Batch)
    @JoinTable()
    batches!: Batch[];

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
