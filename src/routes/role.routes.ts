import { Router } from "express";
import { RoleController } from "../controllers/RoleController";
import { authMiddleware } from "../middleware/auth.middleware";

const router = Router();
const roleController = new RoleController();

// Apply auth middleware 
router.use(authMiddleware());

router.post("/", (req, res) => roleController.create(req, res));
router.get("/", (req, res) => roleController.getAll(req, res));
router.get("/:id", (req, res) => roleController.getOne(req, res));
router.put("/:id", (req, res) => roleController.update(req, res));
router.delete("/:id", (req, res) => roleController.delete(req, res));

export default router;
