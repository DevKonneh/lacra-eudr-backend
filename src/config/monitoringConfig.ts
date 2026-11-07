/**
 * Configurable timing thresholds for the CMIS Monitoring feature's web
 * presence (Online/Idle/Offline) derivation — per the explicit
 * requirement that "heartbeat timing must be configurable" rather than
 * hardcoded. All overridable via environment variables (same pattern as
 * JWT_SECRET/DB_* elsewhere in this codebase), with sane defaults so the
 * feature works out of the box in dev/staging without any env setup.
 */

function envInt(name: string, fallbackMs: number): number {
    const raw = process.env[name];
    if (!raw) return fallbackMs;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

export const MonitoringConfig = {
    // How often the admin panel's heartbeat sender is expected to ping
    // (informational for the frontend interval; the backend only cares
    // about the thresholds below, not this value directly).
    heartbeatIntervalMs: envInt("MONITORING_HEARTBEAT_INTERVAL_MS", 30_000), // 30s

    // A session's lastHeartbeatAt must be within this window of "now" to
    // count as alive at all. Once it exceeds this, that tab's session is
    // effectively gone (browser closed / connection lost) and is excluded
    // from the user's presence aggregation entirely - if NO session
    // remains within this window, the user reads Offline.
    heartbeatAliveWindowMs: envInt("MONITORING_HEARTBEAT_ALIVE_WINDOW_MS", 90_000), // 90s (3 missed beats)

    // Within an alive session, lastInteractionAt must be within this
    // window of "now" for the session to count as Online rather than
    // Idle. A session can be "alive" (heartbeat fresh) but "Idle"
    // (interaction stale) at the same time - e.g. a tab left open on a
    // read-only screen in the background.
    interactionFreshWindowMs: envInt("MONITORING_INTERACTION_FRESH_WINDOW_MS", 5 * 60_000), // 5 min

    // SignInAttempt / FieldEvent retention is NOT enforced by this
    // feature (no automatic deletion) - left for a future ops/retention
    // pass if ever needed; flagged explicitly in the handoff doc.
};
