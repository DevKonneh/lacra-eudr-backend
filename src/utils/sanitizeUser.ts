/**
 * sanitizeUser.ts — shared helper for stripping sensitive User fields out
 * of API responses.
 *
 * BACKGROUND: live integration testing against a running staging server
 * (security-hardening task, Nov 2026) found that several controllers
 * return a `User` entity embedded inside another entity's relation
 * (Business.owner, License.user, EnforcementAction.officer,
 * Inspection.inspector, QualityControl.inspector, and License loaded via
 * Batch.createdBy.user) WITHOUT stripping the bcrypt password hash (or the
 * SHA-256-hashed password-reset verification code) first — the full User
 * row, as returned by TypeORM, was serialized directly into the JSON
 * response. Confirmed live: POST /api/business/register's response body
 * contained a real `owner.password` bcrypt hash string.
 *
 * This is not a plaintext-password leak (bcrypt is one-way, and the
 * verification code is single-use + time-limited + SHA-256-hashed), but
 * it is an unnecessary, avoidable exposure of authentication secrets to
 * API callers who have no legitimate reason to ever see them — exactly
 * the kind of defect that should never reach a response body. Several
 * controllers already had an ad-hoc, per-method fix for this exact
 * pattern (UserController.getAll/getOne/update/create all manually
 * destructure `password` out before responding) — this module
 * consolidates that into one shared, directly-testable utility instead of
 * every controller reinventing (and potentially forgetting) the same
 * `const { password, ...rest } = user` pattern.
 *
 * Two entry points:
 *   - sanitizeUser(user): strips sensitive fields off a single User-shaped
 *     object (or returns non-objects/null/undefined unchanged).
 *   - deepSanitizeUsers(value): recursively walks an arbitrary
 *     entity/array/plain-object response payload and applies
 *     sanitizeUser() to every embedded object that "looks like" a User
 *     record (has both an `email` string and a `password` string) — this
 *     means it correctly reaches a User nested at ANY depth/relation path
 *     (`business.owner`, `createdBy.user`, `officer`, `inspector`, a bare
 *     array of such entities, etc.) without each controller needing to
 *     know or hardcode the exact relation path. Recommended for any
 *     controller response that includes ANY relation ultimately pointing
 *     at the User entity — see the "() => User" relations in
 *     EnforcementAction, Inspection, License, Notification,
 *     QualityControl, Business (owner), and Farmer (user).
 */

const SENSITIVE_USER_FIELDS = ["password", "verificationCode", "verificationCodeExpires"] as const;

/**
 * Strips sensitive auth-secret fields off a single User-shaped plain
 * object. Non-object inputs (null/undefined/primitives) are returned
 * unchanged. Does not mutate the input — returns a shallow copy.
 */
export function sanitizeUser<T extends Record<string, any> | null | undefined>(user: T): T {
    if (!user || typeof user !== "object") return user;
    const clone: any = { ...user };
    for (const field of SENSITIVE_USER_FIELDS) {
        delete clone[field];
    }
    return clone;
}

/**
 * Heuristic check for "this plain object is (or came from) a User
 * entity": both an `email` string and a `password` string are present.
 * Deliberately field-shape-based rather than `instanceof User`, since
 * TypeORM query results and already-partially-destructured objects are
 * plain objects, not guaranteed to be `User` class instances by the time
 * they reach a controller's response-building code.
 */
function looksLikeUserRecord(value: unknown): value is Record<string, any> {
    return (
        !!value &&
        typeof value === "object" &&
        typeof (value as any).email === "string" &&
        typeof (value as any).password === "string"
    );
}

/**
 * Recursively walks `value` (object, array, or primitive) and returns a
 * deep copy with sensitive fields stripped from every embedded
 * User-shaped object found at any depth. Safe to call on an entire
 * successResponse() payload regardless of which relations happen to be
 * populated. Dates and other non-plain-object values are passed through
 * unchanged (not recursed into). A WeakSet guards against infinite
 * recursion on any accidental circular reference between loaded
 * relations.
 */
export function deepSanitizeUsers<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
    if (value === null || value === undefined) return value;

    if (value instanceof Date) return value;

    if (Array.isArray(value)) {
        return value.map((item) => deepSanitizeUsers(item, seen)) as unknown as T;
    }

    if (typeof value === "object") {
        if (seen.has(value as object)) return value;
        seen.add(value as object);

        const base = looksLikeUserRecord(value) ? sanitizeUser(value as Record<string, any>) : value;

        const out: Record<string, any> = {};
        for (const key of Object.keys(base)) {
            out[key] = deepSanitizeUsers((base as any)[key], seen);
        }
        return out as T;
    }

    return value;
}
