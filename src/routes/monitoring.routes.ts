import { Router } from "express";
import { MonitoringController } from "../controllers/MonitoringController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const controller = new MonitoringController();

// Any authenticated web staff member may report their own heartbeat - no
// role restriction (per the explicit requirement).
router.post("/heartbeat", authMiddleware(), (req, res) => controller.heartbeat(req, res));

// Staff-wide User Activity + detailed sign-in history: admin-only, per
// the explicit requirement that this stay restricted to admins and NOT
// be reachable by field supervisors.
router.get("/user-activity", authMiddleware([UserRole.ADMIN]), (req, res) => controller.getUserActivity(req, res));
router.get("/users/:id/sign-in-history", authMiddleware([UserRole.ADMIN]), (req, res) => controller.getUserSignInHistory(req, res));

// Enumerator Monitoring / Field Progress: admin OR field supervisor -
// the actual row-level scoping (supervisor sees only their own direct
// reports) is enforced inside the controller via MonitoringAccessService,
// not at this route-role-allowlist layer, since "field supervisor" must
// still be let IN here and then scoped down per-enumerator.
router.get(
    "/enumerators",
    authMiddleware([UserRole.ADMIN, UserRole.FIELD_SUPERVISOR]),
    (req, res) => controller.getEnumerators(req, res)
);
router.get(
    "/enumerators/:id",
    authMiddleware([UserRole.ADMIN, UserRole.FIELD_SUPERVISOR]),
    (req, res) => controller.getEnumeratorDetail(req, res)
);

export default router;
