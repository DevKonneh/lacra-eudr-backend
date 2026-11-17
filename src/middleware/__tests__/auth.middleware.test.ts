import "reflect-metadata";

// authMiddleware queries AppDataSource.getRepository(User) on every
// request for the live status/tokenVersion check - mocked here the same
// way as LoginSecurityService.test.ts, so this suite needs no real
// database connection.
jest.mock("../../data-source", () => ({
    AppDataSource: {
        getRepository: jest.fn(),
    },
}));

import jwt from "jsonwebtoken";
import { Response } from "express";
import { AppDataSource } from "../../data-source";
import { authMiddleware, AuthRequest, JWT_SECRET } from "../auth.middleware";
import { UserRole, UserStatus } from "../../entities/User";

function mockRes(): Response {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res as Response;
}

function tokenFor(payload: object) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: "24h" });
}

describe("authMiddleware — live DB-backed status/tokenVersion enforcement", () => {
    const mockFindOne = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        (AppDataSource.getRepository as jest.Mock).mockReturnValue({ findOne: mockFindOne });
    });

    it("rejects a request with no token at all", async () => {
        const req = { headers: {} } as AuthRequest;
        const res = mockRes();
        const next = jest.fn();

        await authMiddleware()(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
        // Must never reach the DB for a request with no token at all.
        expect(mockFindOne).not.toHaveBeenCalled();
    });

    it("rejects an invalid/garbage token before ever touching the DB", async () => {
        const req = { headers: { authorization: "Bearer not-a-real-jwt" } } as AuthRequest;
        const res = mockRes();
        const next = jest.fn();

        await authMiddleware()(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(mockFindOne).not.toHaveBeenCalled();
    });

    it("rejects when the account no longer exists in the database", async () => {
        const token = tokenFor({ id: "ghost-user", email: "x@x.com", role: UserRole.ADMIN, tokenVersion: 0 });
        mockFindOne.mockResolvedValue(null);
        const req = { headers: { authorization: `Bearer ${token}` } } as AuthRequest;
        const res = mockRes();
        const next = jest.fn();

        await authMiddleware()(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it("CORE FIX — rejects a request from a token issued before the account was SUSPENDED, even though the token itself has not expired", async () => {
        // Token was issued while the account was still ACTIVE (tokenVersion 0
        // at the time), but the account has since been suspended in the DB.
        const token = tokenFor({ id: "user-1", email: "a@a.com", role: UserRole.INSPECTOR, tokenVersion: 0 });
        mockFindOne.mockResolvedValue({
            id: "user-1",
            email: "a@a.com",
            role: UserRole.INSPECTOR,
            status: UserStatus.SUSPENDED, // changed AFTER the token was issued
            tokenVersion: 0, // unchanged in this scenario - status alone blocks it
            name: "A",
            assignedRole: null,
        });
        const req = { headers: { authorization: `Bearer ${token}` } } as AuthRequest;
        const res = mockRes();
        const next = jest.fn();

        await authMiddleware()(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining("SUSPENDED") })
        );
    });

    it("rejects a PENDING account's token the same way as SUSPENDED", async () => {
        const token = tokenFor({ id: "user-2", email: "b@b.com", role: UserRole.FARMER, tokenVersion: 0 });
        mockFindOne.mockResolvedValue({
            id: "user-2", email: "b@b.com", role: UserRole.FARMER,
            status: UserStatus.PENDING, tokenVersion: 0, name: "B", assignedRole: null,
        });
        const req = { headers: { authorization: `Bearer ${token}` } } as AuthRequest;
        const res = mockRes();
        const next = jest.fn();

        await authMiddleware()(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
    });

    it("CORE FIX — rejects a token whose tokenVersion no longer matches the live DB value (revoked session / forced logout)", async () => {
        // Token was issued at tokenVersion 0; the account's tokenVersion has
        // since been bumped to 1 (admin revoked sessions, or a password
        // reset/change happened) - this specific token must now be rejected
        // even though the account itself is perfectly ACTIVE.
        const token = tokenFor({ id: "user-3", email: "c@c.com", role: UserRole.ADMIN, tokenVersion: 0 });
        mockFindOne.mockResolvedValue({
            id: "user-3", email: "c@c.com", role: UserRole.ADMIN,
            status: UserStatus.ACTIVE, tokenVersion: 1, name: "C", assignedRole: null,
        });
        const req = { headers: { authorization: `Bearer ${token}` } } as AuthRequest;
        const res = mockRes();
        const next = jest.fn();

        await authMiddleware()(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining("revoked") })
        );
    });

    it("treats a token with no tokenVersion claim at all as tokenVersion 0 (backward compatibility with pre-2033 tokens)", async () => {
        const token = tokenFor({ id: "user-4", email: "d@d.com", role: UserRole.ADMIN }); // no tokenVersion claim
        mockFindOne.mockResolvedValue({
            id: "user-4", email: "d@d.com", role: UserRole.ADMIN,
            status: UserStatus.ACTIVE, tokenVersion: 0, name: "D", assignedRole: null,
        });
        const req = { headers: { authorization: `Bearer ${token}` } } as AuthRequest;
        const res = mockRes();
        const next = jest.fn();

        await authMiddleware()(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
    });

    it("allows a valid, ACTIVE, matching-tokenVersion request through and attaches resolved permissions", async () => {
        const token = tokenFor({ id: "user-5", email: "e@e.com", role: UserRole.ADMIN, tokenVersion: 0 });
        mockFindOne.mockResolvedValue({
            id: "user-5", email: "e@e.com", role: UserRole.ADMIN,
            status: UserStatus.ACTIVE, tokenVersion: 0, name: "E", assignedRole: null,
        });
        const req = { headers: { authorization: `Bearer ${token}` } } as AuthRequest;
        const res = mockRes();
        const next = jest.fn();

        await authMiddleware()(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.user).toBeDefined();
        expect(req.user.permissions).toEqual(["all"]); // ADMIN always gets the wildcard
    });

    it("enforces the coarse `roles` allow-list AFTER the live DB checks pass", async () => {
        const token = tokenFor({ id: "user-6", email: "f@f.com", role: UserRole.INSPECTOR, tokenVersion: 0 });
        mockFindOne.mockResolvedValue({
            id: "user-6", email: "f@f.com", role: UserRole.INSPECTOR,
            status: UserStatus.ACTIVE, tokenVersion: 0, name: "F", assignedRole: null,
        });
        const req = { headers: { authorization: `Bearer ${token}` } } as AuthRequest;
        const res = mockRes();
        const next = jest.fn();

        await authMiddleware([UserRole.ADMIN])(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
    });
});
