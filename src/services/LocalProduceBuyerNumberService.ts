/**
 * LocalProduceBuyerNumberService — atomic LACRA-{###}-{YYYY} permit number
 * allocator for Local Produce Buyer certificates.
 *
 * Unlike the LACRA-CERT-{year}-{6digit} numbers used by the other four
 * application categories (ApplicationController.nextSequentialNumber,
 * which derives the next number by COUNTing rows created in the current
 * calendar year — safe for those categories because each one resets
 * annually), the Local Produce Buyer register's own numbering is a single
 * running sequence that does NOT reset annually: the imported historical
 * register already contains numbers from both 2025 and 2026 that continue
 * from each other (007 through 290), so a permit issued in 2027 must
 * continue the SAME sequence, not restart at 001.
 *
 * Allocation is done with SELECT ... FOR UPDATE on the single-row
 * LocalProduceBuyerSequence table inside the caller's transaction, so two
 * concurrent printCertificate() calls can never be handed the same number
 * (the second transaction blocks on the row lock until the first commits,
 * then reads the already-incremented value).
 */

import { EntityManager } from "typeorm";
import { LocalProduceBuyerSequence } from "../entities/LocalProduceBuyerSequence";

const SEQUENCE_ROW_ID = 1;

export class LocalProduceBuyerNumberService {
    /**
     * Allocates the next LACRA-{###}-{YYYY} number atomically within the
     * given transactional EntityManager. Must be called inside a
     * transaction (see printCertificate()'s use of AppDataSource.transaction)
     * so the row lock is held for the duration of the surrounding write.
     */
    static async allocateNext(manager: EntityManager): Promise<string> {
        const repo = manager.getRepository(LocalProduceBuyerSequence);

        // Row-level lock — blocks any concurrent allocateNext() call until
        // this transaction commits or rolls back.
        let seq = await repo
            .createQueryBuilder("seq")
            .setLock("pessimistic_write")
            .where("seq.id = :id", { id: SEQUENCE_ROW_ID })
            .getOne();

        if (!seq) {
            // First-ever allocation with no seed/import having run yet —
            // initialise defensively at 0 so the first issued number is 1.
            // In normal operation the historical import seeds this row
            // above the highest imported number before any fresh
            // allocation happens.
            seq = repo.create({ id: SEQUENCE_ROW_ID, lastNumber: 0 });
            await repo.save(seq);
            seq = await repo
                .createQueryBuilder("seq")
                .setLock("pessimistic_write")
                .where("seq.id = :id", { id: SEQUENCE_ROW_ID })
                .getOne();
        }

        const nextNumber = (seq as LocalProduceBuyerSequence).lastNumber + 1;
        await repo.update({ id: SEQUENCE_ROW_ID }, { lastNumber: nextNumber, updatedAt: new Date() });

        const year = new Date().getFullYear();
        return `LACRA-${nextNumber.toString().padStart(3, "0")}-${year}`;
    }

    /**
     * Initialises (or raises) the sequence counter to at least `minimum`,
     * so the next allocateNext() call returns minimum + 1. Used by the
     * historical import to seed the counter above the highest number
     * present in the imported register — including the explicitly pinned
     * legacy numbers (278, 279, 190) — so a fresh issuance immediately
     * after import can never collide with an imported historical record.
     * Safe to call repeatedly: never LOWERS an already-higher value, so
     * re-running the import after live issuances have occurred cannot
     * roll the counter backward.
     */
    static async ensureMinimum(manager: EntityManager, minimum: number): Promise<void> {
        const repo = manager.getRepository(LocalProduceBuyerSequence);
        let seq = await repo
            .createQueryBuilder("seq")
            .setLock("pessimistic_write")
            .where("seq.id = :id", { id: SEQUENCE_ROW_ID })
            .getOne();

        if (!seq) {
            await repo.save(repo.create({ id: SEQUENCE_ROW_ID, lastNumber: minimum, updatedAt: new Date() }));
            return;
        }
        if (seq.lastNumber < minimum) {
            await repo.update({ id: SEQUENCE_ROW_ID }, { lastNumber: minimum, updatedAt: new Date() });
        }
    }

    /** Read-only peek at the current counter value, for diagnostics/reporting. */
    static async currentValue(manager: EntityManager): Promise<number> {
        const repo = manager.getRepository(LocalProduceBuyerSequence);
        const seq = await repo.findOne({ where: { id: SEQUENCE_ROW_ID } });
        return seq?.lastNumber ?? 0;
    }
}
