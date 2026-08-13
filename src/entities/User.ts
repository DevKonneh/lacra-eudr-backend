import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne } from "typeorm";
import { Role } from "./Role";

export enum UserRole {
    ADMIN = "ADMIN",
    INSPECTOR = "INSPECTOR",
    BUYER = "BUYER",
    EXPORTER = "EXPORTER",
    FARMER = "FARMER"
}

export enum UserStatus {
    PENDING = "PENDING",
    ACTIVE = "ACTIVE",
    REJECTED = "REJECTED"
}

@Entity()
export class User {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ unique: true })
    email!: string;

    @Column()
    password!: string;

    @Column({
        type: "simple-enum", // Use simple-enum to avoid Postgres enum type synchronization issues in MVP
        enum: UserRole,
        default: UserRole.INSPECTOR
    })
    role!: UserRole;

    @ManyToOne(() => Role, (role) => role.users, { nullable: true })
    assignedRole!: Role;

    @Column({
        type: "simple-enum",
        enum: UserStatus,
        default: UserStatus.ACTIVE // Default to ACTIVE for backward compatibility/admin creation
    })
    status!: UserStatus;

    @Column({ nullable: true })
    name!: string;

    @Column({ nullable: true })
    verificationCode!: string;

    @Column({ nullable: true })
    verificationCodeExpires!: Date;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}

