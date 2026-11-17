import { Response, NextFunction } from "express";
import { AuthRequest } from "./auth.middleware";
import { hasPermission, hasAllPermissions } from "../config/permissions";

/**
 * requirePermission — fine-grained, backend-enforced authorization on top
 * of (not instead of) the existing coarse-role `authMiddleware([...])`
 * gates. MUST be mounted AFTER authMiddleware()/optionalAuthMiddleware() on
 * a route, since it reads `req.user.permissions`, which only those
 * middlewares populate.
 *
 * WHY THIS EXISTS: the admin panel already has a full "Roles & Permissions"
 * UI (RoleForm.tsx) for building custom permission sets like
 * `license.approve` or `farmer.delete`, and User.assignedRole already
 * stores which Role an account has — but until this middleware, NOTHING on
 * the backend ever consumed that data to make an authorization decision.
 * Every real access-control check was the coarse `User.role` enum via
 * `authMiddleware(roles)`. This meant:
 *   - An admin could build a maximally-restrictive custom Role and assign
 *     it to a COMMERCIAL account, and that account could still do
 *     EVERYTHING a COMMERCIAL account's routes allow — the custom Role had
 *     zero actual effect.
 *   - The only "enforcement" available anywhere was hiding/showing a
 *     button in the admin panel based on `user.permissions` — a client-
 *     side-only restriction trivially bypassed by calling the API
 *     directly (e.g. with curl/Postman using the same token).
 *
 * `requirePermission(...)` accepts one or more permission strings. By
 * default ALL given permissions must be present (AND semantics) — pass
 * `{ any: true }` for OR semantics on routes where holding any one of a
 * set of permissions is enough.
 */
export function requirePermission(
    permissions: string | string[],
    options: { any?: boolean } = {}
) {
    const required = Array.isArray(permissions) ? permissions : [permissions];

    return (req: AuthRequest, res: Response, next: NextFunction) => {
        const granted: string[] = req.user?.permissions || [];

        const allowed = options.any
            ? required.some((p) => hasPermission(granted, p))
            : hasAllPermissions(granted, required);

        if (!allowed) {
            return res.status(403).json({
                success: false,
                message: "Forbidden: You do not have permission to perform this action.",
                requiredPermissions: required,
            });
        }
        next();
    };
}
