/**
 * Deployment verification script for the Identity Verification feature
 * (commit ec80141 and follow-up). This codebase uses `synchronize: true`
 * with no formal TypeORM migration files (see data-source.ts and the
 * caveat documented in migrateToCommodities.ts) — schema changes are
 * applied automatically the moment the backend restarts with the new
 * entity definitions.
 *
 * WHY THIS IS SAFE (unlike the cropType enum->varchar change documented
 * in migrateToCommodities.ts, which caused data loss because Postgres
 * cannot losslessly cast an enum column to varchar in place):
 *   - Farmer gets 4 new columns, ALL nullable: identityVerifiedAt
 *     (timestamp), identityVerifiedByUserId (varchar), identityVerifiedByName
 *     (varchar), identityStatusReason (text). Adding a nullable column is
 *     always a safe, non-destructive ALTER TABLE ... ADD COLUMN.
 *   - FarmerAuditLog.action's enum (farmer_audit_log_action_enum) gets 3
 *     NEW values appended (IDENTITY_VERIFIED, IDENTITY_CONFLICT_FLAGGED,
 *     IDENTITY_REVERTED_TO_UNVERIFIED). Postgres supports ALTER TYPE ...
 *     ADD VALUE for enums without dropping/recreating the column or
 *     affecting existing rows — TypeORM's synchronize does exactly this
 *     when only NEW enum values are added (no existing values removed or
 *     renamed), which is the case here.
 *   - No existing column's TYPE changes, no column is renamed or dropped,
 *     no existing enum value is removed/renamed, no NOT NULL constraint is
 *     added to a column that could contain existing NULLs.
 *
 * CONFIRMED AGAINST THIS SANDBOX'S LOCAL DEV POSTGRES (18 pre-existing
 * farmer rows) on the first backend restart after this feature was
 * added: all 4 new columns appeared as nullable, all 3 new enum values
 * appended alongside the 6 pre-existing ones, row count unchanged
 * (18 -> 18), and every pre-existing farmer's identityStatus value was
 * preserved exactly (no row was reset to a different value). This was a
 * LOCAL SANDBOX DATABASE WITH UNRELATED TEST DATA, NOT THE PRODUCTION
 * DATABASE — re-run this exact verification against production after
 * deploying, using this script, before considering the rollout complete.
 *
 * Usage (run AFTER the new backend code has been deployed and has
 * connected at least once, so synchronize has had a chance to run):
 *   npx ts-node src/verifyIdentityVerificationSchema.ts
 *
 * Exits non-zero and prints a clear failure reason if anything looks
 * wrong, so it can be used as a deploy-gate check in CI/CD if desired.
 */
import { AppDataSource } from "./data-source";

async function run() {
    await AppDataSource.initialize();
    const runner = AppDataSource.createQueryRunner();

    try {
        console.log("=== Identity Verification schema verification ===\n");

        // 1. Confirm the 4 new Farmer columns exist with the expected
        //    nullability (all must be nullable — none should be NOT NULL).
        const farmerCols: { column_name: string; is_nullable: string; data_type: string }[] = await runner.query(`
            SELECT column_name, is_nullable, data_type
            FROM information_schema.columns
            WHERE table_name = 'farmer'
              AND column_name IN ('identityVerifiedAt', 'identityVerifiedByUserId', 'identityVerifiedByName', 'identityStatusReason')
            ORDER BY column_name;
        `);
        const expectedCols = ["identityStatusReason", "identityVerifiedAt", "identityVerifiedByName", "identityVerifiedByUserId"];
        const foundCols = farmerCols.map((c) => c.column_name).sort();
        const missingCols = expectedCols.filter((c) => !foundCols.includes(c));
        if (missingCols.length > 0) {
            console.error(`❌ FAIL: Missing Farmer columns: ${missingCols.join(", ")}. Has the backend been deployed/restarted against this database yet?`);
            process.exitCode = 1;
        } else {
            console.log("✅ All 4 new Farmer columns present:");
            farmerCols.forEach((c) => console.log(`   - ${c.column_name} (${c.data_type}, nullable=${c.is_nullable})`));
            const notNullable = farmerCols.filter((c) => c.is_nullable !== "YES");
            if (notNullable.length > 0) {
                console.error(`❌ FAIL: These columns should be NULLABLE but are not: ${notNullable.map((c) => c.column_name).join(", ")}`);
                process.exitCode = 1;
            }
        }

        // 2. Confirm the 3 new FarmerAuditLog action enum values exist
        //    ALONGSIDE the pre-existing ones (none should have been
        //    removed/renamed).
        const enumRows: { enumlabel: string }[] = await runner.query(`
            SELECT e.enumlabel
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'farmer_audit_log_action_enum'
            ORDER BY e.enumsortorder;
        `);
        const enumValues = enumRows.map((r) => r.enumlabel);
        const expectedPreExisting = ["CONTACT_UPDATED", "FARM_ADDED", "IDENTITY_CONFIRMED", "COMMODITY_ADDED", "COMMODITY_UPDATED", "COMMODITY_DEACTIVATED"];
        const expectedNew = ["IDENTITY_VERIFIED", "IDENTITY_CONFLICT_FLAGGED", "IDENTITY_REVERTED_TO_UNVERIFIED"];
        const missingPreExisting = expectedPreExisting.filter((v) => !enumValues.includes(v));
        const missingNew = expectedNew.filter((v) => !enumValues.includes(v));
        console.log(`\nFarmerAuditLog.action enum values found: ${enumValues.join(", ")}`);
        if (missingPreExisting.length > 0) {
            console.error(`❌ FAIL: Pre-existing enum values are MISSING (would indicate a destructive migration): ${missingPreExisting.join(", ")}`);
            process.exitCode = 1;
        }
        if (missingNew.length > 0) {
            console.error(`❌ FAIL: New enum values missing: ${missingNew.join(", ")}`);
            process.exitCode = 1;
        }
        if (missingPreExisting.length === 0 && missingNew.length === 0) {
            console.log("✅ All pre-existing enum values intact, all 3 new values present.");
        }

        // 3. Sanity check: row count + identityStatus distribution, so a
        //    human reviewing deploy logs can visually confirm no farmer
        //    rows were lost or reset.
        const [{ count }] = await runner.query(`SELECT count(*)::int AS count FROM farmer;`);
        const distribution = await runner.query(`SELECT "identityStatus", count(*)::int AS count FROM farmer GROUP BY "identityStatus" ORDER BY "identityStatus";`);
        console.log(`\nTotal farmer rows: ${count}`);
        console.log("identityStatus distribution:");
        distribution.forEach((d: any) => console.log(`   - ${d.identityStatus}: ${d.count}`));
        console.log("\n⚠️  Compare the total farmer row count above against your pre-deploy count (from your own records/dashboard) to confirm no rows were lost.");

        if (process.exitCode === 1) {
            console.error("\n=== VERIFICATION FAILED — see ❌ lines above ===");
        } else {
            console.log("\n=== VERIFICATION PASSED ===");
        }
    } finally {
        await runner.release();
        await AppDataSource.destroy();
    }
}

run().catch((err) => {
    console.error("Verification script crashed:", err);
    process.exit(1);
});
