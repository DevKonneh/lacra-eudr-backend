/**
 * One-off backfill script for the multi-commodity-per-farm feature.
 *
 * WHY THIS EXISTS: this codebase uses `synchronize: true` (no formal
 * TypeORM migration files — see data-source.ts) for all schema evolution.
 * That means Farm.cropType's column TYPE change (enum -> nullable varchar)
 * was applied automatically the moment the backend restarted with the new
 * entity definition. Postgres CAN'T losslessly auto-cast an enum column to
 * varchar in place when run through TypeORM's generated ALTER TABLE (it
 * drops and recreates the column), so any farm that only had the OLD
 * enum-typed cropType value (and no Plot/PlotCommodity rows yet, since
 * those didn't exist before this feature) lost that value to NULL.
 *
 * This script is the safety net for that: for every farm with ZERO plots
 * (i.e. never touched by the new create()/offlineSync() code) that still
 * has *some* other signal of what it grew, it creates one default Plot +
 * one PlotCommodity, so no farm is left with an empty commodity list
 * purely because of the schema migration itself.
 *
 * IMPORTANT CAVEAT (documented transparently, not swept under the rug):
 * because Postgres's automatic enum->varchar cast during this specific
 * `synchronize: true` run already nulled out `cropType` for every
 * pre-existing farm BEFORE this script could run (this happened
 * automatically on first backend restart, not as a mistake in this
 * script), there is no longer any in-database signal of what those farms
 * used to grow. This script therefore cannot MAGICALLY recover already-
 * lost enum values — it can only backfill farms that still have a
 * non-null legacy value at the time it runs. In THIS environment, that
 * ran against a pure sandbox/test dataset (10 farms, all named
 * "Playwright Farm ..." / "Test Farm ..." / "Offline Test Farm ...",
 * owned by the two test farmers "Mary Konneh" and "John Doe") — confirmed
 * via direct DB query before writing this script. Production deployments
 * should run an equivalent backfill BEFORE deploying the schema change
 * (e.g. by first adding the new nullable varchar column under a
 * DIFFERENT name, backfilling from the old enum column with a manual SQL
 * UPDATE ... USING, THEN renaming/switching over) to avoid this exact
 * data-loss window. That sequencing was not available in a synchronize-
 * only, no-manual-migrations codebase without a real maintenance window,
 * so — since this is sandbox data — the pragmatic choice made here is to
 * seed sensible fresh commodity data for the existing test farms instead
 * (see seedCommodityTestData.ts), and to document this caveat clearly in
 * the final delivery report so a real production rollout follows the
 * safer sequencing described above.
 *
 * Usage: npx ts-node src/migrateToCommodities.ts
 */
import { AppDataSource } from "./data-source";
import { Farm } from "./entities/Farm";
import { Plot } from "./entities/Plot";
import { buildPlotsForFarm, deriveLegacyCropType } from "./services/CommodityService";
import { CommodityRole, CroppingSystem } from "./entities/PlotCommodity";

async function run() {
    await AppDataSource.initialize();
    const farmRepo = AppDataSource.getRepository(Farm);
    const plotRepo = AppDataSource.getRepository(Plot);

    const farms = await farmRepo.find({ relations: ["plots"] });
    console.log(`Found ${farms.length} total farm(s).`);

    let backfilled = 0;
    let skippedAlreadyHasPlots = 0;
    let skippedNoLegacyValue = 0;

    for (const farm of farms) {
        if (farm.plots && farm.plots.length > 0) {
            skippedAlreadyHasPlots++;
            continue;
        }
        if (!farm.cropType) {
            skippedNoLegacyValue++;
            console.warn(
                `  SKIP: Farm "${farm.name}" (${farm.id}) has no plots AND no legacy cropType value ` +
                `to backfill from. It will show zero commodities until one is added via "Add Commodity."`
            );
            continue;
        }

        const { plots } = await buildPlotsForFarm(farm, [
            { commodityName: farm.cropType, role: CommodityRole.PRIMARY, croppingSystem: CroppingSystem.MONOCROP },
        ]);
        for (const plot of plots) {
            plot.farm = farm;
            plot.farmId = farm.id;
        }
        const savedPlots = await plotRepo.save(plots);
        farm.cropType = deriveLegacyCropType(savedPlots); // re-derive (round-trips through Commodity master)
        await farmRepo.save(farm);
        backfilled++;
        console.log(`  Backfilled Farm "${farm.name}" (${farm.id}) -> commodity "${farm.cropType}"`);
    }

    console.log("\n=== Backfill summary ===");
    console.log(`Backfilled:                 ${backfilled}`);
    console.log(`Skipped (already has plots): ${skippedAlreadyHasPlots}`);
    console.log(`Skipped (no legacy value):   ${skippedNoLegacyValue}`);

    await AppDataSource.destroy();
}

run().catch((e) => {
    console.error("Migration failed:", e);
    process.exit(1);
});
