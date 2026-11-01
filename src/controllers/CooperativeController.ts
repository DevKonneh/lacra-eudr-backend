import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Cooperative } from "../entities/Cooperative";
import { CooperativeFlag, CooperativeFlagStatus, CooperativeFlagType } from "../entities/CooperativeFlag";
import { CooperativeChangeLog, CooperativeChangeSource } from "../entities/CooperativeChangeLog";
import { CooperativeImportRun } from "../entities/CooperativeImportRun";
import { Farmer } from "../entities/Farmer";
import { successResponse, errorResponse } from "../utils/response";
import { CDA_COOPERATIVE_SEED_DATA, CdaCooperativeSeedRecord } from "../data/cdaCooperativeSeedData";
import { similarityRatio } from "../utils/stringSimilarity";

// Fixed, honest label for every import run — there is no live connection
// to any external CDA system, only this embedded, manually-regenerated
// listing. Surfaced verbatim in the registry maintenance UI so staff never
// mistake this for a live feed.
const IMPORT_SOURCE_LABEL = "Embedded CDA Listing (cdaCooperativeSeedData.ts)";

// Candidate pairs scoring at or above this similarity ratio are
// surfaced as SUSPECTED_DUPLICATE flags by the automated scan. Chosen to
// catch near-identical spellings/punctuation differences of the same
// cooperative without flagging every cooperative that merely shares the
// word "COOPERATIVE" or a county name.
const DUPLICATE_SIMILARITY_THRESHOLD = 0.82;

// Fields editable via the correction endpoint — matches the structured
// fields the registry UI exposes for manual review, deliberately
// excluding `slug` (the stable upsert key) and `isActive` (has its own
// dedicated toggle semantics, not a "correction").
const CORRECTABLE_FIELDS: (keyof Cooperative)[] = [
    "name", "county", "district", "community", "address", "location",
    "commodities", "membershipTotal", "membershipMale", "membershipFemale",
    "contactName", "contactRole", "contactPhones",
];

function serialiseValue(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.join(", ");
    return String(v);
}

/**
 * Cooperative Registry — read access to the CDA (Cooperative Development
 * Agency) reference list, plus the staff-facing search/filter directory,
 * data-quality flagging, and reviewed-import maintenance workflow.
 *
 * GET /api/cooperatives (plain, unfiltered) stays public/no-auth exactly
 * as before — the mobile app and public /apply wizard's cooperative
 * pickers depend on this exact shape and must keep working unchanged.
 * Every endpoint added for the registry directory/admin tooling lives
 * under its own path and requires authentication.
 */
export class CooperativeController {
    private cooperativeRepository = AppDataSource.getRepository(Cooperative);
    private flagRepository = AppDataSource.getRepository(CooperativeFlag);
    private changeLogRepository = AppDataSource.getRepository(CooperativeChangeLog);
    private importRunRepository = AppDataSource.getRepository(CooperativeImportRun);
    private farmerRepository = AppDataSource.getRepository(Farmer);

    /**
     * UNCHANGED from the original implementation — returns every active
     * cooperative, optionally narrowed by county/commodity, with no
     * authentication required. Depended on by the mobile app's
     * CooperativeRegistryService and the admin panel's public /apply
     * wizard's CooperativeLegalNameField/CooperativeField pickers.
     */
    async getAll(req: Request, res: Response) {
        try {
            const { county, commodity } = req.query;

            const qb = this.cooperativeRepository
                .createQueryBuilder("coop")
                .where("coop.isActive = :active", { active: true });

            if (county && typeof county === "string") {
                qb.andWhere("coop.county ILIKE :county", { county });
            }
            if (commodity && typeof commodity === "string") {
                qb.andWhere("coop.commodities ILIKE :commodity", { commodity: `%${commodity}%` });
            }

            const cooperatives = await qb.orderBy("coop.name", "ASC").getMany();
            return successResponse(res, cooperatives);
        } catch (error: any) {
            console.error("Error fetching cooperatives:", error);
            return errorResponse(res, "Error fetching cooperatives", [error.message], 500);
        }
    }

    /**
     * Authenticated staff directory listing — every cooperative (active
     * and inactive, so nothing is silently hidden from staff), including
     * the derived fields the registry UI needs: membership-reported flag,
     * CMIS-linked farmer count, and open-flag count. Filtering/sorting/
     * pagination beyond this is handled client-side (mirrors
     * CommercialQueue.tsx's "fetch broadly, filter/sort/paginate in the
     * browser" pattern) since the full registry is only ~95 records.
     */
    async getDirectory(req: Request, res: Response) {
        try {
            const requester = (req as any).user;
            const isAuthorisedStaff = requester?.role === "ADMIN";

            const cooperatives = await this.cooperativeRepository.find({ order: { name: "ASC" } });
            const coopIds = cooperatives.map((c) => c.id);

            // One batched query for CMIS-linked farmer counts — matched by
            // cooperativeName (the only link that exists; see Cooperative
            // entity's doc comment on why there is no FK), case-insensitive
            // and trimmed so minor casing differences don't undercount.
            const farmerCounts: Record<string, number> = {};
            if (cooperatives.length > 0) {
                const rows = await this.farmerRepository
                    .createQueryBuilder("farmer")
                    .select("TRIM(UPPER(farmer.cooperativeName))", "name")
                    .addSelect("COUNT(*)", "count")
                    .where("farmer.cooperativeName IS NOT NULL")
                    .andWhere("farmer.cooperativeName != ''")
                    .groupBy("TRIM(UPPER(farmer.cooperativeName))")
                    .getRawMany();
                const byNormalisedName: Record<string, number> = {};
                for (const row of rows) {
                    byNormalisedName[row.name] = parseInt(row.count, 10);
                }
                for (const coop of cooperatives) {
                    const key = coop.name.trim().toUpperCase();
                    farmerCounts[coop.id] = byNormalisedName[key] || 0;
                }
            }

            // Open-flag counts, staff-only (never exposed to non-admin
            // authenticated roles reaching this same endpoint).
            let openFlagCounts: Record<string, number> = {};
            if (isAuthorisedStaff && coopIds.length > 0) {
                const rows = await this.flagRepository
                    .createQueryBuilder("flag")
                    .select("flag.cooperativeId", "cooperativeId")
                    .addSelect("COUNT(*)", "count")
                    .where("flag.cooperativeId IN (:...coopIds)", { coopIds })
                    .andWhere("flag.status = :status", { status: CooperativeFlagStatus.OPEN })
                    .groupBy("flag.cooperativeId")
                    .getRawMany();
                openFlagCounts = Object.fromEntries(rows.map((r) => [r.cooperativeId, parseInt(r.count, 10)]));
            }

            const list = cooperatives.map((c) => ({
                ...c,
                cmisLinkedFarmerCount: farmerCounts[c.id] || 0,
                openFlagCount: isAuthorisedStaff ? (openFlagCounts[c.id] || 0) : 0,
            }));

            return successResponse(res, list);
        } catch (error: any) {
            console.error("Error fetching cooperative directory:", error);
            return errorResponse(res, "Error fetching cooperative directory", [error.message], 500);
        }
    }

    /**
     * UNCHANGED single-record lookup, now additionally used by the
     * registry's details panel (which fetches full detail including
     * flags/history via getDetail below rather than this plain endpoint,
     * kept here only for backward compatibility with any existing caller).
     */
    async getOne(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const cooperative = await this.cooperativeRepository.findOne({ where: { id } });
            if (!cooperative) return errorResponse(res, "Cooperative not found", [], 404);
            return successResponse(res, cooperative);
        } catch (error: any) {
            console.error("Error fetching cooperative:", error);
            return errorResponse(res, "Error fetching cooperative", [error.message], 500);
        }
    }

    /**
     * Authenticated detail view backing the registry's side panel:
     * the cooperative record, its CMIS-linked farmers (lightweight
     * projection — id/name/farmerId/county, not the full Farmer
     * record), its flags (staff-only), and its change history.
     */
    async getDetail(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const requester = (req as any).user;
            const isAuthorisedStaff = requester?.role === "ADMIN";

            const cooperative = await this.cooperativeRepository.findOne({ where: { id } });
            if (!cooperative) return errorResponse(res, "Cooperative not found", [], 404);

            const normalisedName = cooperative.name.trim().toUpperCase();
            const linkedFarmers = await this.farmerRepository
                .createQueryBuilder("farmer")
                .select(["farmer.id", "farmer.farmerId", "farmer.firstName", "farmer.lastName", "farmer.region", "farmer.cooperativeSource"])
                .where("TRIM(UPPER(farmer.cooperativeName)) = :name", { name: normalisedName })
                .getMany();

            const flags = isAuthorisedStaff
                ? await this.flagRepository.find({ where: { cooperativeId: id }, order: { createdAt: "DESC" } })
                : [];

            const changeHistory = await this.changeLogRepository.find({
                where: { cooperativeId: id },
                order: { createdAt: "DESC" },
            });

            return successResponse(res, {
                cooperative,
                linkedFarmers: linkedFarmers.map((f) => ({
                    id: f.id,
                    farmerId: f.farmerId,
                    name: `${f.firstName} ${f.lastName}`.trim(),
                    region: f.region,
                    cooperativeSource: f.cooperativeSource,
                })),
                flags,
                changeHistory,
            });
        } catch (error: any) {
            console.error("Error fetching cooperative detail:", error);
            return errorResponse(res, "Error fetching cooperative detail", [error.message], 500);
        }
    }

    /**
     * ADMIN-only: applies a manual correction to one or more structured
     * fields (see CORRECTABLE_FIELDS). Every changed field is written to
     * CooperativeChangeLog as its own row — an audit trail that preserves
     * the previous value, per the spec's "preserve source values and an
     * audit trail for corrections" requirement. Fields not included in
     * the request body, or whose new value equals the current value, are
     * left untouched and produce no log row.
     */
    async correct(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const requester = (req as any).user;
            const cooperative = await this.cooperativeRepository.findOne({ where: { id } });
            if (!cooperative) return errorResponse(res, "Cooperative not found", [], 404);

            const body = req.body || {};
            const logs: CooperativeChangeLog[] = [];

            for (const field of CORRECTABLE_FIELDS) {
                if (!(field in body)) continue;
                const previous = (cooperative as any)[field];
                const incoming = body[field];
                const previousStr = serialiseValue(previous);
                const incomingStr = serialiseValue(incoming);
                if (previousStr === incomingStr) continue;

                (cooperative as any)[field] = incoming;

                const log = new CooperativeChangeLog();
                log.cooperativeId = cooperative.id;
                log.fieldName = field;
                log.previousValue = previousStr;
                log.newValue = incomingStr;
                log.source = CooperativeChangeSource.MANUAL_CORRECTION;
                log.performedByUserId = requester?.id || null;
                log.performedByName = requester?.name || null;
                log.notes = typeof body.notes === "string" ? body.notes : null;
                logs.push(log);
            }

            if (logs.length === 0) {
                return successResponse(res, { cooperative, changed: 0 }, "No changes to apply");
            }

            await this.cooperativeRepository.save(cooperative);
            await this.changeLogRepository.save(logs);

            return successResponse(res, { cooperative, changed: logs.length }, "Cooperative updated");
        } catch (error: any) {
            console.error("Error correcting cooperative:", error);
            return errorResponse(res, "Error correcting cooperative", [error.message], 500);
        }
    }

    /**
     * ADMIN-only: runs the automated data-quality scan across the whole
     * registry and (re)creates OPEN flags for anything newly detected.
     * Idempotent per (cooperative, type, relatedCooperativeId) — does not
     * duplicate an already-open flag for the same underlying issue, and
     * never touches a flag that has already been reviewed (REVIEWED
     * status is left alone even if the same condition still holds, since
     * a human already made a determination on it).
     *
     * Three checks, matching the spec exactly:
     *  - SUSPECTED_DUPLICATE: name similarity >= threshold against
     *    another active cooperative (same or different county — a
     *    near-identical name across counties is still worth a human
     *    look, e.g. a data-entry county mistake).
     *  - MISSING_INFORMATION: no reported membership figure at all.
     *  - COMMODITY_INCONSISTENCY: no commodities recorded. Deliberately
     *    does NOT try to infer/guess a commodity from the cooperative's
     *    name — an empty commodities list is itself the inconsistency
     *    being flagged for a human to resolve.
     */
    async scan(req: Request, res: Response) {
        try {
            const requester = (req as any).user;
            const cooperatives = await this.cooperativeRepository.find({ where: { isActive: true } });
            const existingOpenFlags = await this.flagRepository.find({ where: { status: CooperativeFlagStatus.OPEN } });

            const alreadyFlagged = (coopId: string, type: CooperativeFlagType, relatedId: string | null) =>
                existingOpenFlags.some((f) => f.cooperativeId === coopId && f.type === type && (f.relatedCooperativeId || null) === relatedId);

            const newFlags: CooperativeFlag[] = [];

            for (let i = 0; i < cooperatives.length; i++) {
                const coop = cooperatives[i];

                // Missing information.
                if (coop.membershipTotal === null || coop.membershipTotal === undefined) {
                    if (!alreadyFlagged(coop.id, CooperativeFlagType.MISSING_INFORMATION, null)) {
                        const flag = new CooperativeFlag();
                        flag.cooperativeId = coop.id;
                        flag.type = CooperativeFlagType.MISSING_INFORMATION;
                        flag.reason = "No reported membership figure is on file for this cooperative.";
                        flag.relatedCooperativeId = null;
                        flag.createdByUserId = requester?.id || null;
                        flag.createdByName = requester?.name || "Automated scan";
                        newFlags.push(flag);
                    }
                }

                // Commodity inconsistency: no commodities recorded at all.
                if (!coop.commodities || coop.commodities.length === 0) {
                    if (!alreadyFlagged(coop.id, CooperativeFlagType.COMMODITY_INCONSISTENCY, null)) {
                        const flag = new CooperativeFlag();
                        flag.cooperativeId = coop.id;
                        flag.type = CooperativeFlagType.COMMODITY_INCONSISTENCY;
                        flag.reason = "No commodity is recorded for this cooperative. Commodities are never inferred from the name — please confirm with CDA records.";
                        flag.relatedCooperativeId = null;
                        flag.createdByUserId = requester?.id || null;
                        flag.createdByName = requester?.name || "Automated scan";
                        newFlags.push(flag);
                    }
                }

                // Suspected duplicates — compare against every other
                // cooperative once (i < j so each pair is only checked
                // one direction, but a flag is raised against both sides
                // so either one's detail panel shows it).
                for (let j = i + 1; j < cooperatives.length; j++) {
                    const other = cooperatives[j];
                    const ratio = similarityRatio(coop.name, other.name);
                    if (ratio >= DUPLICATE_SIMILARITY_THRESHOLD) {
                        const pct = Math.round(ratio * 100);
                        if (!alreadyFlagged(coop.id, CooperativeFlagType.SUSPECTED_DUPLICATE, other.id)) {
                            const flag = new CooperativeFlag();
                            flag.cooperativeId = coop.id;
                            flag.type = CooperativeFlagType.SUSPECTED_DUPLICATE;
                            flag.reason = `Name is ${pct}% similar to "${other.name}" (${other.county || "county not recorded"}). Review both records before taking any action — this is a potential match, not a confirmed duplicate.`;
                            flag.relatedCooperativeId = other.id;
                            flag.createdByUserId = requester?.id || null;
                            flag.createdByName = requester?.name || "Automated scan";
                            newFlags.push(flag);
                        }
                        if (!alreadyFlagged(other.id, CooperativeFlagType.SUSPECTED_DUPLICATE, coop.id)) {
                            const flag2 = new CooperativeFlag();
                            flag2.cooperativeId = other.id;
                            flag2.type = CooperativeFlagType.SUSPECTED_DUPLICATE;
                            flag2.reason = `Name is ${pct}% similar to "${coop.name}" (${coop.county || "county not recorded"}). Review both records before taking any action — this is a potential match, not a confirmed duplicate.`;
                            flag2.relatedCooperativeId = coop.id;
                            flag2.createdByUserId = requester?.id || null;
                            flag2.createdByName = requester?.name || "Automated scan";
                            newFlags.push(flag2);
                        }
                    }
                }
            }

            if (newFlags.length > 0) {
                await this.flagRepository.save(newFlags);
            }

            return successResponse(res, { created: newFlags.length }, `Scan complete — ${newFlags.length} new flag(s) raised`);
        } catch (error: any) {
            console.error("Error running cooperative data-quality scan:", error);
            return errorResponse(res, "Error running data-quality scan", [error.message], 500);
        }
    }

    /**
     * ADMIN-only: manually raise a flag against a cooperative (as
     * opposed to the automated scan above), e.g. a staff member spots an
     * issue while reviewing a record.
     */
    async createFlag(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const requester = (req as any).user;
            const { type, reason, relatedCooperativeId } = req.body || {};

            if (!type || !Object.values(CooperativeFlagType).includes(type)) {
                return errorResponse(res, "A valid flag type is required", [], 400);
            }
            if (!reason || !String(reason).trim()) {
                return errorResponse(res, "A reason is required when raising a flag", [], 400);
            }

            const cooperative = await this.cooperativeRepository.findOne({ where: { id } });
            if (!cooperative) return errorResponse(res, "Cooperative not found", [], 404);

            const flag = new CooperativeFlag();
            flag.cooperativeId = id;
            flag.type = type;
            flag.reason = reason;
            flag.relatedCooperativeId = relatedCooperativeId || null;
            flag.createdByUserId = requester?.id || null;
            flag.createdByName = requester?.name || null;
            await this.flagRepository.save(flag);

            return successResponse(res, flag, "Flag raised");
        } catch (error: any) {
            console.error("Error creating cooperative flag:", error);
            return errorResponse(res, "Error creating flag", [error.message], 500);
        }
    }

    /**
     * ADMIN-only: records a review outcome for an open flag. Never
     * merges or alters the underlying Cooperative record itself — any
     * correction the reviewer decides on is applied separately via
     * correct() above, creating its own audit trail entry.
     */
    async reviewFlag(req: Request, res: Response) {
        try {
            const { flagId } = req.params;
            const requester = (req as any).user;
            const { outcome } = req.body || {};

            if (!outcome || !String(outcome).trim()) {
                return errorResponse(res, "A review outcome is required", [], 400);
            }

            const flag = await this.flagRepository.findOne({ where: { id: flagId } });
            if (!flag) return errorResponse(res, "Flag not found", [], 404);

            flag.status = CooperativeFlagStatus.REVIEWED;
            flag.reviewOutcome = outcome;
            flag.reviewedByUserId = requester?.id || null;
            flag.reviewedByName = requester?.name || null;
            flag.reviewedAt = new Date();
            await this.flagRepository.save(flag);

            return successResponse(res, flag, "Flag reviewed");
        } catch (error: any) {
            console.error("Error reviewing cooperative flag:", error);
            return errorResponse(res, "Error reviewing flag", [error.message], 500);
        }
    }

    /**
     * ADMIN-only: dry-run comparison of the embedded CDA listing against
     * what is currently in the database — classifies every source record
     * as NEW, CHANGED (with the specific field diffs), or UNCHANGED, and
     * separately reports any existing registry record that is NOT present
     * in the source listing at all (so staff can see what an import would
     * NOT touch/remove — nothing is ever deleted by applyImport below).
     * Applies nothing; see applyImport() for the write path.
     */
    async previewImport(req: Request, res: Response) {
        try {
            const existingBySlug = new Map<string, Cooperative>();
            const existing = await this.cooperativeRepository.find();
            for (const c of existing) existingBySlug.set(c.slug, c);

            const preview = CDA_COOPERATIVE_SEED_DATA.map((rec) => this.diffRecord(rec, existingBySlug.get(rec.id)));

            const sourceSlugs = new Set(CDA_COOPERATIVE_SEED_DATA.map((r) => r.id));
            const notInSource = existing
                .filter((c) => !sourceSlugs.has(c.slug))
                .map((c) => ({ id: c.id, slug: c.slug, name: c.name, county: c.county }));

            const summary = {
                newCount: preview.filter((p) => p.status === "NEW").length,
                changedCount: preview.filter((p) => p.status === "CHANGED").length,
                unchangedCount: preview.filter((p) => p.status === "UNCHANGED").length,
                flaggedCount: preview.filter((p) => p.changes && p.changes.some((c) => c.field === "name" || c.field === "county")).length,
            };

            return successResponse(res, { source: IMPORT_SOURCE_LABEL, summary, records: preview, notInSource });
        } catch (error: any) {
            console.error("Error previewing cooperative import:", error);
            return errorResponse(res, "Error previewing import", [error.message], 500);
        }
    }

    private diffRecord(rec: CdaCooperativeSeedRecord, existing: Cooperative | undefined) {
        if (!existing) {
            return { slug: rec.id, name: rec.name, county: rec.county, status: "NEW" as const, changes: [] };
        }
        const fieldMap: [string, unknown, unknown][] = [
            ["name", existing.name, rec.name],
            ["county", existing.county, rec.county],
            ["location", existing.location, rec.location],
            ["commodities", existing.commodities, rec.commodities],
            ["membershipTotal", existing.membershipTotal, rec.membership.total],
            ["membershipMale", existing.membershipMale, rec.membership.male],
            ["membershipFemale", existing.membershipFemale, rec.membership.female],
            ["contactName", existing.contactName, rec.contact.name],
            ["contactRole", existing.contactRole, rec.contact.role],
            ["contactPhones", existing.contactPhones, rec.contact.phones],
        ];
        const changes = fieldMap
            .filter(([, prev, next]) => serialiseValue(prev) !== serialiseValue(next))
            .map(([field, prev, next]) => ({ field, previousValue: serialiseValue(prev), newValue: serialiseValue(next) }));

        return {
            slug: rec.id,
            name: rec.name,
            county: rec.county,
            status: (changes.length > 0 ? "CHANGED" : "UNCHANGED") as "CHANGED" | "UNCHANGED",
            changes,
        };
    }

    /**
     * ADMIN-only: applies the import previewed above. Upserts by `slug`
     * (never by name/id-guessing), so existing cooperative IDs — and
     * therefore every farmer-registration link that snapshots a
     * cooperative's `name` — are preserved exactly as before; a changed
     * `name` on an existing slug updates that same row in place rather
     * than creating a new one. Nothing in the existing registry is ever
     * deleted by this (see previewImport's notInSource: those records
     * are simply left untouched). Every field change is written to
     * CooperativeChangeLog tagged CDA_IMPORT and linked to the
     * CooperativeImportRun row created for this run, and the run itself
     * is recorded (source, date, responsible user, result) per the spec.
     */
    async applyImport(req: Request, res: Response) {
        try {
            const requester = (req as any).user;
            let created = 0;
            let updated = 0;
            let unchanged = 0;
            const changeLogs: CooperativeChangeLog[] = [];
            const details: { slug: string; name: string; status: string; changes: number }[] = [];

            for (const rec of CDA_COOPERATIVE_SEED_DATA) {
                let coop = await this.cooperativeRepository.findOne({ where: { slug: rec.id } });
                const isNew = !coop;
                if (!coop) coop = new Cooperative();

                const fieldMap: [keyof Cooperative, unknown][] = [
                    ["name", rec.name],
                    ["county", rec.county || null],
                    ["location", rec.location || null],
                    ["commodities", rec.commodities],
                    ["membershipTotal", rec.membership.total],
                    ["membershipMale", rec.membership.male],
                    ["membershipFemale", rec.membership.female],
                    ["contactName", rec.contact.name || null],
                    ["contactRole", rec.contact.role || null],
                    ["contactPhones", rec.contact.phones],
                ];

                // Existing rows already have a stable `id` (fetched via
                // findOne above) before this loop runs, so change-log rows
                // can reference coop.id immediately — only brand-new rows
                // lack an id yet, and those are never logged (there is no
                // meaningful "previous value" for a record that didn't
                // exist), so no post-save id patch-up is needed.
                let changedFieldsThisRecord = 0;
                for (const [field, incoming] of fieldMap) {
                    const previousStr = serialiseValue((coop as any)[field]);
                    const incomingStr = serialiseValue(incoming);
                    if (!isNew && previousStr === incomingStr) continue;
                    (coop as any)[field] = incoming;
                    if (!isNew) {
                        const log = new CooperativeChangeLog();
                        log.cooperativeId = coop.id;
                        log.fieldName = field;
                        log.previousValue = previousStr;
                        log.newValue = incomingStr;
                        log.source = CooperativeChangeSource.CDA_IMPORT;
                        log.performedByUserId = requester?.id || null;
                        log.performedByName = requester?.name || null;
                        changeLogs.push(log);
                        changedFieldsThisRecord++;
                    }
                }

                coop.slug = rec.id;
                coop.rawMembership = rec.membership.raw || null as any;
                coop.rawContact = rec.contact.raw || null as any;
                coop.isActive = true;

                await this.cooperativeRepository.save(coop);

                if (isNew) { created++; details.push({ slug: rec.id, name: rec.name, status: "NEW", changes: 0 }); }
                else if (changedFieldsThisRecord > 0) { updated++; details.push({ slug: rec.id, name: rec.name, status: "CHANGED", changes: changedFieldsThisRecord }); }
                else { unchanged++; details.push({ slug: rec.id, name: rec.name, status: "UNCHANGED", changes: 0 }); }
            }

            const importRun = new CooperativeImportRun();
            importRun.source = IMPORT_SOURCE_LABEL;
            importRun.performedByUserId = requester?.id || null;
            importRun.performedByName = requester?.name || null;
            importRun.newCount = created;
            importRun.changedCount = updated;
            importRun.unchangedCount = unchanged;
            importRun.flaggedCount = 0;
            importRun.detailsJson = JSON.stringify(details);
            await this.importRunRepository.save(importRun);

            if (changeLogs.length > 0) {
                for (const log of changeLogs) log.importRunId = importRun.id;
                await this.changeLogRepository.save(changeLogs);
            }

            const total = await this.cooperativeRepository.count();
            return successResponse(res, { importRunId: importRun.id, created, updated, unchanged, total }, "Import applied");
        } catch (error: any) {
            console.error("Error applying cooperative import:", error);
            return errorResponse(res, "Error applying import", [error.message], 500);
        }
    }

    /** ADMIN-only: history of past import runs, most recent first. */
    async getImportRuns(req: Request, res: Response) {
        try {
            const runs = await this.importRunRepository.find({ order: { createdAt: "DESC" }, take: 50 });
            return successResponse(res, runs);
        } catch (error: any) {
            console.error("Error fetching import run history:", error);
            return errorResponse(res, "Error fetching import run history", [error.message], 500);
        }
    }

    /**
     * ADMIN-only: (re-)seeds the Cooperative table from the embedded CDA
     * registry data. Kept for backward compatibility (the original
     * endpoint predating the import preview/apply workflow above) — now
     * a thin wrapper that simply calls applyImport's logic so there is
     * only one real write path, but the old URL keeps working for any
     * existing bookmarked/scripted callers.
     * @deprecated prefer POST /api/cooperatives/import/apply
     */
    async seed(req: Request, res: Response) {
        return this.applyImport(req, res);
    }
}
