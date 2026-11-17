import { requirePermission } from "../permission.middleware";
import { PERMISSIONS, WILDCARD_PERMISSION } from "../../config/permissions";
import { AuthRequest } from "../auth.middleware";
import { Response } from "express";

function mockRes(): Response {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res as Response;
}

function mockReq(permissions: string[]): AuthRequest {
    return { user: { permissions } } as AuthRequest;
}

describe("requirePermission middleware", () => {
    it("calls next() when the required permission is present", () => {
        const req = mockReq([PERMISSIONS.FARMER_VIEW]);
        const res = mockRes();
        const next = jest.fn();

        requirePermission(PERMISSIONS.FARMER_VIEW)(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
    });

    it("calls next() when the actor holds the wildcard", () => {
        const req = mockReq([WILDCARD_PERMISSION]);
        const res = mockRes();
        const next = jest.fn();

        requirePermission(PERMISSIONS.USER_DELETE)(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
    });

    it("returns 403 with no body access when the required permission is missing", () => {
        const req = mockReq([PERMISSIONS.FARMER_VIEW]);
        const res = mockRes();
        const next = jest.fn();

        requirePermission(PERMISSIONS.FARMER_DELETE)(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ success: false, requiredPermissions: [PERMISSIONS.FARMER_DELETE] })
        );
    });

    it("returns 403 when req.user is missing entirely (e.g. middleware mis-ordering)", () => {
        const req = { } as AuthRequest;
        const res = mockRes();
        const next = jest.fn();

        requirePermission(PERMISSIONS.FARMER_VIEW)(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
    });

    describe("AND semantics (default)", () => {
        it("requires every listed permission to be present", () => {
            const req = mockReq([PERMISSIONS.LICENSE_VIEW]);
            const res = mockRes();
            const next = jest.fn();

            requirePermission([PERMISSIONS.LICENSE_VIEW, PERMISSIONS.LICENSE_APPROVE])(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
        });
    });

    describe("OR semantics ({ any: true })", () => {
        it("passes when at least one of the listed permissions is present", () => {
            const req = mockReq([PERMISSIONS.LICENSE_APPROVE]);
            const res = mockRes();
            const next = jest.fn();

            requirePermission([PERMISSIONS.LICENSE_VIEW, PERMISSIONS.LICENSE_APPROVE], { any: true })(req, res, next);

            expect(next).toHaveBeenCalledTimes(1);
        });

        it("still rejects when none of the listed permissions are present", () => {
            const req = mockReq([PERMISSIONS.FARM_VIEW]);
            const res = mockRes();
            const next = jest.fn();

            requirePermission([PERMISSIONS.LICENSE_VIEW, PERMISSIONS.LICENSE_APPROVE], { any: true })(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
        });
    });
});
