/**
 * In-memory TypeORM repository stand-ins for the assessment-queue tests.
 *
 * WHY THIS EXISTS
 * ---------------
 * The queue's guarantees are mostly about what it writes and does NOT write:
 * one row per (plot, polygon), a NEW row when the polygon changes, the old
 * verdict flagged rather than deleted, and so on. Asserting those against a
 * mocked `save()` that records nothing proves only that the code compiles.
 *
 * This harness is a tiny table engine: rows live in an array, `save()` upserts
 * and HONOURS unique keys (throwing the same `duplicate key` error Postgres
 * raises), and `find`/`findOne` understand the TypeORM FindOperators that the
 * queue actually passes (`In`, `Not`, `LessThanOrEqual`, `IsNull`). That means
 * the tests drive the real decision paths — including the INSERT race that the
 * UNIQUE index is there to survive — without needing a live database.
 *
 * This file deliberately does NOT end in `.test.ts`, so Jest's testMatch will
 * not try to run it as a suite.
 */

type Row = Record<string, any>;

export interface TableOptions {
    /** Column names that carry a UNIQUE index in the real schema. */
    uniqueKeys?: string[];
    /** Prefix for generated surrogate ids, e.g. 'job' -> job-1, job-2 ... */
    idPrefix?: string;
}

export interface Table extends Record<string, any> {
    rows: Row[];
}

/**
 * Evaluates one column of a TypeORM `where` clause against a row value.
 *
 * TypeORM wraps operators as FindOperator instances carrying `_type`/`_value`.
 * Plain values are compared by identity, which is what TypeORM's own
 * `equal` shorthand degrades to.
 */
function matchValue(actual: any, expected: any): boolean {
    if (expected && typeof expected === "object" && typeof expected._type === "string") {
        switch (expected._type) {
            // ── SQL three-valued logic ──────────────────────────────────────
            // In Postgres, `col <> 'x'` and `col <= now()` are both NULL (i.e.
            // NOT matched) when `col` is NULL. Modelling that matters here:
            // `supersedeOpenJobsForPlot` filters with `geometryHash: Not(hash)`,
            // and a naive `null !== hash` would flag boundary_review rows that
            // production would leave alone — a test passing for the wrong
            // reason is worse than no test.
            case "in":
                return actual !== null && actual !== undefined
                    && (expected._value as any[]).includes(actual);
            case "not":
                return actual !== null && actual !== undefined && actual !== expected._value;
            case "equal":
                return actual === expected._value;
            case "isNull":
                return actual === null || actual === undefined;
            case "lessThanOrEqual":
                if (actual === null || actual === undefined) return false;
                return new Date(actual).getTime() <= new Date(expected._value).getTime();
            case "moreThanOrEqual":
                if (actual === null || actual === undefined) return false;
                return new Date(actual).getTime() >= new Date(expected._value).getTime();
            default:
                // Unknown operator: fail closed rather than silently matching
                // everything, so a test can never pass for the wrong reason.
                throw new Error(`inMemoryRepos: unsupported FindOperator "${expected._type}"`);
        }
    }
    return actual === expected;
}

function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, expected]) => matchValue(row[key], expected));
}

function applyOrder<T extends Row>(rows: T[], order?: Record<string, "ASC" | "DESC">): T[] {
    if (!order) return rows;
    const [key, dir] = Object.entries(order)[0] ?? [];
    if (!key) return rows;
    const sorted = [...rows].sort((a, b) => {
        const av = a[key] instanceof Date ? a[key].getTime() : a[key];
        const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
        if (av === bv) return 0;
        const cmp = av > bv ? 1 : -1;
        return dir === "DESC" ? -cmp : cmp;
    });
    return sorted;
}

export function createTable(opts: TableOptions = {}): Table {
    const { uniqueKeys = [], idPrefix = "row" } = opts;
    const rows: Row[] = [];
    let counter = 0;

    const table: Table = {
        rows,

        create: jest.fn((partial: Row) => {
            counter += 1;
            return {
                ...partial,
                id: partial.id ?? `${idPrefix}-${counter}`,
                // Monotonic createdAt so ordering assertions are deterministic
                // even when several rows are created inside the same millisecond.
                createdAt: partial.createdAt ?? new Date(1_700_000_000_000 + counter),
                updatedAt: partial.updatedAt ?? new Date(1_700_000_000_000 + counter),
            };
        }),

        save: jest.fn(async (row: Row) => {
            if (!row.id) {
                counter += 1;
                row.id = `${idPrefix}-${counter}`;
            }
            for (const key of uniqueKeys) {
                if (row[key] === null || row[key] === undefined) continue;
                const clash = rows.find(
                    (r) => r.id !== row.id && r[key] === row[key],
                );
                if (clash) {
                    // Same shape as the driver error the service catches on.
                    const err: any = new Error(
                        `duplicate key value violates unique constraint "${key}"`,
                    );
                    err.code = "23505";
                    throw err;
                }
            }
            const existing = rows.find((r) => r.id === row.id);
            // Mutate in place so any caller holding the same object reference
            // observes the update, exactly like TypeORM's identity-mapped entity.
            if (existing) Object.assign(existing, row);
            else rows.push(row);
            return row;
        }),

        findOne: jest.fn(async (args: any = {}) => {
            const where = args.where ?? {};
            return rows.find((r) => matches(r, where)) ?? null;
        }),

        find: jest.fn(async (args: any = {}) => {
            const where = args.where ?? {};
            let out = rows.filter((r) => matches(r, where));
            out = applyOrder(out, args.order);
            if (typeof args.take === "number") out = out.slice(0, args.take);
            return out;
        }),

        count: jest.fn(async (args: any = {}) => {
            const where = args?.where ?? {};
            return rows.filter((r) => matches(r, where)).length;
        }),

        delete: jest.fn(async (args: any = {}) => {
            const where = args?.where ?? {};
            for (let i = rows.length - 1; i >= 0; i--) {
                if (matches(rows[i], where)) rows.splice(i, 1);
            }
            return { affected: 0 };
        }),

        createQueryBuilder: jest.fn(() => {
            throw new Error("inMemoryRepos: the assessment queue must not use a query builder");
        }),
    };

    return table;
}

export interface RepoBundle {
    farm: Table;
    plot: Table;
    job: Table;
    assessment: Table;
    /**
     * Catch-all for entities the code under test touches incidentally (restore
     * of `FarmDocument`, `Forest`, ...). Never asserted on; exists so a service
     * constructor can complete without a live connection.
     */
    other: Table;
}

/** Fresh, isolated tables. One bundle per test file / per `beforeEach`. */
export function createTables(): RepoBundle {
    return {
        farm: createTable({ idPrefix: "farm" }),
        plot: createTable({ idPrefix: "plot" }),
        // The UNIQUE index that makes deduplication a database guarantee.
        job: createTable({ idPrefix: "job", uniqueKeys: ["dedupeKey"] }),
        assessment: createTable({ idPrefix: "ra" }),
        other: createTable({ idPrefix: "other" }),
    };
}

export function clearTables(tables: RepoBundle): void {
    for (const t of Object.values(tables)) t.rows.length = 0;
}

/**
 * Maps an entity class to its table by class name, mirroring the switch the
 * real `AppDataSource.getRepository()` performs.
 */
export function repoFor(tables: RepoBundle, entity: any): Table {
    switch (entity?.name) {
        case "Farm": return tables.farm;
        case "Plot": return tables.plot;
        case "AssessmentJob": return tables.job;
        case "RiskAssessment": return tables.assessment;
        // Anything else resolves to an inert empty table rather than throwing:
        // services construct their repositories eagerly, so a hard failure here
        // would abort before the code under test ever ran.
        default: return tables.other;
    }
}

/**
 * A STABLE repository handle whose methods resolve the current table on every
 * call.
 *
 * WHY A FACADE IS NECESSARY
 * -------------------------
 * Services such as `GeometryValidationService` and the queue's own singleton
 * grab their repositories at CONSTRUCTION time, and that construction happens
 * while modules are being imported — before any `beforeEach` has run. If the
 * mock handed out a reference to the table object of the moment, every service
 * would stay bound to the first (empty) bundle and each test would silently
 * share state with the previous one, or with nothing at all.
 *
 * Routing through `global.__queueTables` on each call means a fresh bundle per
 * test is picked up by already-constructed singletons, which is what makes the
 * suite isolated without resorting to `resetModules()` tricks.
 */
export function createFacade(entityName?: string): Table {
    const keyOf = (): keyof RepoBundle => {
        switch (entityName) {
            case "Farm": return "farm";
            case "Plot": return "plot";
            case "AssessmentJob": return "job";
            case "RiskAssessment": return "assessment";
            default: return "other";
        }
    };
    const delegate = (method: string, args: any[]) => {
        const bundle = (global as any).__queueTables as RepoBundle | undefined;
        if (!bundle) {
            throw new Error(
                "inMemoryRepos: global.__queueTables is not set — seed it before the code under test runs",
            );
        }
        const table = bundle[keyOf()] as any;
        return table[method](...args);
    };

    return {
        get rows() {
            const bundle = (global as any).__queueTables as RepoBundle | undefined;
            return bundle ? (bundle[keyOf()] as any).rows : [];
        },
        create: (...a: any[]) => delegate("create", a),
        save: (...a: any[]) => delegate("save", a),
        findOne: (...a: any[]) => delegate("findOne", a),
        find: (...a: any[]) => delegate("find", a),
        count: (...a: any[]) => delegate("count", a),
        delete: (...a: any[]) => delegate("delete", a),
        createQueryBuilder: (...a: any[]) => delegate("createQueryBuilder", a),
    } as unknown as Table;
}

/**
 * The `getRepository()` implementation the data-source mock should use.
 * Facades are cached per entity name so repeated lookups are reference-stable,
 * exactly like TypeORM's repository cache.
 */
export function makeGetRepository(): (entity: any) => Table {
    const cache = new Map<string, Table>();
    return (entity: any) => {
        const name = entity?.name ?? "other";
        if (!cache.has(name)) cache.set(name, createFacade(name));
        return cache.get(name)!;
    };
}
