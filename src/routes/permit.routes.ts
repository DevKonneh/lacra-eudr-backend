import { Router } from "express";
import { PermitController } from "../controllers/PermitController";
import { authMiddleware } from "../middleware/auth.middleware";

const router = Router();
const permitController = new PermitController();

router.post("/", authMiddleware(), (req, res) => permitController.create(req, res));
router.post("/:id/submit", authMiddleware(), (req, res) => permitController.submit(req, res));
router.post("/:id/recommend", authMiddleware(), (req, res) => permitController.recommend(req, res)); // Commercial
router.post("/:id/approve", authMiddleware(), (req, res) => permitController.approve(req, res)); // DG
router.post("/:id/issue", authMiddleware(), (req, res) => permitController.issue(req, res)); // Finance
router.get("/", authMiddleware(), (req, res) => permitController.getAll(req, res));

export default router;
