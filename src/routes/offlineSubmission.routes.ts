import { Router } from "express";
import { OfflineSubmissionController } from "../controllers/OfflineSubmissionController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const controller = new OfflineSubmissionController();

// Admin + Inspector can see everything currently unsynced across all
// devices - this is the "backend/admin visibility" feature itself.
router.get("/", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), (req, res) => controller.getAll(req, res));

// An inspector's own unsynced items (scoped server-side to req.user.id).
router.get("/mine", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), (req, res) => controller.getMine(req, res));

// Mobile app calls this as soon as something is queued locally, and again
// whenever its retry/error state changes.
router.post("/report", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), (req, res) => controller.report(req, res));

// Mobile app calls this once an item actually finishes syncing (or is
// discarded locally), so the shadow record doesn't linger.
router.post("/:clientId/resolve", authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]), (req, res) => controller.resolve(req, res));

export default router;
