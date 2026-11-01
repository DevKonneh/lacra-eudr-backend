import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from "typeorm";
import { Cooperative } from "./Cooperative";

/**
 * Immutable audit trail for every change made to a Cooperative record
 * after its initial seed — manual corrections by authorised staff
 * (address/district/community filled in, a typo fixed, membership
 * updated) as well as field-level changes applied by a reviewed CDA
 * import (see CooperativeImportRun). Mirrors the FarmerAuditLog /
 * ApplicationStatusHistory pattern already used elsewhere in this
 * codebase: one row per field changed, never edited or deleted.
 */
export enum CooperativeChangeSource {
    MANUAL_CORRECTION = "MANUAL_CORRECTION",
    CDA_IMPORT = "CDA_IMPORT",
}

@Entity()
export class CooperativeChangeLog {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => Cooperative, { onDelete: "CASCADE" })
    @JoinColumn({ name: "cooperativeId" })
    cooperative!: Cooperative;

    @Column()
    cooperativeId!: string;

    @Column()
    fieldName!: string;

    @Column({ type: "text", nullable: true })
    previousValue!: string | null;

    @Column({ type: "text", nullable: true })
    newValue!: string | null;

    @Column({ type: "enum", enum: CooperativeChangeSource })
    source!: CooperativeChangeSource;

    // NOTE: explicit `type: "varchar"` required on every `string | null`
    // column below - TypeScript's reflected design type for a union type
    // is `Object`, which TypeORM cannot map to a SQL column type on its
    // own (it would otherwise throw DataTypeNotSupportedError at startup).
    @Column({ type: "varchar", nullable: true })
    performedByUserId!: string | null;

    @Column({ type: "varchar", nullable: true })
    performedByName!: string | null;

    // Set when source === CDA_IMPORT, linking back to the specific import
    // run that applied this change — see CooperativeImportRun.
    @Column({ type: "varchar", nullable: true })
    importRunId!: string | null;

    @Column({ type: "text", nullable: true })
    notes!: string | null;

    @CreateDateColumn()
    createdAt!: Date;
}
