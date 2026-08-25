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

// Allow the known local/dev origins plus any extra origins supplied via the
// CORS_EXTRA_ORIGINS env var (comma-separated), so the deployed frontend
// domain can be added without another code change/redeploy of this file.
const defaultOrigins = [
    "https://eudr.netdivs.us",
    "http://localhost:8100",
    "http://localhost:8180",
    "http://localhost:5173",
    "http://localhost:5060",
];
const extraOrigins = (process.env.CORS_EXTRA_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
const allowedOrigins = [...defaultOrigins, ...extraOrigins];

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, server-to-server)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        // Allow any *.onrender.com subdomain (frontend/backend both hosted on Render)
        if (/\.onrender\.com$/.test(new URL(origin).hostname)) {
            return callback(null, true);
        }
        return callback(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true
}));
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(express.json());

// Serve uploaded files (farmer/farm photos, IDs, signatures) as static assets
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

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

// IMPORTANT: Only start accepting HTTP requests AFTER the database connection
// (and TypeORM entity metadata) is fully initialized. Previously the server
// called app.listen() unconditionally, regardless of whether the DB connection
// succeeded, which meant that if the DB connection failed for any reason
// (wrong host/credentials/SSL settings), the server would keep running forever
// in a broken state, silently returning "No metadata for ... was found" errors
// on every single request instead of failing loudly.
AppDataSource.initialize()
    .then(() => {
        console.log("Database connected successfully.");
        app.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`);
        });
    })
    .catch((error) => {
        console.error("FATAL: Database connection failed. Server will not start.");
        console.error(error);
        process.exit(1);
    });
