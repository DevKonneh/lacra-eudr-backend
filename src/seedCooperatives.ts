/**
 * Seeds the Cooperative registry from the real CDA cooperative listing
 * (95 records, embedded in src/data/cdaCooperativeSeedData.ts - see that
 * file's header for provenance/regeneration notes).
 *
 * Idempotent: upserts by `slug` (stable per name+county), so re-running
 * this (e.g. after a corrected data regeneration) updates existing rows
 * in place instead of creating duplicates.
 *
 * Runs the same way in every environment - local dev, CI, and the
 * production Docker image - because the seed data is a compiled
 * TypeScript module (ships in dist/), not an external file read at
 * runtime from a path that only exists in this dev sandbox.
 *
 * Usage:
 *   Local (ts-node):      npx ts-node src/seedCooperatives.ts
 *   Any environment:      npm run seed:cooperatives
 *     (runs "node dist/seedCooperatives.js" - requires `npm run build` first,
 *      same convention as the existing `npm run seed` -> seedAdmin.ts)
 */
import "reflect-metadata";
import { AppDataSource } from "./data-source";
import { Cooperative } from "./entities/Cooperative";
import { CDA_COOPERATIVE_SEED_DATA } from "./data/cdaCooperativeSeedData";

async function seed() {
    await AppDataSource.initialize();
    console.log(`Database connected. Seeding ${CDA_COOPERATIVE_SEED_DATA.length} cooperatives...`);

    const repo = AppDataSource.getRepository(Cooperative);
    let created = 0;
    let updated = 0;

    for (const rec of CDA_COOPERATIVE_SEED_DATA) {
        let coop = await repo.findOne({ where: { slug: rec.id } });
        const isNew = !coop;
        if (!coop) coop = new Cooperative();

        coop.slug = rec.id;
        coop.name = rec.name;
        coop.county = rec.county || undefined as any;
        coop.location = rec.location || undefined as any;
        coop.commodities = rec.commodities;
        coop.membershipTotal = rec.membership.total;
        coop.membershipMale = rec.membership.male;
        coop.membershipFemale = rec.membership.female;
        coop.contactName = rec.contact.name || undefined as any;
        coop.contactRole = rec.contact.role || undefined as any;
        coop.contactPhones = rec.contact.phones;
        coop.rawMembership = rec.membership.raw || undefined as any;
        coop.rawContact = rec.contact.raw || undefined as any;
        coop.isActive = true;

        await repo.save(coop);
        if (isNew) created++; else updated++;
    }

    console.log(`Done. Created ${created}, updated ${updated}, total in DB now: ${await repo.count()}.`);
    await AppDataSource.destroy();
}

seed()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error("Seeding failed:", e);
        process.exit(1);
    });
