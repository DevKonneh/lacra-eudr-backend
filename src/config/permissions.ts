/**
 * permissions.ts — Fine-grained permission catalog + role-authorization
 * resolution for the User Management security-hardening work (see
 * migrations/2033_security_hardening and auth.middleware.ts).
 *
 * BACKGROUND: this codebase already had a `Role` entity with a
 * `permissions: string[]` column, a full admin-panel CRUD UI for it
 * ("Roles & Permissions"), and a `User.assignedRole` relation — but NOTHING
 * ever read `assignedRole.permissions` to make an authorization decision.
 * Every actual route guard checked only the coarse `User.role` enum
 * (ADMIN/INSPECTOR/BUYER/.../FIELD_SUPERVISOR) via `authMiddleware(roles)`.
 * An admin could spend time building a custom Role with specific
 * permissions and it would have ZERO effect on what that account could
 * actually do — this file (plus auth.middleware.ts's live permission
 * resolution) is what activates it for real.
 *
 * MIGRATION-SAFETY DESIGN (read this before changing DEFAULT_ROLE_PERMISSIONS):
 *   - An account with NO `assignedRole` set (every existing account today —
 *     confirmed empty `role` table in both dev and staging before this
 *     change) gets its effective permissions from DEFAULT_ROLE_PERMISSIONS
 *     below, keyed by its coarse `User.role`. This is written to
 *     exactly match what each role's existing routes already allow, so
 *     every current user's access is UNCHANGED the moment this ships.
 *   - An account WITH an `assignedRole` set gets EXACTLY that Role's
 *     `permissions` array as its effective permissions (not unioned with
 *     the coarse-role default) — this is what makes assigning a Role
 *     actually DO something: an admin can narrow a COMMERCIAL account down
 *     to e.g. only `license.view` by assigning a custom Role, and the
 *     backend will genuinely enforce that narrower set on every
 *     `requirePermission(...)`-guarded route, not just hide buttons.
 *   - UserRole.ADMIN is a hard-coded safety net: it ALWAYS resolves to
 *     the 'all' wildcard, regardless of any assignedRole, so a
 *     misconfigured custom Role can never fully lock every admin out of
 *     the system. (An ADMIN who should be deliberately restricted should
 *     have their coarse `role` changed away from ADMIN, not just have a
 *     narrow Role assigned while remaining ADMIN.)
 */

import { UserRole } from "../entities/User";

// ── Canonical permission catalog ────────────────────────────────────────────
// "resource.action" strings. Only actions that are actually meaningful for
// a given resource are listed (e.g. Permit has no "suspend" endpoint today,
// so "permit.suspend" does not exist — adding a permission string with no
// backing enforcement would be exactly the "looks real, does nothing"
// problem this work is fixing).
export const PERMISSIONS = {
    // User Management
    USER_VIEW: "user.view",
    USER_CREATE: "user.create",
    USER_EDIT: "user.edit",
    USER_SUSPEND: "user.suspend", // activate/deactivate/suspend via setStatus
    USER_DELETE: "user.delete",
    USER_REVOKE_SESSIONS: "user.revoke_sessions",

    // Roles & Permissions
    ROLE_VIEW: "role.view",
    ROLE_CREATE: "role.create",
    ROLE_EDIT: "role.edit",
    ROLE_DELETE: "role.delete",

    // Licensing (License entity — Exporter/LPB/Agency/Cooperative licenses)
    LICENSE_VIEW: "license.view",
    LICENSE_CREATE: "license.create",
    LICENSE_EDIT: "license.review", // Commercial "review" stage == edit-in-workflow
    LICENSE_APPROVE: "license.approve", // DG recommend/approve decision
    LICENSE_SUSPEND: "license.suspend",
    LICENSE_ISSUE: "license.issue", // Finance issuance (also a kind of "approve")

    // Permits (Permit entity — LPB/Agency/Cooperative permit applications)
    PERMIT_VIEW: "permit.view",
    PERMIT_CREATE: "permit.create",
    PERMIT_EDIT: "permit.review",
    PERMIT_APPROVE: "permit.approve",
    PERMIT_ISSUE: "permit.issue",

    // Farmer registry
    FARMER_VIEW: "farmer.view",
    FARMER_CREATE: "farmer.create",
    FARMER_EDIT: "farmer.edit",
    FARMER_DELETE: "farmer.delete",
    FARMER_VERIFY: "farmer.verify", // identity verification approve/flag

    // Farm registry
    FARM_VIEW: "farm.view",
    FARM_CREATE: "farm.create",
    FARM_EDIT: "farm.edit",
    FARM_DELETE: "farm.delete",

    // Business registry (Business entity — Exporter/LPB/Agency/Cooperative/
    // Transporter/Warehouse operator profiles). Note: "business.view" /
    // "business.create" were already referenced in the admin panel's
    // Sidebar nav config (permissionPrefixes: ['business']) before any
    // backend enforcement existed for them — this is what activates that
    // reference for real. register()/getMyBusiness() remain self-service
    // (any authenticated role may register/view their OWN business, same
    // pattern as license/permit apply()) and are NOT gated by either of
    // these permissions.
    BUSINESS_VIEW: "business.view", // full registry listing (getAll)
    BUSINESS_CREATE: "business.create", // reserved for a future staff-initiated creation endpoint; not used by register() (self-service)

    // Batches / Transfers / Shipments (supply-chain chain-of-custody)
    BATCH_VIEW: "batch.view",
    BATCH_CREATE: "batch.create",
    BATCH_EDIT: "batch.edit",
    TRANSFER_VIEW: "transfer.view",
    TRANSFER_CREATE: "transfer.create",
    SHIPMENT_VIEW: "shipment.view",
    SHIPMENT_CREATE: "shipment.create",
    SHIPMENT_APPROVE: "shipment.approve", // validate()/DDS issuance

    // Bulk data export (CSV dumps — distinct from "view" since it's a
    // whole-registry extraction, not a single-record read)
    EXPORT_FARMERS_FARMS: "export.farmers_farms",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: string[] = Object.values(PERMISSIONS);

/**
 * Wildcard that grants every permission. Reserved for ADMIN and for any
 * custom Role an admin deliberately wants to make fully privileged.
 */
export const WILDCARD_PERMISSION = "all";

// ── Default permission set per coarse UserRole ──────────────────────────────
// This is the MIGRATION-SAFETY fallback used for any account with no
// assignedRole — i.e. every account that exists today. Each list is derived
// directly from the UserRole arrays already hard-coded on the matching
// routes (license.routes.ts, permit.routes.ts, farmer.routes.ts,
// farm.routes.ts, user.routes.ts, role.routes.ts, export.routes.ts,
// batch/transfer/shipment routes) so this introduces no access regression.
export const DEFAULT_ROLE_PERMISSIONS: Record<UserRole, string[]> = {
    [UserRole.ADMIN]: [WILDCARD_PERMISSION],

    [UserRole.INSPECTOR]: [
        PERMISSIONS.FARMER_VIEW, PERMISSIONS.FARMER_CREATE, PERMISSIONS.FARMER_EDIT,
        PERMISSIONS.FARM_VIEW, PERMISSIONS.FARM_CREATE, PERMISSIONS.FARM_EDIT,
        PERMISSIONS.BATCH_VIEW, PERMISSIONS.BATCH_CREATE, PERMISSIONS.BATCH_EDIT,
        PERMISSIONS.TRANSFER_VIEW, PERMISSIONS.TRANSFER_CREATE,
        // shipment.routes.ts had NO role restriction at all before this
        // change — SHIPMENT_VIEW preserves INSPECTOR's existing ability
        // to browse the shipment registry (zero regression).
        PERMISSIONS.SHIPMENT_VIEW,
    ],

    [UserRole.BUYER]: [
        PERMISSIONS.FARMER_VIEW,
        PERMISSIONS.FARM_VIEW,
        PERMISSIONS.BATCH_VIEW,
        PERMISSIONS.TRANSFER_VIEW, PERMISSIONS.TRANSFER_CREATE,
        // See INSPECTOR's note above.
        PERMISSIONS.SHIPMENT_VIEW,
    ],

    [UserRole.EXPORTER]: [
        PERMISSIONS.FARMER_VIEW,
        PERMISSIONS.FARM_VIEW,
        PERMISSIONS.BATCH_VIEW,
        // transfer.routes.ts had NO role restriction at all before this
        // change — TRANSFER_VIEW preserves EXPORTER's existing ability to
        // browse the transfer/custody registry (zero regression).
        PERMISSIONS.TRANSFER_VIEW,
        PERMISSIONS.SHIPMENT_VIEW, PERMISSIONS.SHIPMENT_CREATE,
    ],

    // Self-service only — a farmer account has no admin-panel resource
    // permissions (their own profile/farm endpoints are keyed off their own
    // id/ownership, not off this permission system).
    [UserRole.FARMER]: [],

    [UserRole.COMMERCIAL]: [
        PERMISSIONS.LICENSE_VIEW, PERMISSIONS.LICENSE_CREATE, PERMISSIONS.LICENSE_EDIT,
        PERMISSIONS.PERMIT_VIEW, PERMISSIONS.PERMIT_CREATE, PERMISSIONS.PERMIT_EDIT,
        // Matches business.routes.ts's existing
        // authMiddleware([ADMIN, COMMERCIAL, DG]) on GET /api/business —
        // Commercial staff already had route-level access to the full
        // business registry (used to check an applicant's eligibility
        // during license/permit review); this just gives that access a
        // matching fine-grained permission (zero regression).
        PERMISSIONS.BUSINESS_VIEW,
    ],

    [UserRole.DG]: [
        PERMISSIONS.LICENSE_VIEW, PERMISSIONS.LICENSE_APPROVE, PERMISSIONS.LICENSE_SUSPEND,
        PERMISSIONS.PERMIT_VIEW, PERMISSIONS.PERMIT_APPROVE,
        // See COMMERCIAL's note above — DG is in the same existing
        // authMiddleware([ADMIN, COMMERCIAL, DG]) allow-list.
        PERMISSIONS.BUSINESS_VIEW,
        // Shipment compliance validation / DDS issuance is an official
        // government sign-off (same category as LICENSE_APPROVE /
        // PERMIT_APPROVE above), not a self-service action — DG is the
        // approving authority for it, same as for licenses/permits.
        PERMISSIONS.BATCH_VIEW, PERMISSIONS.TRANSFER_VIEW,
        PERMISSIONS.SHIPMENT_VIEW, PERMISSIONS.SHIPMENT_APPROVE,
    ],

    [UserRole.FINANCE]: [
        PERMISSIONS.LICENSE_VIEW, PERMISSIONS.LICENSE_ISSUE,
        PERMISSIONS.PERMIT_VIEW, PERMISSIONS.PERMIT_ISSUE,
        // batch/transfer/shipment routes had NO role restriction at all
        // before this change (bare authMiddleware(), any authenticated
        // user) — granting VIEW here to every existing internal staff
        // role (see TECHNICAL/IT below too) preserves that same
        // "any staff member can browse the registry" reality rather than
        // introducing a new restriction as a side effect of adding
        // enforcement elsewhere. Only the genuine self-approval loophole
        // (SHIPMENT_APPROVE, i.e. validate()/DDS issuance) is narrowed —
        // see ADMIN/DG below.
        PERMISSIONS.BATCH_VIEW, PERMISSIONS.TRANSFER_VIEW, PERMISSIONS.SHIPMENT_VIEW,
    ],

    // Technical review / inspector-assignment workflow — VIEW-only on
    // batch/transfer/shipment for the same "no regression vs. today's
    // unrestricted routes" reason as FINANCE above. Not given any
    // license/permit permission (not one of the resources getting
    // fine-grained enforcement there yet, see final report
    // "remaining gaps"); relies purely on the existing coarse-role route
    // gates it already has for that workflow.
    [UserRole.TECHNICAL]: [
        PERMISSIONS.BATCH_VIEW, PERMISSIONS.TRANSFER_VIEW, PERMISSIONS.SHIPMENT_VIEW,
    ],

    // Certificate printing/issuance workflow — same VIEW-only note as
    // TECHNICAL above.
    [UserRole.IT]: [
        PERMISSIONS.BATCH_VIEW, PERMISSIONS.TRANSFER_VIEW, PERMISSIONS.SHIPMENT_VIEW,
    ],

    // Monitoring-only role — no admin-panel resource permissions.
    [UserRole.FIELD_SUPERVISOR]: [],
};

// ── Resolution helpers ───────────────────────────────────────────────────────

/** Minimal shape this module needs from a User row (avoids importing the
 * full entity type into call sites that only have a plain object, e.g. the
 * JWT-decoded payload). */
export interface PermissionSubject {
    role: UserRole;
    assignedRole?: { permissions?: string[] | null } | null;
}

/**
 * Computes the authoritative, effective permission list for a user.
 *
 *   - ADMIN role -> always ['all'], regardless of assignedRole (safety net).
 *   - assignedRole set (even to an empty permissions array) -> EXACTLY that
 *     Role's permissions, authoritative and narrowing. An admin can
 *     deliberately assign a Role with an empty/short permissions array to
 *     restrict an account below its coarse-role default.
 *   - no assignedRole -> DEFAULT_ROLE_PERMISSIONS[role] (today's behavior,
 *     unchanged).
 */
export function getEffectivePermissions(user: PermissionSubject): string[] {
    if (user.role === UserRole.ADMIN) {
        return [WILDCARD_PERMISSION];
    }
    if (user.assignedRole && Array.isArray(user.assignedRole.permissions)) {
        return user.assignedRole.permissions;
    }
    return DEFAULT_ROLE_PERMISSIONS[user.role] ?? [];
}

/** True if `granted` includes `required`, or the 'all' wildcard. */
export function hasPermission(granted: string[], required: string): boolean {
    return granted.includes(WILDCARD_PERMISSION) || granted.includes(required);
}

/** True if `granted` includes every permission in `required`. */
export function hasAllPermissions(granted: string[], required: string[]): boolean {
    return required.every((p) => hasPermission(granted, p));
}

/**
 * Privilege-escalation guard: is `candidatePermissions` fully contained
 * within `actorPermissions` (or does the actor hold the 'all' wildcard)?
 * Used when an actor creates/edits a Role, or assigns a Role to another
 * user, so nobody can grant a permission set wider than their own.
 */
export function isSubsetOfActorPermissions(candidatePermissions: string[], actorPermissions: string[]): boolean {
    if (actorPermissions.includes(WILDCARD_PERMISSION)) return true;
    if (candidatePermissions.includes(WILDCARD_PERMISSION)) {
        // Only an actor who already holds 'all' may grant/create a role
        // that itself holds the 'all' wildcard.
        return false;
    }
    return candidatePermissions.every((p) => actorPermissions.includes(p));
}
