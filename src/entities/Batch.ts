import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, ManyToMany, JoinTable } from "typeorm";
import { License } from "./License";
import { Farmer } from "./Farmer";

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
