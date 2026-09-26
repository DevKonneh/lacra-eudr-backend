import { Entity, PrimaryGeneratedColumn, Column, OneToMany, OneToOne, JoinColumn, CreateDateColumn, UpdateDateColumn } from "typeorm";
import { Farm } from "./Farm";
import { User } from "./User";

@Entity()
export class Farmer {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ unique: true, nullable: true })
    farmerId!: string;

    @Column({ type: "text", nullable: true })
    qrCode!: string;

    @Column()
    firstName!: string;

    @Column()
    lastName!: string;

    @Column({ nullable: true, unique: true })
    email?: string;

    @Column()
    phoneNumber!: string;

    @Column({ unique: true, nullable: true })
    nationalId!: string;

    @Column({ nullable: true })
    idType!: string; // Driver License / National ID card / Passport / Voting ID / Other

    @Column({ nullable: true })
    idTypeOther!: string; // Free-text label when idType === "Other"

    @Column({ nullable: true })
    gender!: string; // Male/Female/Other

    @Column({ nullable: true })
    dob!: Date;

    @Column({ nullable: true })
    nationality!: string;

    @Column({ nullable: true })
    otherId!: string; // LASSRA Number / Other

    @Column({ nullable: true })
    address!: string; // Home Address

    @Column({ nullable: true })
    community!: string;

    @Column({ nullable: true })
    district!: string;

    @Column({ nullable: true })
    region!: string; // Agricultural Zone

    @Column({ nullable: true })
    cooperativeName!: string;

    @Column({ nullable: true })
    cooperativeId!: string;

    // Provenance of cooperativeName above: 'CDA_REGISTRY' when the
    // enumerator picked a cooperative from the official CDA-registry
    // searchable dropdown, or 'OTHER' when they used the "Other / Not
    // Listed" free-text fallback (flagged for later back-office review).
    // Nullable so pre-existing farmer records (registered before this
    // field existed, or via the admin web panel) remain valid.
    @Column({ nullable: true })
    cooperativeSource!: string;

    @Column({ nullable: true })
    profilePhoto!: string; // Path to photo

    @Column({ nullable: true })
    farmSelfie!: string; // Path to selfie at farm

    @Column({ nullable: true })
    idPhoto!: string; // Path to ID photo

    @Column({ nullable: true })
    enumeratorName!: string;

    @Column({ nullable: true })
    enumeratorId!: string;

    // Reliable link to the actual Inspector/Admin account that created this
    // record (unlike enumeratorName/enumeratorId above, which are free-text
    // form fields typed by whoever filled the registration and cannot be
    // trusted for access control). Nullable so existing farmer records
    // created before this field existed remain valid ("legacy" records,
    // treated as visible to every inspector — see FarmerController.getAll).
    @Column({ nullable: true })
    registeredByUserId!: string;

    @Column({ nullable: true })
    signature!: string; // Path or base64

    @Column({ default: false })
    consent!: boolean;

    @Column({
        type: "enum",
        enum: ["Verified", "Unverified", "Conflict"],
        default: "Unverified"
    })
    identityStatus!: string;

    @Column({ default: true })
    isActive!: boolean;

    @OneToMany(() => Farm, (farm) => farm.farmer, { cascade: true })
    farms!: Farm[];

    @OneToOne(() => User, { cascade: true, nullable: true })
    @JoinColumn()
    user!: User;

    @Column({ nullable: true })
    userId!: string;

    @Column({ nullable: true })
    directions!: string;

    @Column({ nullable: true })
    latitude!: string;

    @Column({ nullable: true })
    longitude!: string;

    // Stable client-generated identifier (Flutter offline queue's
    // PendingSyncItem.id) sent by the mobile app on every sync attempt for
    // a given locally-created farmer record. Because it is generated ONCE
    // when the record is first queued offline and never changes, it lets
    // the backend recognize retried/duplicate sync submissions (e.g. after
    // a dropped connection where the client never received the success
    // response and re-sends the same record) and treat them as idempotent
    // instead of creating a second Farmer row. Nullable + unique so
    // legacy/admin-web-panel records (which never send this field) are
    // unaffected, while any two records that DO send a value can never
    // collide accidentally.
    @Column({ nullable: true, unique: true })
    clientRecordId!: string;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
