import { Router } from "express";
import { FarmerController } from "../controllers/FarmerController";
import { BatchController } from "../controllers/BatchController";

const router = Router();
const farmerController = new FarmerController();
const batchController = new BatchController();

// Public routes for Farmer
router.get("/farmers/:id", (req, res) => farmerController.getPublicFarmer(req, res));

// Public routes for Batch
router.get("/batches/:id", (req, res) => batchController.getPublicBatch(req, res));

export default router;
