import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { Farm } from "./Farm";

@Entity()
export class SatelliteAlert {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => Farm, { nullable: true })
    @JoinColumn()
    farm?: Farm;

    @Column({ nullable: true })
    farmId?: string;

    @Column()
    type!: string; // e.g. DEFORESTATION, RISK_CHANGE

    @Column()
    detectedAt!: Date;

    @Column({ default: "PENDING" })
    status!: string; // PENDING, REVIEWED, DISMISSED

    @Column("jsonb", { nullable: true })
    metadata!: Record<string, any>;

    @CreateDateColumn()
    createdAt!: Date;
}
