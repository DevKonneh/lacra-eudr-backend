import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne } from "typeorm";
import { User } from "./User";
import { Batch } from "./Batch";

export enum QCResult {
    PENDING = "PENDING",
    PASSED = "PASSED",
    FAILED = "FAILED"
}

@Entity()
export class QualityControl {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => Batch)
    batch!: Batch;

    @ManyToOne(() => User)
    inspector!: User;

    @Column()
    checkDate!: Date;

    @Column({
        type: "simple-enum",
        enum: QCResult,
        default: QCResult.PENDING
    })
    result!: QCResult;

    // Store specific parameters checked (e.g., moisture content, size, defects)
    @Column("simple-json", { nullable: true })
    parameters?: any;

    @Column("text", { nullable: true })
    comments?: string;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
