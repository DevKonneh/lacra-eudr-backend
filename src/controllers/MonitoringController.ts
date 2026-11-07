import { Response } from "express";
import { AppDataSource } from "../data-source";
import { User, UserRole } from "../entities/User";
import { UserSession } from "../entities/UserSession";
import { SignInAttempt } from "../entities/SignInAttempt";
import { FieldEvent, FieldEventType } from "../entities/FieldEvent";
import { MobileSyncStatus } from "../entities/MobileSyncStatus";
import { Farmer } from "../entities/Farmer";
import { Farm } from "../entities/Farm";
import { MonitoringConfig } from "../config/monitoringConfig";
import {
    resolveMonitoringScope,
    resolveVisibleEnumeratorIds,
    isEnumeratorVisible,
} from "../services/MonitoringAccessService";
import { successResponse, errorResponse } from "../utils/response";
import { AuthRequest } from "../middleware/auth.middleware";

/**
 * CMIS Monitoring read endpoints — "User Activity" (web presence + staff
 * sign-in history, admin-only) and "Enumerator Monitoring" / "Field
 * Progress" (field activity, last reported location, sync status, record
 * counts — admin OR the enumerator's own direct field supervisor, scoped
 * via MonitoringAccessService).
 *
 * Every list/detail method here resolves the caller's MonitoringScope
 * FIRST and applies it to the query BEFORE returning any data, per the
 * explicit requirement that access scoping be enforced identically
 * everywhere (never UI-only) and that a supervisor cannot see an
 * enumerator outside their direct reports by manipulating a URL/body
 * parameter.
 */
export class MonitoringController {
    private userRepository = AppDataSource.getRepository(User);
    private sessionRepository = AppDataSource.getRepository(UserSession);
    private signInAttemptRepository = AppDataSource.getRepository(SignInAttempt);
    private fieldEventRepository = AppDataSource.getRepository(FieldEvent);
    private syncStatusRepository = AppDataSource.getRepository(MobileSyncStatus);
    private farmerRepository = AppDataSource.getRepository(Farmer);
    private farmRepository = AppDataSource.getRepository(Farm);

    /**
     * POST /api/monitoring/heartbeat
     * Any authenticated web staff member may report their own heartbeat —
     * no role restriction. Upserts on (userId, tabId). `interacted: true`
     * bumps lastInteractionAt; omitting/false leaves it unchanged (a
     * background-tab heartbeat that only proves the tab is still open,
     * not that the user is actively looking at it).
     */
    async heartbeat(req: AuthRequest, res: Response) {
        try {
            const userId = req.user?.id;
            if (!userId) return errorResponse(res, "Unauthorized", [], 401);

            const { tabId, interacted } = req.body;
            if (!tabId || typeof tabId !== "string") {
                return errorResponse(res, "tabId is required", [], 400);
            }

            const now = new Date();
            let session = await this.sessionRepository.findOne({ where: { userId, tabId } });
            if (!session) {
                session = this.sessionRepository.create({ userId, tabId });
            }
            session.lastHeartbeatAt = now;
            if (interacted === true) {
                session.lastInteractionAt = now;
            }
            await this.sessionRepository.save(session);

            return successResponse(res, { receivedAt: now }, "Heartbeat recorded");
        } catch (error: any) {
            console.error("Heartbeat Error", error);
            return errorResponse(res, "Error recording heartbeat", [error.message], 500);
        }
    }

    /** Derives Online/Idle/Offline for one user from their freshest session row. */
    private derivePresence(sessions: UserSession[]): "ONLINE" | "IDLE" | "OFFLINE" {
        const now = Date.now();
        const alive = sessions.filter(
            (s) => now - new Date(s.lastHeartbeatAt).getTime() <= MonitoringConfig.heartbeatAliveWindowMs
        );
        if (alive.length === 0) return "OFFLINE";
        const recentlyInteracted = alive.some(
            (s) =>
                s.lastInteractionAt &&
                now - new Date(s.lastInteractionAt).getTime() <= MonitoringConfig.interactionFreshWindowMs
        );
        return recentlyInteracted ? "ONLINE" : "IDLE";
    }

    /**
     * GET /api/monitoring/user-activity
     * Admin-only (staff-wide web presence + last-login summary — per the
     * explicit requirement that this stay restricted to admins, not field
     * supervisors). Mounted route enforces the role; this method does not
     * re-check it, matching this codebase's existing convention of
     * route-level role gating (see user.routes.ts).
     */
    async getUserActivity(req: AuthRequest, res: Response) {
        try {
            const users = await this.userRepository.find();
            const allSessions = await this.sessionRepository.find();
            const sessionsByUser = new Map<string, UserSession[]>();
            for (const s of allSessions) {
                const arr = sessionsByUser.get(s.userId) || [];
                arr.push(s);
                sessionsByUser.set(s.userId, arr);
            }

            const result = users.map((u) => ({
                id: u.id,
                name: u.name,
                email: u.email,
                role: u.role,
                status: u.status,
                lastLoginAt: u.lastLoginAt,
                presence: this.derivePresence(sessionsByUser.get(u.id) || []),
            }));

            return successResponse(res, result);
        } catch (error: any) {
            console.error("Get User Activity Error", error);
            return errorResponse(res, "Error fetching user activity", [error.message], 500);
        }
    }

    /**
     * GET /api/monitoring/users/:id/sign-in-history
     * Admin-only (per the explicit requirement — detailed sign-in history
     * stays out of field-supervisor reach even for their own direct
     * reports). Sorted newest-first in memory (avoids a composite index
     * requirement on userId + createdAt beyond the existing lookup index).
     */
    async getUserSignInHistory(req: AuthRequest, res: Response) {
        try {
            const { id } = req.params;
            const attempts = await this.signInAttemptRepository.find({ where: { userId: id } });
            attempts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
            return successResponse(res, attempts);
        } catch (error: any) {
            console.error("Get User Sign-In History Error", error);
            return errorResponse(res, "Error fetching sign-in history", [error.message], 500);
        }
    }

    /**
     * GET /api/monitoring/enumerators
     * "Field Progress" list — admin sees every enumerator (INSPECTOR
     * role); a field supervisor sees ONLY their direct reports
     * (enumerator.supervisorId === caller.id). Includes field-status
     * (derived from the latest CHECK_IN/CHECK_OUT), last reported
     * location (latest event of ANY type that has coordinates, ordered by
     * capturedAt — never receivedAt, so a delayed upload can't look
     * newer), and actual record counts (farmers/farms registered by this
     * enumerator) — explicitly NOT assignment-based targets/percentages,
     * which are deferred per the agreed scope.
     */
    async getEnumerators(req: AuthRequest, res: Response) {
        try {
            const scope = resolveMonitoringScope(req.user);
            if (scope.kind === "DENIED") return errorResponse(res, "Forbidden", [], 403);

            const visibleIds = await resolveVisibleEnumeratorIds(scope);
            // undefined = ALL enumerators (admin); [] means "none" (a
            // supervisor with zero direct reports) and correctly falls
            // through to an empty result, not an error — DENIED is
            // already handled above.
            let enumerators: User[];
            if (visibleIds === undefined) {
                enumerators = await this.userRepository.find({ where: { role: UserRole.INSPECTOR } });
            } else if (visibleIds.length === 0) {
                enumerators = [];
            } else {
                enumerators = await this.userRepository.findByIds(visibleIds);
                enumerators = enumerators.filter((u) => u.role === UserRole.INSPECTOR);
            }

            const result = await Promise.all(enumerators.map((e) => this.buildEnumeratorSummary(e)));
            return successResponse(res, result);
        } catch (error: any) {
            console.error("Get Enumerators Error", error);
            return errorResponse(res, "Error fetching enumerators", [error.message], 500);
        }
    }

    /**
     * GET /api/monitoring/enumerators/:id
     * Single-enumerator detail, same access scoping as the list above but
     * enforced via isEnumeratorVisible() for a direct-by-id lookup — this
     * is the guard that specifically prevents a supervisor from reaching
     * another supervisor's enumerator by manipulating the :id in the URL.
     */
    async getEnumeratorDetail(req: AuthRequest, res: Response) {
        try {
            const scope = resolveMonitoringScope(req.user);
            if (scope.kind === "DENIED") return errorResponse(res, "Forbidden", [], 403);

            const { id } = req.params;
            const visible = await isEnumeratorVisible(scope, id);
            if (!visible) return errorResponse(res, "Forbidden", [], 403);

            const enumerator = await this.userRepository.findOneBy({ id });
            if (!enumerator) return errorResponse(res, "Enumerator not found", [], 404);

            const summary = await this.buildEnumeratorSummary(enumerator);

            // Field activity timeline (most recent first) — the raw events
            // backing the summary above, for the detail view's timeline UI.
            const events = await this.fieldEventRepository.find({ where: { enumeratorId: id } });
            events.sort((a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime());

            return successResponse(res, { ...summary, timeline: events });
        } catch (error: any) {
            console.error("Get Enumerator Detail Error", error);
            return errorResponse(res, "Error fetching enumerator detail", [error.message], 500);
        }
    }

    /**
     * Shared summary builder for both the list and detail endpoints, so
     * "field status", "last reported location", "sync status", and record
     * counts are computed identically everywhere they're shown (per the
     * explicit requirement that scoping/derivation never diverge between
     * a list view and a detail view).
     */
    private async buildEnumeratorSummary(enumerator: User) {
        const events = await this.fieldEventRepository.find({ where: { enumeratorId: enumerator.id } });
        // Order by capturedAt (device clock), NEVER receivedAt (server
        // clock) — a delayed/retried upload of an OLD capture must never
        // be mistaken for newer activity just because it reached the
        // server later.
        events.sort((a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime());

        // Field status: derived from the latest CHECK_IN/CHECK_OUT only
        // (FARM_RECORD_CAPTURE doesn't represent a check-in/out state
        // change, so it's excluded from this specific derivation even
        // though it's included in "last reported location" below).
        const checkEvents = events.filter(
            (e) => e.type === FieldEventType.CHECK_IN || e.type === FieldEventType.CHECK_OUT
        );
        const fieldStatus = checkEvents.length === 0
            ? "NEVER_CHECKED_IN"
            : checkEvents[0].type === FieldEventType.CHECK_IN
                ? "CHECKED_IN"
                : "CHECKED_OUT";

        // Last reported location: the latest event of ANY type that
        // actually carries coordinates — per the explicit requirement,
        // using the latest-by-capturedAt event, not just the latest event
        // overall (a CHECK_OUT or a permission-denied CHECK_IN has no
        // coordinates and must be skipped for this specific field, while
        // still counting toward fieldStatus above).
        const lastLocationEvent = events.find((e) => e.latitude !== null && e.longitude !== null);

        const [farmerCount, farmCount] = await Promise.all([
            this.farmerRepository.count({ where: { registeredByUserId: enumerator.id } }),
            this.farmRepository
                .createQueryBuilder("farm")
                .innerJoin("farm.farmer", "farmer")
                .where("farmer.registeredByUserId = :id", { id: enumerator.id })
                .getCount(),
        ]);

        const syncStatus = await this.syncStatusRepository.findOne({ where: { userId: enumerator.id } });

        return {
            id: enumerator.id,
            name: enumerator.name,
            email: enumerator.email,
            supervisorId: enumerator.supervisorId,
            assignedCounty: enumerator.assignedCounty,
            assignedDistrict: enumerator.assignedDistrict,
            fieldStatus,
            lastReportedLocation: lastLocationEvent
                ? {
                      latitude: lastLocationEvent.latitude,
                      longitude: lastLocationEvent.longitude,
                      capturedAt: lastLocationEvent.capturedAt,
                      sourceEventType: lastLocationEvent.type,
                  }
                : null,
            recordCounts: { farmers: farmerCount, farms: farmCount },
            syncStatus: syncStatus
                ? {
                      lastSuccessfulSyncAt: syncStatus.lastSuccessfulSyncAt,
                      lastPendingCount: syncStatus.lastPendingCount,
                      lastPendingReportedAt: syncStatus.lastPendingReportedAt,
                      lastSyncError: syncStatus.lastSyncError,
                      lastSyncErrorAt: syncStatus.lastSyncErrorAt,
                  }
                : null,
        };
    }
}
