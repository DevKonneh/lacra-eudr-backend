import { Router } from "express";
import { BusinessController } from "../controllers/BusinessController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const businessController = new BusinessController();

router.post("/register", authMiddleware(), (req, res) => businessController.register(req, res));
router.get("/me", authMiddleware(), (req, res) => businessController.getMyBusiness(req, res));
// Lists every business's registration number, KYC documents, and owner —
// this was previously reachable by ANY authenticated user (bare
// authMiddleware() with no role check), despite the "Admin only typically"
// comment that used to sit here. Restricted to the roles that actually
// need the full registry: ADMIN, and COMMERCIAL/DG who look up a
// business's eligibility during Application-workflow review.
router.get(
    "/",
    authMiddleware([UserRole.ADMIN, UserRole.COMMERCIAL, UserRole.DG]),
    (req, res) => businessController.getAll(req, res)
);

export default router;
