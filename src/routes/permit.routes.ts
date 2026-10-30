import { Router } from "express";
import { PermitController } from "../controllers/PermitController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const permitController = new PermitController();

router.post("/", authMiddleware(), (req, res) => permitController.create(req, res));
router.get("/:id", authMiddleware(), (req, res) => permitController.getOne(req, res));
router.put("/:id", authMiddleware(), (req, res) => permitController.update(req, res));
router.post("/:id/submit", authMiddleware(), (req, res) => permitController.submit(req, res));

// These three are workflow-transition endpoints equivalent to the
// Application workflow's Commercial/DG/Finance stages (see the matching
// role-gates on application.routes.ts), but previously had NO role
// restriction at all - just a comment naming the intended role. That meant
// ANY authenticated user, including the applicant who owns the permit
// being reviewed, could call these directly to self-recommend, self-
// approve and self-issue their own official government permit.
router.post("/:id/recommend", authMiddleware([UserRole.COMMERCIAL, UserRole.ADMIN]), (req, res) => permitController.recommend(req, res)); // Commercial
router.post("/:id/approve", authMiddleware([UserRole.DG, UserRole.ADMIN]), (req, res) => permitController.approve(req, res)); // DG
router.post("/:id/issue", authMiddleware([UserRole.FINANCE, UserRole.ADMIN]), (req, res) => permitController.issue(req, res)); // Finance

router.get("/", authMiddleware(), (req, res) => permitController.getAll(req, res));

export default router;
