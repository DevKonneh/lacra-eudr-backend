import { Router } from "express";
import { EudrReviewController } from "../controllers/EudrReviewController";
import { authMiddleware } from "../middleware/auth.middleware";
import { requireRecommendationRights } from "../middleware/eudrReview.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const controller = new EudrReviewController();

/**
 * EUDR assessment view + review decisions.
 *
 * READING is available to anyone who already sees compliance data for a farm, so
 * a buyer/exporter looking at a farm they are trading with can see its clearance
 * status. WRITING a review is limited to inspectors and admins (evidence and
 * recommendations), and only a holder of the EUDR review permission can issue a
 * FINAL decision - enforced in the controller, on the backend.
 */
router.get(
    "/farm/:farmId",
    authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.BUYER, UserRole.EXPORTER]),
    (req, res) => controller.forFarm(req, res),
);

// History for one plot: every recommendation and every final decision.
router.get(
    "/plot/:plotId/history",
    authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.BUYER, UserRole.EXPORTER]),
    (req, res) => controller.historyForPlot(req, res),
);

// Record a review: a recommendation (inspector/admin) or a final decision
// (EUDR review permission). `final: true` without the permission is refused.
router.post(
    "/plot/:plotId/review",
    authMiddleware(),
    requireRecommendationRights(),
    (req, res) => controller.recordReview(req, res),
);

export default router;
