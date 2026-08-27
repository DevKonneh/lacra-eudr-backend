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
}
