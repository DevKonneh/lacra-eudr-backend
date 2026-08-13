import "reflect-metadata";
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';

dotenv.config();

import { AppDataSource } from "./data-source";
import farmerRoutes from "./routes/farmer.routes";

const app = express();
const PORT = process.env.PORT || 8100;

app.use(cors({
    origin: [
        "https://eudr.netdivs.us",
        "http://localhost:8100",
        "http://localhost:8180",
        "http://localhost:5173",
        "http://localhost:5060",
        "https://5062-i9tadgf8ntmirkrse9hvt-de59bda9.sandbox.novita.ai"
    ],
    credentials: true
}));
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(express.json());

// Serve uploaded files (farmer/farm photos, IDs, signatures) as static assets
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

AppDataSource.initialize().then(async () => {
    console.log("Database connected successfully.");
}).catch(error => console.log(error));

app.get('/', (req, res) => {
    res.send('LACRA Platform API is running');
});

import riskRoutes from "./routes/risk.routes";
import reportsRoutes from "./routes/reports.routes";
import authRoutes from "./routes/auth.routes";
import licenseRoutes from "./routes/license.routes";
import batchRoutes from "./routes/batch.routes";
import shipmentRoutes from "./routes/shipment.routes";
import satelliteRoutes from "./routes/satellite.routes";
import farmRoutes from "./routes/farm.routes";
import documentRoutes from "./routes/document.routes";
import roleRoutes from "./routes/role.routes";
import userRoutes from "./routes/user.routes";
import publicRoutes from "./routes/public.routes";
import businessRoutes from "./routes/business.routes";
import transferRoutes from "./routes/transfer.routes";
import notificationRoutes from "./routes/notification.routes";

import permitRoutes from "./routes/permit.routes";
import inspectionRoutes from "./routes/inspection.routes";
import qualityRoutes from "./routes/quality.routes";
import enforcementRoutes from "./routes/enforcement.routes";

app.use("/api/public", publicRoutes);
app.use("/api/business", businessRoutes);
app.use("/api/transfers", transferRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/permits", permitRoutes);
app.use("/api/inspections", inspectionRoutes);
app.use("/api/quality", qualityRoutes);
app.use("/api/enforcement", enforcementRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/licenses", licenseRoutes);
app.use("/api/batches", batchRoutes);
app.use("/api/shipments", shipmentRoutes);
app.use("/api/farmers", farmerRoutes);
app.use("/api/farms", farmRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/risk", riskRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/satellite", satelliteRoutes);
app.use("/api/roles", roleRoutes);
app.use("/api/users", userRoutes);

import { errorHandler } from "./middleware/error.middleware";
app.use(errorHandler);

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
