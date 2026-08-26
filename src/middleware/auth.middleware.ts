import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export const JWT_SECRET = process.env.JWT_SECRET || "supersecretMVPkey";

export interface AuthRequest extends Request {
    user?: any;
}

export const authMiddleware = (roles: string[] = []) => {
    return (req: AuthRequest, res: Response, next: NextFunction) => {
        const token = req.headers.authorization?.split(" ")[1];

        if (!token) {
            return res.status(401).json({ message: "Unauthorized: No token provided" });
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            req.user = decoded;

            if (roles.length > 0 && !roles.includes((decoded as any).role)) {
                return res.status(403).json({ message: "Forbidden: Insufficient permissions" });
            }

            next();
        } catch (error) {
            return res.status(401).json({ message: "Unauthorized: Invalid token" });
        }
    };
};

// Like authMiddleware, but never rejects the request — it just populates
// req.user when a valid Bearer token is present, and silently leaves it
// undefined otherwise (missing token, or invalid/expired token). Use this
// on routes that must remain reachable by fully unauthenticated callers
// (e.g. the admin panel's public self-registration page) but that still
// want to know/attribute the caller's identity when they ARE logged in
// (e.g. the mobile app's inspector-led farmer registration flow, so
// registeredByUserId can be stamped for correct per-inspector data
// scoping — see FarmerController.getAll()).
export const optionalAuthMiddleware = () => {
    return (req: AuthRequest, _res: Response, next: NextFunction) => {
        const token = req.headers.authorization?.split(" ")[1];
        if (token) {
            try {
                req.user = jwt.verify(token, JWT_SECRET);
            } catch (error) {
                // Invalid/expired token on an optional-auth route: proceed
                // as an anonymous request rather than blocking it.
            }
        }
        next();
    };
};
