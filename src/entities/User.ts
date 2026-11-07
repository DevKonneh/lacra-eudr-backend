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
    IT = "IT",
    // Added for the CMIS Monitoring feature (User Activity + Enumerator
    // Monitoring). A field supervisor oversees a set of enumerators
    // (INSPECTOR accounts whose `supervisorId` points at them — see
    // below) and, per the Monitoring access rule, can only see
    // monitoring data for enumerators assigned directly to them. Kept as
    // a plain string value in this existing flat enum (role is a
    // `simple-enum` column — see note on that column below — so adding a
    // value here requires no schema/enum migration, just a new allowed
    // string).
    FIELD_SUPERVISOR = "FIELD_SUPERVISOR"
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
        // NOTE: despite the name, TypeORM's Postgres driver maps
        // "simple-enum" to a REAL native Postgres enum type (same as
        // type: "enum") - it is NOT a plain varchar. Verified against this
        // project's actual schema: `\d "user"` shows role's udt_name as
        // user_role_enum, and `synchronize: true` silently ran
        // `ALTER TYPE user_role_enum ADD VALUE 'FIELD_SUPERVISOR'` here in
        // dev when this value was added below. In other words, adding a
        // new UserRole value is NOT schema-migration-free the way an
        // earlier comment on this column claimed - it still requires an
        // explicit `ALTER TYPE ... ADD VALUE IF NOT EXISTS` in any
        // migration file for this release (see
        // migrations/2027_monitoring/up.sql), the same as UserAuditAction
        // below. "simple-enum" only differs from "enum" in how TypeORM
        // NAMES the generated Postgres type (simple-enum derives the name
        // from the entity+column; "enum" lets you set `enumName`) - not in
        // whether a real Postgres enum type is created.
        type: "simple-enum",
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

    // --- CMIS Monitoring: supervisor + declared territory ------------------
    // One enumerator has at most one DIRECT supervisor in this release (no
    // multi-level hierarchy, no many-to-many). Self-referencing, nullable
    // FK on "user" itself rather than a separate join table, since the
    // relationship is simple and 1:1-per-enumerator. Nullable so every
    // existing account (and any enumerator never assigned a supervisor)
    // remains valid and simply has no supervisor — per the explicit
    // instruction, such an enumerator "remains visible to authorized
    // admins" (i.e. absence of a supervisor is a normal, supported state,
    // not an error).
    //
    // IMPORTANT: this column is intentionally typed as a plain nullable
    // uuid column (NOT a TypeORM @ManyToOne/@JoinColumn relation) — a
    // self-referencing @ManyToOne(() => User) would make `synchronize:
    // true` want to rename this to a relation id column and could also
    // complicate the plain `userRepository.find()` calls already used
    // everywhere in UserController/AuthController (which do not expect a
    // circular "supervisor" relation to come back unless explicitly
    // requested). MonitoringController/UserController resolve the actual
    // supervisor User row with an explicit extra query instead.
    @Column({ type: "uuid", nullable: true })
    supervisorId!: string | null;

    // Declared/assigned territory for this account (set by an admin on the
    // User form) — DISTINCT from "reported field area" (the
    // county/district/community actually observed on this enumerator's own
    // captured Farmer/Farm/FieldEvent records). See Farmer.region/district/
    // community for the matching per-record geography naming. Primarily
    // used today for Enumerator Monitoring table filters and the "Assigned
    // area" display; per the explicit instruction, formal assignment
    // targets/completion-percentage logic is deferred until CMIS has real
    // assignment records.
    // Explicit `type: "varchar"` is REQUIRED here (not just `nullable:
    // true`) - reflect-metadata cannot represent a `string | null` union
    // type at runtime, so TypeORM sees the design:type as plain `Object`
    // and fails entity-metadata validation ("Data type Object ... is not
    // supported") unless the column type is given explicitly. Confirmed by
    // reproducing the failure with `DataSource.initialize()` before adding
    // this. Every other nullable `string | null` column in this codebase
    // (e.g. FarmerAuditLog.fieldName) is typed as a bare `string`, not
    // `string | null`, which is why this bug didn't already exist
    // elsewhere - keep that convention for any FUTURE nullable string
    // column, or always set `type` explicitly as done here.
    @Column({ type: "varchar", nullable: true })
    assignedCounty!: string | null;

    @Column({ type: "varchar", nullable: true })
    assignedDistrict!: string | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}

