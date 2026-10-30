import { Router } from "express";
import { ReportsController } from "../controllers/ReportsController";
import { authMiddleware } from "../middleware/auth.middleware";

const router = Router();
const reportsController = new ReportsController();

// These three endpoints had NO middleware at all - not even a bare
// authMiddleware() - so platform-wide aggregate farmer/farm statistics
// (county/district/gender/commodity breakdowns, compliance rates, license/
// permit/inspection/shipment counts) were reachable by anyone on the
// internet with no login whatsoever. The Dashboard page that consumes
// them (src/pages/Dashboard.tsx in the admin panel) is the app's landing
// index route - reachable by EVERY authenticated role, with no `roles`
// restriction in navigation.ts - so the correct fix is "must be logged
// in" (authMiddleware() with no role array), not a role-specific gate.
router.use(authMiddleware());

router.get("/dashboard", (req, res) => reportsController.getDashboardStats(req, res));
router.get("/farm-mapping-stats", (req, res) => reportsController.getFarmMappingStats(req, res));
router.get("/compliance-calculation", (req, res) => reportsController.getComplianceCalculationDetails(req, res));

export default router;
