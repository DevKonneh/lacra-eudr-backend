import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from "typeorm";
import { User } from "./User";

// Immutable audit trail for staff account management actions (role
// changes, status changes, password resets, account creation/approval/
// rejection) performed through the admin panel's User Management screens.
// Mirrors the existing FarmerAuditLog / CooperativeChangeLog pattern used
// elsewhere in this codebase: one row per change, written once, never
// edited or deleted, so "who changed what on this account and when" is
// always reviewable instead of silently overwritten.
export enum UserAuditAction {
    CREATED = "CREATED",
    ROLE_CHANGED = "ROLE_CHANGED",
    STATUS_CHANGED = "STATUS_CHANGED",
    PASSWORD_RESET = "PASSWORD_RESET",
    PROFILE_UPDATED = "PROFILE_UPDATED",
    APPROVED = "APPROVED",
    REJECTED = "REJECTED",
    LOGIN = "LOGIN",
}

@Entity()
export class UserAuditLog {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    // The account this log entry is about (the "target" user).
    @ManyToOne(() => User, { onDelete: "CASCADE" })
    @JoinColumn({ name: "userId" })
    user!: User;

    @Column()
    userId!: string;

    @Column({ type: "enum", enum: UserAuditAction })
    action!: UserAuditAction;

    // For ROLE_CHANGED / STATUS_CHANGED: the before/after values as plain
    // text (e.g. "INSPECTOR" -> "TECHNICAL", "ACTIVE" -> "SUSPENDED").
    // NOTE: explicit `type: "varchar"`/`"text"` required on every
    // `string | null` column below - TypeScript's reflected design type
    // for a union type is `Object`, which TypeORM cannot map to a SQL
    // column type on its own (it would otherwise throw
    // DataTypeNotSupportedError at startup - see Cooperative.ts for the
    // same established fix).
    @Column({ type: "varchar", nullable: true })
    previousValue!: string | null;

    @Column({ type: "varchar", nullable: true })
    newValue!: string | null;

    // Who performed this action (an admin managing another account, or
    // the user themselves for LOGIN). Null for system-initiated rows, if
    // any are ever added.
    @Column({ type: "varchar", nullable: true })
    performedByUserId!: string | null;

    @Column({ type: "varchar", nullable: true })
    performedByName!: string | null;

    @Column({ type: "text", nullable: true })
    notes!: string | null;

    @CreateDateColumn()
    createdAt!: Date;
}
