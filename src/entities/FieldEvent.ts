import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

export enum FieldEventType {
    CHECK_IN = "CHECK_IN",
    CHECK_OUT = "CHECK_OUT",
    // Logged automatically (server-side, best-effort) whenever a Farm
    // record with farmLatitude/farmLongitude is captured - NOT a
    // user-facing action in the app. Exists purely so "Last reported
    // location" has a single, unified source to read the latest
    // known-good coordinate from (per the explicit requirement: "GPS
    // captured during a field check-in or farm record capture only" and
    // "show ... its timestamp and source"). See FarmController.create()/
    // offlineSync() for where this is written.
    FARM_RECORD_CAPTURE = "FARM_RECORD_CAPTURE",
}

/**
 * Immutable field-activity event for one enumerator - the backbone of the
 * Enumerator Monitoring tab's field activity timeline, "Last reported
 * location", and (via CHECK_IN/CHECK_OUT pairing) "web/field status".
 *
 * IDEMPOTENCY (explicit requirement: "Use (enumeratorId, eventId) for
 * retry deduplication"): `eventId` is generated ONCE on the device when
 * the action is first performed (mirrors PendingSyncItem.id / Farmer.
 * clientRecordId's existing pattern) and resent UNCHANGED on every retry
 * of the same offline-queued event. The unique index below means a retried
 * upload simply no-ops (or is treated as "already recorded") instead of
 * creating a second row / inflating counts - see
 * FieldEventController.ingest().
 *
 * CAPTURED vs RECEIVED (explicit requirement: "Use server receipt time for
 * sync freshness and preserve the original capture time for field
 * activity" / "a delayed upload cannot overwrite a newer location, field
 * status, or sync report"): `capturedAt` is the device's own clock at the
 * moment the enumerator tapped the action (may be well before `receivedAt`
 * if the device was offline for a while); `receivedAt` is this row's
 * @CreateDateColumn, i.e. when the backend actually received it. Every
 * "what's the LATEST event" comparison (last reported location, field
 * status) orders by `capturedAt`, never `receivedAt` - so a delayed/retried
 * upload of an OLD capture can never be mistaken for newer activity just
 * because it happened to reach the server later.
 */
@Entity()
@Index(["enumeratorId", "eventId"], { unique: true })
@Index(["enumeratorId", "capturedAt"])
export class FieldEvent {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    // Stable, client-generated dedup key (see class doc above). Unique
    // only in combination with enumeratorId (not globally) so two
    // different enumerators' independently-generated client ids can never
    // collide with each other's events.
    @Column()
    eventId!: string;

    // Derived from the authenticated request (req.user.id), never trusted
    // client input - per the explicit instruction "Derive the enumerator
    // from the authenticated request."
    @Column()
    enumeratorId!: string;

    @Column({ type: "simple-enum", enum: FieldEventType })
    type!: FieldEventType;

    // Best-effort free-text/id describing what the enumerator was working
    // on at the time (e.g. a cooperative/community name) - nullable
    // because, per the explicit instruction, formal CMIS assignment
    // records don't exist yet this release, so this is just contextual
    // metadata, not a foreign key to a real Assignment entity.
    // Explicit `type: "varchar"` required - see User.assignedCounty's
    // comment for why a bare `@Column({ nullable: true })` on a
    // `string | null`-typed property fails TypeORM's entity-metadata
    // validation (reflect-metadata reports `Object`, not `String`, for a
    // union type).
    @Column({ type: "varchar", nullable: true })
    assignmentContext!: string | null;

    // GPS - populated for CHECK_IN and FARM_RECORD_CAPTURE only. CHECK_OUT
    // rows intentionally leave these null (explicit requirement: "Check-out
    // should work without taking a GPS reading"). Also left null for a
    // CHECK_IN performed after the enumerator denied the location
    // permission (explicit requirement: "Allow check-in if location
    // permission is denied") - the check-in itself still succeeds, it
    // simply carries no coordinate.
    @Column({ type: "float", nullable: true })
    latitude!: number | null;

    @Column({ type: "float", nullable: true })
    longitude!: number | null;

    @Column({ type: "float", nullable: true })
    gpsAccuracyM!: number | null;

    // When the device itself captured this event (see class doc above).
    @Column({ type: "timestamp" })
    capturedAt!: Date;

    // When the backend actually received/persisted it - may be long after
    // capturedAt for an event that sat in the mobile offline queue.
    @CreateDateColumn()
    receivedAt!: Date;
}
