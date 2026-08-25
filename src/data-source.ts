import "reflect-metadata";
import { DataSource } from "typeorm";
import { Farmer } from "./entities/Farmer";
import { Farm } from "./entities/Farm";
import { Forest } from "./entities/Forest";
import { User } from "./entities/User";
import { License } from "./entities/License";
import { Batch } from "./entities/Batch";
import { Shipment } from "./entities/Shipment";
import { RiskAssessment } from "./entities/RiskAssessment";
import { FarmDocument } from "./entities/FarmDocument";
import { Role } from "./entities/Role";
import { Business } from "./entities/Business";
import { Permit } from "./entities/Permit";
import { Transfer } from "./entities/Transfer";
import { SatelliteAlert } from "./entities/SatelliteAlert";
import { Notification } from "./entities/Notification";
import dotenv from 'dotenv';

dotenv.config();

// Render's managed Postgres requires SSL for connections. Set DB_SSL=true
// in the environment (e.g. on Render) to enable it; leave unset for local
// sandbox/dev Postgres which does not use SSL.
const useSsl = process.env.DB_SSL === "true";

// Defensive trim: environment variables pasted through dashboard UIs
// (Render, etc.) can accidentally pick up a trailing newline or leading/
// trailing whitespace (e.g. from copy-paste or hitting Enter in a text
// field). A hostname like "host.example.com\n" fails DNS resolution with a
// confusing ENOTFOUND error that looks identical to a wrong hostname, which
// wastes a lot of debugging time. Trimming here makes the connection
// resilient to that class of copy-paste mistake.
const trimEnv = (value: string | undefined): string | undefined =>
    value !== undefined ? value.trim() : value;

export const AppDataSource = new DataSource({
    type: "postgres",
    host: trimEnv(process.env.DB_HOST) || "localhost",
    port: parseInt(trimEnv(process.env.DB_PORT) || "5432"),
    username: trimEnv(process.env.DB_USER) || "postgres",
    password: trimEnv(process.env.DB_PASSWORD) || "postgis",
    database: trimEnv(process.env.DB_NAME) || "eudr_db",
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    synchronize: true,
    logging: false,
    entities: [Farmer, Farm, Forest, User, License, Batch, Shipment, RiskAssessment, FarmDocument, Role, Business, Permit, Transfer, SatelliteAlert, Notification],
    subscribers: [],
    migrations: [],
});
