import { Router } from "express";
import { UserController } from "../controllers/UserController";
import { authMiddleware } from "../middleware/auth.middleware";

const router = Router();
const userController = new UserController();

// Apply auth middleware
router.use(authMiddleware());

router.post("/", (req, res) => userController.create(req, res));
router.get("/", (req, res) => userController.getAll(req, res));
router.get("/:id", (req, res) => userController.getOne(req, res));
router.put("/:id", (req, res) => userController.update(req, res));
router.delete("/:id", (req, res) => userController.delete(req, res));

export default router;
