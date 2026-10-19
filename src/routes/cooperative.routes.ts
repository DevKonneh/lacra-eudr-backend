import { Router } from "express";
import { CooperativeController } from "../controllers/CooperativeController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const controller = new CooperativeController();

// No authMiddleware on purpose — see CooperativeController's class doc
// comment. This is published, non-sensitive reference data that must be
// reachable from the admin panel's unauthenticated public self-service
// farmer registration page, in addition to every logged-in flow.
router.get("/", (req, res) => controller.getAll(req, res));

// ADMIN-only: (re-)seeds the registry over HTTP. See
// CooperativeController.seed's doc comment for why this exists (lets an
// admin seed production without direct DB/shell access to Render).
router.post("/seed", authMiddleware([UserRole.ADMIN]), (req, res) => controller.seed(req, res));

router.get("/:id", (req, res) => controller.getOne(req, res));

export default router;
