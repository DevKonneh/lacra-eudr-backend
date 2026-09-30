import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Farmer } from "../entities/Farmer";
import { Farm } from "../entities/Farm";
import { FarmDocument } from "../entities/FarmDocument";
import { RiskAssessment } from "../entities/RiskAssessment";
import { SatelliteAlert } from "../entities/SatelliteAlert";
import { Inspection } from "../entities/Inspection";
import { Transfer } from "../entities/Transfer";
import { Batch } from "../entities/Batch";
import { OfflineSubmission } from "../entities/OfflineSubmission";
import { User, UserRole } from "../entities/User";
import { successResponse, errorResponse } from "../utils/response";
import { getGeoIdService } from "../services/GeoIdService";
import { getWhimoService } from "../services/WhimoService";

/**
 * Admin-only "reset test data" endpoint.
 *
 * Wipes ALL Farmer and Farm records — plus every dependent record that
 * foreign-keys to them (FarmDocument, RiskAssessment, SatelliteAlert,
 * Inspection.farm, Transfer.fromFarmer, Batch<->Farmer join rows,
 * OfflineSubmission shadow records) — in a single transaction, so the
 * database is either fully cleaned or left completely untouched if
 * anything fails partway through (no orphaned rows, no broken foreign
 * keys). Also deletes the auto-created FARMER-role User accounts that were
 * spun up alongside those farmers (their own login accounts), but leaves
 * ADMIN/INSPECTOR/BUYER/EXPORTER user accounts untouched.
 *
 * Intentionally requires the caller to pass `confirm: "DELETE ALL FARMER DATA"`
 * in the request body — a safety guard against accidental calls (e.g. from a
 * misconfigured client, a stray test script, or someone hitting the route
 * without realizing what it does) given this is an irreversible, destructive
 * operation with no soft-delete/undo.
 */
export class AdminMaintenanceController {
    async resetFarmerFarmData(req: Request, res: Response) {
        const CONFIRMATION_PHRASE = "DELETE ALL FARMER DATA";
        const { confirm } = req.body || {};

        if (confirm !== CONFIRMATION_PHRASE) {
            return errorResponse(
                res,
                `Refusing to reset data: missing/incorrect confirmation. Send { "confirm": "${CONFIRMATION_PHRASE}" } to proceed.`,
                [],
                400
            );
        }

        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const manager = queryRunner.manager;

            // Counts captured BEFORE deletion, for the response summary.
            const farmerCount = await manager.count(Farmer);
            const farmCount = await manager.count(Farm);

            // 1. Delete records that reference Farm (deepest dependents first).
            await manager
                .createQueryBuilder()
                .delete()
                .from(FarmDocument)
                .execute();

            await manager
                .createQueryBuilder()
                .delete()
                .from(RiskAssessment)
                .execute();

            await manager
                .createQueryBuilder()
                .delete()
                .from(SatelliteAlert)
                .execute();

            // Inspection.farm is nullable — clear the link rather than
            // deleting the inspection record itself (an inspection is its
            // own auditable record, not owned by the farm). Uses raw SQL
            // guarded by an information_schema check so this step simply
            // no-ops if the table doesn't exist/isn't named as expected in
            // a given environment, instead of aborting the whole reset.
            const inspectionTable = await manager.query(
                `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='inspection'`
            );
            if (inspectionTable.length > 0) {
                await manager.query(
                    'UPDATE "inspection" SET "farmId" = NULL WHERE "farmId" IS NOT NULL'
                );
            }

            // 2. Delete records that reference Farmer.
            await manager
                .createQueryBuilder()
                .delete()
                .from(Transfer)
                .where("fromFarmerId IS NOT NULL")
                .execute();

            // Batch <-> Farmer is a many-to-many join table with an
            // auto-generated name (batch_farmers_farmer or similar). Clear
            // it via the relation's query builder rather than a raw table
            // name so it works regardless of TypeORM's generated name.
            const batches = await manager.find(Batch, { relations: ["farmers"] });
            for (const batch of batches) {
                if (batch.farmers && batch.farmers.length > 0) {
                    batch.farmers = [];
                    await manager.save(Batch, batch);
                }
            }

            // Offline-submission shadow records reference nothing via FK
            // (syncedFarmerId is a plain string column) but are pure test
            // clutter once the real farmers they describe are gone.
            await manager.createQueryBuilder().delete().from(OfflineSubmission).execute();

            // 3. Delete all Farms, then all Farmers.
            await manager.createQueryBuilder().delete().from(Farm).execute();

            // Capture the linked User ids BEFORE deleting farmers (the FK
            // from Farmer -> User is on the Farmer side via userId).
            const farmersWithUsers = await manager.find(Farmer, {
                select: ["id", "userId"],
            });
            const linkedUserIds = farmersWithUsers
                .map((f) => f.userId)
                .filter((id): id is string => !!id);

            await manager.createQueryBuilder().delete().from(Farmer).execute();

            // 4. Delete the FARMER-role user accounts that belonged to those
            // farmers (their personal login accounts) — never touches
            // ADMIN/INSPECTOR/BUYER/EXPORTER accounts.
            let deletedUserCount = 0;
            if (linkedUserIds.length > 0) {
                const result = await manager
                    .createQueryBuilder()
                    .delete()
                    .from(User)
                    .where("id IN (:...ids)", { ids: linkedUserIds })
                    .andWhere("role = :role", { role: UserRole.FARMER })
                    .execute();
                deletedUserCount = result.affected || 0;
            }

            await queryRunner.commitTransaction();

            return successResponse(
                res,
                {
                    farmersDeleted: farmerCount,
                    farmsDeleted: farmCount,
                    farmerUserAccountsDeleted: deletedUserCount,
                },
                "All farmer and farm data has been permanently deleted. The admin panel and mobile app now have a clean slate."
            );
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            console.error("Error resetting farmer/farm data:", error);
            return errorResponse(res, "Error resetting data — no changes were made", [error.message], 500);
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * GET /api/admin-maintenance/integration-health
     *
     * Production health-check for all external integrations and GeoID statistics.
     * Returns a JSON snapshot suitable for display on the GeoID Admin dashboard
     * and for automated monitoring (Render health checks, uptime services).
     *
     * Checks:
     *  1. Database connectivity
     *  2. FAO GeoID API reachability
     *  3. WHIMO API reachability
     *  4. GeoID coverage stats (total farms, farms with GeoID, farms missing GeoID)
     *  5. Environment variable configuration status (no values exposed — just present/absent)
     *
     * ADMIN only. Does NOT modify any data.
     */
    async integrationHealth(req: Request, res: Response) {
        const startedAt = Date.now();

        // ── 1. Database ───────────────────────────────────────────────────────
        let dbOk = false;
        let dbError: string | null = null;
        try {
            await AppDataSource.query("SELECT 1");
            dbOk = true;
        } catch (e: any) {
            dbError = e.message;
        }

        // ── 2. FAO GeoID API ──────────────────────────────────────────────────
        let geoIdOk = false;
        let geoIdError: string | null = null;
        try {
            geoIdOk = await getGeoIdService().isHealthy();
            if (!geoIdOk) geoIdError = "GeoID API returned non-ok status";
        } catch (e: any) {
            geoIdError = e.message;
        }

        // ── 3. WHIMO API ──────────────────────────────────────────────────────
        let whimoOk = false;
        let whimoError: string | null = null;
        try {
            whimoOk = await getWhimoService().isHealthy();
            if (!whimoOk) whimoError = "WHIMO API returned non-ok status";
        } catch (e: any) {
            whimoError = e.message;
        }

        // ── 4. GeoID coverage stats ───────────────────────────────────────────
        let stats: {
            totalFarms: number;
            farmsWithGeoId: number;
            farmsMissingGeoId: number;
            farmsWithQrCode: number;
            coveragePct: number;
        } | null = null;

        if (dbOk) {
            try {
                const farmRepo = AppDataSource.getRepository(Farm);
                const total = await farmRepo.count();
                const withGeoId = await farmRepo
                    .createQueryBuilder("farm")
                    .where("farm.geoId IS NOT NULL AND farm.geoId != ''")
                    .getCount();
                const withQr = await farmRepo
                    .createQueryBuilder("farm")
                    .where("farm.farmQrCode IS NOT NULL AND farm.farmQrCode != ''")
                    .getCount();

                stats = {
                    totalFarms: total,
                    farmsWithGeoId: withGeoId,
                    farmsMissingGeoId: total - withGeoId,
                    farmsWithQrCode: withQr,
                    coveragePct: total > 0 ? Math.round((withGeoId / total) * 100) : 100,
                };
            } catch {
                // Non-fatal — stats unavailable if DB query fails
            }
        }

        // ── 5. Environment variable configuration ─────────────────────────────
        const envStatus = {
            GEOID_BASE_URL:           !!process.env.GEOID_BASE_URL,
            GEOID_COLLECTION_ID:      !!process.env.GEOID_COLLECTION_ID,
            GEOID_API_TOKEN:          !!process.env.GEOID_API_TOKEN,
            API_BASE_URL:             !!process.env.API_BASE_URL,
            WHIMO_API_BASE_URL:       !!process.env.WHIMO_API_BASE_URL,
            WHIMO_API_KEY:            !!process.env.WHIMO_API_KEY,
            WHIMO_ORG_ID:             !!process.env.WHIMO_ORG_ID,
            RATE_LIMIT_FARM_SCAN_MAX: !!process.env.RATE_LIMIT_FARM_SCAN_MAX,
            CLOUDINARY_CLOUD_NAME:    !!process.env.CLOUDINARY_CLOUD_NAME,
            SMTP_HOST:                !!process.env.SMTP_HOST,
        };

        // ── 6. Active env values (non-sensitive) ──────────────────────────────
        const envValues = {
            GEOID_BASE_URL:     process.env.GEOID_BASE_URL ?? "(using default: https://data.review.fao.org/geoid)",
            GEOID_COLLECTION_ID: process.env.GEOID_COLLECTION_ID ?? "(not set — using public anonymous collection)",
            WHIMO_API_BASE_URL: process.env.WHIMO_API_BASE_URL ?? "(using default: https://api.whimo.net/v1)",
            WHIMO_ORG_ID:       process.env.WHIMO_ORG_ID ?? "(not set)",
            API_BASE_URL:       process.env.API_BASE_URL ?? "(not set — QR codes may use incorrect base URL)",
            NODE_ENV:           process.env.NODE_ENV ?? "development",
        };

        // ── Overall status ────────────────────────────────────────────────────
        const allOk = dbOk && geoIdOk;  // WHIMO optional — doesn't block overall ok
        const elapsedMs = Date.now() - startedAt;

        const payload = {
            status: allOk ? "ok" : "degraded",
            checkedAt: new Date().toISOString(),
            elapsedMs,
            integrations: {
                database:  { ok: dbOk,    error: dbError },
                geoid_api: { ok: geoIdOk, error: geoIdError },
                whimo_api: { ok: whimoOk, error: whimoError, note: "WHIMO is optional — degraded here does not block farm scanning" },
            },
            geoidCoverage: stats,
            backfillRequired: stats ? stats.farmsMissingGeoId > 0 : null,
            backfillEndpoint: "POST /api/farms/backfill-geoids",
            backfillStreamEndpoint: "POST /api/farms/backfill-geoids?stream=1",
            envConfigured: envStatus,
            envValues,
        };

        const statusCode = dbOk ? 200 : 503;
        return res.status(statusCode).json({ success: dbOk, data: payload });
    }
}
