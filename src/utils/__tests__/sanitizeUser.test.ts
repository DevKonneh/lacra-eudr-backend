import { sanitizeUser, deepSanitizeUsers } from "../sanitizeUser";

function fakeUser(overrides: Partial<Record<string, any>> = {}) {
    return {
        id: "u1",
        email: "test@lacra.gov.lr",
        password: "$2b$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01",
        verificationCode: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        verificationCodeExpires: new Date("2026-01-01T00:00:00Z"),
        role: "BUYER",
        name: "Test User",
        status: "ACTIVE",
        ...overrides,
    };
}

describe("sanitizeUser", () => {
    it("strips password, verificationCode, and verificationCodeExpires", () => {
        const result = sanitizeUser(fakeUser());
        expect(result).not.toHaveProperty("password");
        expect(result).not.toHaveProperty("verificationCode");
        expect(result).not.toHaveProperty("verificationCodeExpires");
    });

    it("preserves every other field unchanged", () => {
        const result = sanitizeUser(fakeUser());
        expect(result.id).toBe("u1");
        expect(result.email).toBe("test@lacra.gov.lr");
        expect(result.role).toBe("BUYER");
        expect(result.name).toBe("Test User");
        expect(result.status).toBe("ACTIVE");
    });

    it("does not mutate the original object", () => {
        const user = fakeUser();
        const result = sanitizeUser(user);
        expect(user).toHaveProperty("password");
        expect(result).not.toBe(user);
    });

    it("returns null/undefined unchanged", () => {
        expect(sanitizeUser(null)).toBeNull();
        expect(sanitizeUser(undefined)).toBeUndefined();
    });

    it("returns a non-object value unchanged (defensive)", () => {
        expect(sanitizeUser("not-an-object" as any)).toBe("not-an-object");
    });
});

describe("deepSanitizeUsers", () => {
    it("strips the password off a User embedded as a direct relation (e.g. Business.owner)", () => {
        const business = {
            id: "b1",
            name: "Acme Exports",
            owner: fakeUser(),
        };
        const result = deepSanitizeUsers(business);
        expect(result.owner).not.toHaveProperty("password");
        expect(result.owner).not.toHaveProperty("verificationCode");
        expect(result.owner.email).toBe("test@lacra.gov.lr");
        // Original untouched
        expect(business.owner).toHaveProperty("password");
    });

    it("strips the password off a User nested two levels deep (e.g. Batch.createdBy.user, License.user)", () => {
        const batch = {
            id: "batch1",
            createdBy: {
                id: "lic1",
                licenseNumber: "LIC-0001",
                user: fakeUser({ email: "license-holder@lacra.gov.lr" }),
            },
        };
        const result: any = deepSanitizeUsers(batch);
        expect(result.createdBy.user).not.toHaveProperty("password");
        expect(result.createdBy.user.email).toBe("license-holder@lacra.gov.lr");
    });

    it("strips the password off a User embedded under a non-'user'/'owner' key (e.g. EnforcementAction.officer, Inspection/QualityControl.inspector)", () => {
        const enforcementAction = {
            id: "ea1",
            officer: fakeUser({ email: "officer@lacra.gov.lr" }),
        };
        const inspection = {
            id: "insp1",
            inspector: fakeUser({ email: "inspector@lacra.gov.lr" }),
        };
        const resultEa: any = deepSanitizeUsers(enforcementAction);
        const resultInsp: any = deepSanitizeUsers(inspection);
        expect(resultEa.officer).not.toHaveProperty("password");
        expect(resultInsp.inspector).not.toHaveProperty("password");
    });

    it("sanitizes every item in an array of User-containing entities", () => {
        const licenses = [
            { id: "l1", user: fakeUser({ email: "a@lacra.gov.lr" }) },
            { id: "l2", user: fakeUser({ email: "b@lacra.gov.lr" }) },
        ];
        const result: any = deepSanitizeUsers(licenses);
        expect(result).toHaveLength(2);
        expect(result[0].user).not.toHaveProperty("password");
        expect(result[1].user).not.toHaveProperty("password");
        expect(result[0].user.email).toBe("a@lacra.gov.lr");
        expect(result[1].user.email).toBe("b@lacra.gov.lr");
    });

    it("sanitizes a bare array of User records directly (e.g. GET /api/users-style payloads)", () => {
        const users = [fakeUser({ email: "a@x.com" }), fakeUser({ email: "b@x.com" })];
        const result: any = deepSanitizeUsers(users);
        expect(result[0]).not.toHaveProperty("password");
        expect(result[1]).not.toHaveProperty("password");
    });

    it("leaves entities with no embedded User untouched (no spurious stripping)", () => {
        const farm = { id: "f1", name: "North Farm", totalAreaHa: 12.5 };
        const result = deepSanitizeUsers(farm);
        expect(result).toEqual(farm);
    });

    it("does not strip fields from an object that merely has a 'password'-named field but is not User-shaped (no 'email')", () => {
        // Guards against over-eager stripping of an unrelated field that
        // happens to be named "password" on some other entity, by
        // requiring BOTH an email string AND a password string before
        // treating an object as a User record.
        const notAUser = { id: "x1", password: "not-actually-a-user-hash" };
        const result: any = deepSanitizeUsers(notAUser);
        expect(result.password).toBe("not-actually-a-user-hash");
    });

    it("handles null, undefined, and primitive values without throwing", () => {
        expect(deepSanitizeUsers(null)).toBeNull();
        expect(deepSanitizeUsers(undefined)).toBeUndefined();
        expect(deepSanitizeUsers(42)).toBe(42);
        expect(deepSanitizeUsers("hello")).toBe("hello");
        expect(deepSanitizeUsers(true)).toBe(true);
    });

    it("passes Date instances through unchanged (does not recurse into / mangle Date internals)", () => {
        const date = new Date("2026-06-15T10:00:00Z");
        const entity = { id: "e1", createdAt: date };
        const result = deepSanitizeUsers(entity);
        expect(result.createdAt).toBe(date);
        expect(result.createdAt instanceof Date).toBe(true);
    });

    it("does not mutate the original nested structure", () => {
        const business = { id: "b1", owner: fakeUser() };
        deepSanitizeUsers(business);
        expect(business.owner).toHaveProperty("password");
    });

    it("tolerates a circular reference without infinite-looping or throwing", () => {
        const a: any = { id: "a1", owner: fakeUser() };
        a.self = a; // circular reference
        expect(() => deepSanitizeUsers(a)).not.toThrow();
        const result = deepSanitizeUsers(a);
        expect(result.owner).not.toHaveProperty("password");
    });
});
