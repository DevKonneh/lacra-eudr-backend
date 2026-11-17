import "reflect-metadata";

/**
 * passwordLeak.controller.test.ts
 *
 * Closes the loop between "the deepSanitizeUsers() utility works in
 * isolation" (see utils/__tests__/sanitizeUser.test.ts) and "the utility
 * is actually correctly wired into every controller response path that
 * was found to leak a User's password hash during the Nov 2026
 * security-hardening pass".
 *
 * Each test below mocks AppDataSource.getRepository so the relevant
 * controller method runs against an in-memory fixture (no real DB), with
 * the fixture's User-shaped relation deliberately including `password`,
 * `verificationCode`, and `verificationCodeExpires` — exactly the shape
 * TypeORM would return for a real embedded User row. The assertion in
 * every case is on the ACTUAL payload passed to res.json(), i.e. what a
 * real API caller would receive, not on the utility function directly.
 */

jest.mock("../../data-source", () => ({
    AppDataSource: {
        getRepository: jest.fn(),
    },
}));

import { AppDataSource } from "../../data-source";
import { BusinessController } from "../BusinessController";
import { LicenseController } from "../LicenseController";
import { PermitController } from "../PermitController";
import { BatchController } from "../BatchController";
import { EnforcementController } from "../EnforcementController";
import { InspectionController } from "../InspectionController";
import { QualityController } from "../QualityController";

function mockRes() {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
}

// A User-shaped fixture, matching what TypeORM would actually return for
// an embedded relation — includes every field deepSanitizeUsers() must
// strip, plus ordinary fields that must be PRESERVED (id, email, name)
// so these tests also guard against over-stripping.
function userFixture(overrides: Record<string, any> = {}) {
    return {
        id: "user-1",
        email: "owner@example.com",
        name: "Jane Owner",
        role: "EXPORTER",
        password: "$2b$10$fakeBcryptHashValueForTestingOnly000000000000000000",
        verificationCode: "deadbeefdeadbeefdeadbeefdeadbeef",
        verificationCodeExpires: new Date("2026-01-01T00:00:00Z"),
        ...overrides,
    };
}

function jsonPayload(res: any) {
    expect(res.json).toHaveBeenCalledTimes(1);
    return res.json.mock.calls[0][0];
}

function expectNoSensitiveFields(obj: any) {
    expect(obj).not.toHaveProperty("password");
    expect(obj).not.toHaveProperty("verificationCode");
    expect(obj).not.toHaveProperty("verificationCodeExpires");
}

describe("Password-hash leak fixes — real controller response payloads", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("BusinessController.getAll() excludes owner.password/verificationCode* from the response", async () => {
        const mockFind = jest.fn().mockResolvedValue([
            { id: "biz-1", name: "Acme Exports", owner: userFixture() },
        ]);
        (AppDataSource.getRepository as jest.Mock).mockReturnValue({ find: mockFind });

        const controller = new BusinessController();
        const res = mockRes();
        await controller.getAll({} as any, res);

        const payload = jsonPayload(res);
        const owner = payload.data[0].owner;
        expectNoSensitiveFields(owner);
        // Non-sensitive fields must survive the sanitization pass.
        expect(owner.email).toBe("owner@example.com");
        expect(owner.name).toBe("Jane Owner");
        expect(payload.data[0].name).toBe("Acme Exports");
    });

    it("LicenseController.getAll() excludes user.password/verificationCode* from the response", async () => {
        const mockFind = jest.fn().mockResolvedValue([
            {
                id: "lic-1",
                licenseNumber: "LIC-2026-0001",
                user: userFixture({ id: "user-2", email: "holder@example.com" }),
                business: { id: "biz-1", name: "Acme Exports" },
            },
        ]);
        (AppDataSource.getRepository as jest.Mock).mockReturnValue({ find: mockFind, count: jest.fn() });

        const controller = new LicenseController();
        const res = mockRes();
        await controller.getAll({} as any, res);

        const payload = jsonPayload(res);
        const user = payload.data[0].user;
        expectNoSensitiveFields(user);
        expect(user.email).toBe("holder@example.com");
        expect(payload.data[0].licenseNumber).toBe("LIC-2026-0001");
    });

    it("PermitController.getOne() excludes business.owner.password/verificationCode* from the response", async () => {
        const mockFindOne = jest.fn().mockResolvedValue({
            id: "permit-1",
            permitNumber: "PMT-2026-0001",
            business: {
                id: "biz-1",
                name: "Acme Local Buyer",
                owner: userFixture({ id: "user-3", email: "applicant@example.com" }),
            },
        });
        (AppDataSource.getRepository as jest.Mock).mockReturnValue({ findOne: mockFindOne });

        const controller = new PermitController();
        const res = mockRes();
        await controller.getOne({ params: { id: "permit-1" } } as any, res);

        const payload = jsonPayload(res);
        const owner = payload.data.business.owner;
        expectNoSensitiveFields(owner);
        expect(owner.email).toBe("applicant@example.com");
        expect(payload.data.permitNumber).toBe("PMT-2026-0001");
    });

    it("BatchController.getTrace() excludes createdBy.user.password/verificationCode* from the response", async () => {
        const mockFindOne = jest.fn().mockResolvedValue({
            id: "batch-1",
            batchNumber: "BATCH-2026-0001",
            farmers: [],
            createdBy: {
                id: "lic-1",
                licenseNumber: "LIC-2026-0001",
                user: userFixture({ id: "user-4", email: "licenseholder@example.com" }),
            },
        });
        (AppDataSource.getRepository as jest.Mock).mockReturnValue({ findOne: mockFindOne });

        const controller = new BatchController();
        const res = mockRes();
        await controller.getTrace({ params: { id: "batch-1" } } as any, res);

        const payload = jsonPayload(res);
        const user = payload.data.createdBy.user;
        expectNoSensitiveFields(user);
        expect(user.email).toBe("licenseholder@example.com");
        expect(payload.data.batchNumber).toBe("BATCH-2026-0001");
    });

    it("EnforcementController.getAll() excludes officer.password/verificationCode* from the response", async () => {
        const mockFind = jest.fn().mockResolvedValue([
            {
                id: "enf-1",
                actionType: "WARNING",
                officer: userFixture({ id: "user-5", email: "officer@example.com", role: "DG" }),
            },
        ]);
        (AppDataSource.getRepository as jest.Mock).mockReturnValue({ find: mockFind });

        const controller = new EnforcementController();
        const res = mockRes();
        await controller.getAll({} as any, res);

        const payload = jsonPayload(res);
        const officer = payload.data[0].officer;
        expectNoSensitiveFields(officer);
        expect(officer.email).toBe("officer@example.com");
    });

    it("InspectionController.getAll() excludes inspector.password/verificationCode* from the response", async () => {
        const mockFind = jest.fn().mockResolvedValue([
            {
                id: "insp-1",
                status: "COMPLETED",
                inspector: userFixture({ id: "user-6", email: "inspector@example.com", role: "INSPECTOR" }),
            },
        ]);
        (AppDataSource.getRepository as jest.Mock).mockReturnValue({ find: mockFind });

        const controller = new InspectionController();
        const res = mockRes();
        await controller.getAll({} as any, res);

        const payload = jsonPayload(res);
        const inspector = payload.data[0].inspector;
        expectNoSensitiveFields(inspector);
        expect(inspector.email).toBe("inspector@example.com");
    });

    it("QualityController.getAll() excludes inspector.password/verificationCode* from the response", async () => {
        const mockFind = jest.fn().mockResolvedValue([
            {
                id: "qc-1",
                result: "PASS",
                inspector: userFixture({ id: "user-7", email: "qcinspector@example.com", role: "INSPECTOR" }),
            },
        ]);
        (AppDataSource.getRepository as jest.Mock).mockReturnValue({ find: mockFind });

        const controller = new QualityController();
        const res = mockRes();
        await controller.getAll({} as any, res);

        const payload = jsonPayload(res);
        const inspector = payload.data[0].inspector;
        expectNoSensitiveFields(inspector);
        expect(inspector.email).toBe("qcinspector@example.com");
    });
});
