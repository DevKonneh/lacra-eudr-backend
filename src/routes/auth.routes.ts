import { Router } from "express";
import { AuthController } from "../controllers/AuthController";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth.middleware";
import { authRateLimiter } from "../middleware/rateLimit.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const authController = new AuthController();

// authRateLimiter: 10 req / 15 min per IP — prevents brute-force and
// credential-stuffing attacks against all authentication entry-points.
router.post("/login", authRateLimiter, (req, res) => authController.login(req, res));

router.post("/forget-password", authRateLimiter, (req, res) => authController.forgotPassword(req, res));
router.post("/reset-password", authRateLimiter, (req, res) => authController.resetPassword(req, res));
// In-app password change for a logged-in user (requires their CURRENT
// password, unlike forget/reset-password which is for locked-out users).
router.post("/change-password", authMiddleware(), (req, res) => authController.changePassword(req, res));
import { upload } from "../middleware/upload.middleware";

// IMPORTANT: this route must stay reachable by fully unauthenticated
// callers too — the admin panel's public "/register" page (self-service
// farmer sign-up, no login) posts here without a token. So we use
// optionalAuthMiddleware (never rejects the request) rather than
// authMiddleware (which would 401 anonymous callers). When the caller IS
// authenticated (e.g. the mobile app's inspector-led registration flow,
// which always sends a Bearer token), this populates req.user so
// registerFarmer() can stamp registeredByUserId for correct per-inspector
// data scoping (see FarmerController.getAll()). Previously this route had
// no auth middleware at all, so req.user was always undefined and every
// mobile-registered farmer ended up with a NULL registeredByUserId, which
// getAll()'s legacy-data fallback treats as visible to every inspector —
// the root cause of inspectors seeing each other's newly-registered farmers.
// authRateLimiter here prevents automated farmer-account enumeration / spam.
router.post("/register-farmer", authRateLimiter, optionalAuthMiddleware(), upload.any(), (req, res) => authController.registerFarmer(req, res));
router.get("/pending", authMiddleware([UserRole.ADMIN]), (req, res) => authController.getPendingUsers(req, res));
router.put("/approve/:id", authMiddleware([UserRole.ADMIN]), (req, res) => authController.approveUser(req, res));
router.put("/reject/:id", authMiddleware([UserRole.ADMIN]), (req, res) => authController.rejectUser(req, res));

export default router;
