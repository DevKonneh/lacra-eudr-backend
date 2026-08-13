import { Router } from "express";
import { BusinessController } from "../controllers/BusinessController";
import { authMiddleware } from "../middleware/auth.middleware"; // Assuming auth middleware exists

const router = Router();
const businessController = new BusinessController();

router.post("/register", authMiddleware(), (req, res) => businessController.register(req, res));
router.get("/me", authMiddleware(), (req, res) => businessController.getMyBusiness(req, res));
router.get("/", authMiddleware(), (req, res) => businessController.getAll(req, res)); // Admin only typically

export default router;
