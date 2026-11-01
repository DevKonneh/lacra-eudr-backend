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
    REJECTED = "REJECTED",
    // Distinct from REJECTED (which only ever applied to a PENDING
    // self-registration that was turned down before first use).
    // SUSPENDED is for an admin deliberately deactivating a
    // previously-ACTIVE account (e.g. an inspector who left LACRA) without
    // deleting their row/history, so the account can be reactivated later
    // and every record they created/touched still resolves to a real user.
    SUSPENDED = "SUSPENDED"
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

    // Optional contact number for staff accounts (not the farmer's own
    // phoneNumber, which lives on the Farmer entity) - useful for admins
    // to reach a colleague about an account issue without digging through
    // another system.
    @Column({ nullable: true })
    phone!: string;

    @Column({ nullable: true })
    verificationCode!: string;

    @Column({ nullable: true })
    verificationCodeExpires!: Date;

    // Updated every successful login (see AuthController.login). Lets the
    // User Management screen distinguish active staff from dormant/never-
    // used accounts at a glance, instead of every row looking identical.
    @Column({ nullable: true })
    lastLoginAt!: Date;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}

