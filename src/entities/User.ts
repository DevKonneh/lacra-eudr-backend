import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne } from "typeorm";
import { Role } from "./Role";

export enum UserRole {
    ADMIN = "ADMIN",
    INSPECTOR = "INSPECTOR",
    BUYER = "BUYER",
    EXPORTER = "EXPORTER",
    FARMER = "FARMER",
    // Added for the CMIS Application workflow (Commercial verification +
    // DG approval stages). Kept as simple string values in the existing
    // flat enum, consistent with how every other role in this codebase is
    // gated (authMiddleware(roles: string[]) against this exact claim) —
    // the separate Role/assignedRole/permissions mechanism is not used by
    // any route today, so it is intentionally left untouched here.
    COMMERCIAL = "COMMERCIAL",
    DG = "DG",
    // Added for Phase 3 (Technical Review + Inspector Assignment +
    // Warehouse Assessment + Second DG Approval). INSPECTOR already
    // existed above and is reused as-is for the warehouse-assessment
    // actions; TECHNICAL is the new Technical Services role that assigns
    // inspectors and verifies their findings.
    TECHNICAL = "TECHNICAL",
    // Added for Phase 4 (Billing + Payment + Final DG Approval +
    // Certificate Issuance). FINANCE covers both the Billing Review stage
    // (creates/approves invoices) and the Payment Verification stage
    // (confirms applicant payments, clears cheques) — the workflow spec's
    // RETURNED_TO_FINANCE status treats these as one department. IT is
    // the separate role that prints/issues the final certificate after
    // final DG approval.
    FINANCE = "FINANCE",
    IT = "IT"
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

