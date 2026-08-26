import { Router } from "express";
import { AuthController } from "../controllers/AuthController";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const authController = new AuthController();

router.post("/login", (req, res) => authController.login(req, res));

router.post("/forget-password", (req, res) => authController.forgotPassword(req, res));
router.post("/reset-password", (req, res) => authController.resetPassword(req, res));
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
router.post("/register-farmer", optionalAuthMiddleware(), upload.any(), (req, res) => authController.registerFarmer(req, res));
router.get("/pending", authMiddleware([UserRole.ADMIN]), (req, res) => authController.getPendingUsers(req, res));
router.put("/approve/:id", authMiddleware([UserRole.ADMIN]), (req, res) => authController.approveUser(req, res));
router.put("/reject/:id", authMiddleware([UserRole.ADMIN]), (req, res) => authController.rejectUser(req, res));

export default router;
