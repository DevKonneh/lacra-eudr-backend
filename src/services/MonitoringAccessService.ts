import { AppDataSource } from "../data-source";
import { User, UserRole } from "../entities/User";

/**
 * Centralized access-scoping rule for every CMIS Monitoring endpoint
 * (User Activity, Enumerator Monitoring lists/details/counts/timelines/
 * map pins, and the field-event/sync-status endpoints that back them).
 *
 * Per the explicit instructions:
 *   - ADMIN (and SUPER_ADMIN, which this codebase's navigation.ts already
 *     treats as an admin-equivalent role) sees the full monitoring scope.
 *   - FIELD_SUPERVISOR sees ONLY enumerators where
 *     `enumerator.supervisorId === currentUser.id` — applied "consistently
 *     to lists, detail pages, counts, timelines, map pins, and linked
 *     records", i.e. every query must go through this same helper rather
 *     than each endpoint re-implementing its own ad hoc filter (the
 *     exact bug class verification scenario 6 — "a supervisor cannot
 *     access another supervisor's enumerator by manipulating a URL/
 *     filter/API parameter" — exists to catch).
 *   - Every other role is denied monitoring access outright (staff-wide
 *     User Activity + detailed sign-in history stay restricted to
 *     authorized admins per the explicit instruction).
 *   - An enumerator with NO supervisor (`supervisorId === null`) remains
 *     visible only to admins, never to an arbitrary field supervisor —
 *     it is not treated as "unscoped/visible to everyone" the way some
 *     legacy nullable fields elsewhere in this codebase are (e.g.
 *     Farmer.registeredByUserId's legacy-visibility fallback). That
 *     legacy-data pattern exists ONLY for data created before a
 *     scoping field existed; supervisorId is a brand-new field with no
 *     such legacy case to accommodate.
 */

export type MonitoringScope =
    | { kind: "ALL" } // admin: every enumerator, every user
    | { kind: "SUPERVISOR"; supervisorId: string } // field supervisor: only their direct reports
    | { kind: "DENIED" }; // any other role

function isAdminRole(role: string | undefined): boolean {
    // "SUPER_ADMIN" exists in the admin panel's frontend-only UserRole
    // union (types.ts) for the navigation/route-guard layer, but is NOT
    // currently a backend UserRole enum value (see entities/User.ts) - no
    // account can actually hold role === "SUPER_ADMIN" server-side today.
    // Checked anyway (as a string, not the backend enum) purely for
    // forward-compatibility / defense in depth, matching how
    // admin_panel_push/src/App.tsx's AdminRoute already checks both.
    return role === UserRole.ADMIN || role === "SUPER_ADMIN";
}

/** Reads the caller's role/id off the authenticated request (req.user, as
 * populated by authMiddleware) and returns their Monitoring scope. */
export function resolveMonitoringScope(requester: { id?: string; role?: string } | undefined): MonitoringScope {
    if (!requester?.id) return { kind: "DENIED" };
    if (isAdminRole(requester.role)) return { kind: "ALL" };
    if (requester.role === UserRole.FIELD_SUPERVISOR) {
        return { kind: "SUPERVISOR", supervisorId: requester.id };
    }
    return { kind: "DENIED" };
}

/**
 * Resolves a MonitoringScope down to the concrete list of enumerator user
 * ids it's allowed to see (undefined = no restriction / all enumerators,
 * for the ALL scope). Every Monitoring query (list, detail-by-id guard,
 * count, timeline, map pins, field-event lookups) must call this and
 * apply the result BEFORE returning any data, so scoping is enforced
 * identically everywhere rather than only hidden in the UI.
 */
export async function resolveVisibleEnumeratorIds(scope: MonitoringScope): Promise<string[] | undefined> {
    if (scope.kind === "ALL") return undefined;
    if (scope.kind === "DENIED") return [];
    const userRepository = AppDataSource.getRepository(User);
    const directReports = await userRepository.find({ where: { supervisorId: scope.supervisorId } });
    return directReports.map(u => u.id);
}

/** Convenience guard for a single-enumerator detail endpoint: is
 * `enumeratorId` visible under `scope`? */
export async function isEnumeratorVisible(scope: MonitoringScope, enumeratorId: string): Promise<boolean> {
    if (scope.kind === "ALL") return true;
    if (scope.kind === "DENIED") return false;
    const userRepository = AppDataSource.getRepository(User);
    const enumerator = await userRepository.findOneBy({ id: enumeratorId });
    return !!enumerator && enumerator.supervisorId === scope.supervisorId;
}
