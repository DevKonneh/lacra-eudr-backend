import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

/**
 * One row per authenticated web "tab session" (NOT per user) — lets a
 * single user have multiple browser tabs/windows open at once without one
 * tab's heartbeat/idle state clobbering another's. Presence for a USER is
 * always derived by aggregating (taking the most-recent heartbeat/
 * interaction across) every row where userId matches — see
 * MonitoringController.derivePresence().
 *
 * Lifecycle: the admin panel's heartbeat sender (added to Layout.tsx)
 * generates one random, opaque `tabId` the first time a tab loads (kept in
 * that tab's own sessionStorage, never shared across tabs, never tied to
 * anything identifying beyond the authenticated userId it's sent with),
 * then POSTs /api/monitoring/heartbeat on an interval WHILE the tab is
 * open — independently of window focus, so a backgrounded tab still keeps
 * its session Online/Idle rather than immediately reading stale (per the
 * explicit instruction to "send heartbeats independently of focus and
 * test background-tab behavior"). `lastInteractionAt` is bumped by the
 * same endpoint only when the client reports recent mouse/keyboard/touch
 * activity, kept as a SEPARATE timestamp from `lastHeartbeatAt` per the
 * explicit presence rule:
 *   - fresh heartbeat + recent interaction -> Online
 *   - fresh heartbeat + stale interaction  -> Idle
 *   - no fresh heartbeat (session expired) -> Offline
 * "Fresh"/"recent"/"stale" thresholds are configurable (see
 * monitoringConfig.ts) rather than hardcoded, per the explicit requirement
 * that heartbeat timing be configurable.
 *
 * No explicit DELETE on tab close (browsers cannot guarantee a reliable
 * unload request) — stale rows simply age out of the presence calculation
 * once `lastHeartbeatAt` exceeds the offline threshold, and are pruned
 * opportunistically (see MonitoringController) rather than needing their
 * own cron job for this release.
 */
@Entity()
@Index(["userId", "tabId"], { unique: true })
export class UserSession {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    // Owning account (from the JWT, never trusted client input).
    @Column()
    userId!: string;

    // Opaque, client-generated identifier for ONE browser tab — random
    // (crypto.randomUUID() client-side), carries no identifying
    // information itself, and is only ever meaningful paired with the
    // authenticated userId above (per the explicit instruction to "use an
    // opaque tab identifier tied to the authenticated user").
    @Column()
    tabId!: string;

    @Column({ type: "timestamp" })
    lastHeartbeatAt!: Date;

    @Column({ type: "timestamp", nullable: true })
    lastInteractionAt!: Date | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
