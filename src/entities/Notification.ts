import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { User } from "./User";

@Entity()
export class Notification {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => User)
    @JoinColumn()
    user!: User;

    @Column()
    userId!: string;

    @Column()
    type!: string; // RISK_CHANGE, SATELLITE_ALERT, COMPLIANCE_FAIL

    @Column()
    title!: string;

    @Column("text")
    body!: string;

    @Column({ nullable: true })
    readAt!: Date;

    @CreateDateColumn()
    createdAt!: Date;
}
