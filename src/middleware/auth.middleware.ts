import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { AppDataSource } from "../data-source";
import { User, UserStatus } from "../entities/User";
import { getEffectivePermissions } from "../config/permissions";

export const JWT_SECRET = process.env.JWT_SECRET || "supersecretMVPkey";

export interface AuthRequest extends Request {
    user?: any;
}

interface DecodedToken {
    id: string;
    email: string;
    role: string;
    name?: string;
    // Added for session-revocation support (see migrations/2033_security_
    // hardening and User.tokenVersion's doc comment). Optional so a token
    // issued by an OLDER build of login() before this field existed is
    // still structurally decodable (treated as tokenVersion 0 below) —
    // though in practice every such token will have expired within its
    // original 24h lifetime long before this matters.
    tokenVersion?: number;
}

/**
 * authMiddleware — verifies the JWT AND re-checks the account's live state
 * in the database on every request.
 *
 * SECURITY HISTORY: previously this middleware only called jwt.verify() and
 * trusted the decoded token's `role`/`id` claims at face value for the
 * token's full 24-hour lifetime — it never queried the database, so:
 *   - Suspending/deactivating/rejecting an account had NO immediate effect;
 *     a token issued before the status change kept working until it
 *     naturally expired.
 *   - A role downgrade had no immediate effect either.
 *   - There was no way for an admin to forcibly end a specific session, and
 *     no way for a password reset/change to invalidate any OTHER session
 *     for that account.
 * This rewrite fixes all of that via a live `User` lookup plus the
 * `tokenVersion` column (see User.ts's doc comment on that column for the
 * full mechanism). It also resolves and attaches the account's EFFECTIVE
 * permission list (`req.user.permissions`) via `getEffectivePermissions()`,
 * for the `requirePermission(...)` middleware to enforce on individual
 * routes — see permission.middleware.ts.
 *
 * `roles` keeps its original meaning/behavior (coarse UserRole allow-list)
 * for full backward compatibility with every existing route declaration —
 * nothing calling `authMiddleware([UserRole.ADMIN])` etc. needs to change.
 */
export const authMiddleware = (roles: string[] = []) => {
    return async (req: AuthRequest, res: Response, next: NextFunction) => {
        const token = req.headers.authorization?.split(" ")[1];
        if (!token) return res.status(401).json({ message: "Unauthorized: No token provided" });

        let decoded: DecodedToken;
        try {
            decoded = jwt.verify(token, JWT_SECRET) as DecodedToken;
        } catch (error) {
            return res.status(401).json({ message: "Unauthorized: Invalid token" });
        }

        try {
            const userRepository = AppDataSource.getRepository(User);
            const user = await userRepository.findOne({
                where: { id: decoded.id },
                relations: ["assignedRole"],
            });

            if (!user) {
                // Account was deleted after the token was issued.
                return res.status(401).json({ message: "Unauthorized: Account no longer exists" });
            }

            if (user.status !== UserStatus.ACTIVE) {
                // Core fix for "suspension enforcement": a SUSPENDED/
                // REJECTED/PENDING account's existing tokens are rejected
                // on every request from this point forward, regardless of
                // the token's stated expiry.
                return res.status(403).json({ message: `Forbidden: Account is ${user.status}` });
            }

            const tokenVersion = decoded.tokenVersion ?? 0;
            if (tokenVersion !== user.tokenVersion) {
                // The account's tokenVersion has been bumped since this
                // token was issued (admin revoked sessions, account was
                // suspended, or the password was reset/changed) — this
                // specific token is no longer valid even though the
                // account itself may be perfectly fine and ACTIVE again.
                return res.status(401).json({ message: "Unauthorized: Session has been revoked. Please log in again." });
            }

            if (roles.length > 0 && !roles.includes(user.role)) {
                return res.status(403).json({ message: "Forbidden: Insufficient permissions" });
            }

            // Attach the LIVE role/status (not just the token's stale
            // claims) plus the resolved effective permission list, for
            // downstream handlers/requirePermission(...) to use.
            req.user = {
                id: user.id,
                email: user.email,
                role: user.role,
                name: user.name,
                status: user.status,
                tokenVersion: user.tokenVersion,
                permissions: getEffectivePermissions(user),
            };
            next();
        } catch (error) {
            console.error("authMiddleware DB check failed", error);
            return res.status(500).json({ message: "Internal server error during authentication" });
        }
    };
};

/**
 * optionalAuthMiddleware — never rejects the request. If a valid,
 * non-revoked, ACTIVE-account token is present, populates req.user exactly
 * like authMiddleware() does (including permissions); otherwise req.user
 * is left undefined and the request proceeds anonymously. Used for routes
 * that must stay reachable by anonymous callers but want to know who the
 * caller is when they ARE authenticated (e.g. POST /auth/register-farmer).
 */
export const optionalAuthMiddleware = () => {
    return async (req: AuthRequest, _res: Response, next: NextFunction) => {
        const token = req.headers.authorization?.split(" ")[1];
        if (!token) return next();

        try {
            const decoded = jwt.verify(token, JWT_SECRET) as DecodedToken;
            const userRepository = AppDataSource.getRepository(User);
            const user = await userRepository.findOne({
                where: { id: decoded.id },
                relations: ["assignedRole"],
            });

            if (!user || user.status !== UserStatus.ACTIVE) {
                return next();
            }
            const tokenVersion = decoded.tokenVersion ?? 0;
            if (tokenVersion !== user.tokenVersion) {
                return next();
            }

            req.user = {
                id: user.id,
                email: user.email,
                role: user.role,
                name: user.name,
                status: user.status,
                tokenVersion: user.tokenVersion,
                permissions: getEffectivePermissions(user),
            };
            next();
        } catch (error) {
            // Invalid/expired token on an optional route: proceed
            // anonymously rather than rejecting the request.
            next();
        }
    };
};
