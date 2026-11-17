import "reflect-metadata";

// LoginSecurityService.checkLockout() queries AppDataSource.getRepository
// at class-construction time (same pattern as every other *Service/
// *Controller in this codebase), so we mock the repository's `find()`
// method via AppDataSource.getRepository, same approach as this codebase's
// existing GeometryValidationService tests use for its DB-backed overlap
// check. No real database connection is needed.
jest.mock("../../data-source", () => ({
    AppDataSource: {
        getRepository: jest.fn(),
    },
}));

import { AppDataSource } from "../../data-source";
import { LoginSecurityService } from "../LoginSecurityService";
import { SignInOutcome } from "../../entities/SignInAttempt";

describe("LoginSecurityService", () => {
    const mockFind = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        (AppDataSource.getRepository as jest.Mock).mockReturnValue({ find: mockFind });
    });

    it("does not lock out an account with fewer failures than the threshold", async () => {
        mockFind.mockResolvedValue([
            { createdAt: new Date() },
            { createdAt: new Date() },
        ]); // 2 failures, default threshold is 5
        const service = new LoginSecurityService();

        const result = await service.checkLockout("user-1");

        expect(result.locked).toBe(false);
    });

    it("locks out an account once the threshold of recent failures is reached", async () => {
        const now = new Date();
        mockFind.mockResolvedValue([
            { createdAt: now },
            { createdAt: now },
            { createdAt: now },
            { createdAt: now },
            { createdAt: now },
        ]); // exactly 5 failures (default threshold)
        const service = new LoginSecurityService();

        const result = await service.checkLockout("user-1");

        expect(result.locked).toBe(true);
        expect(result.retryAfterSeconds).toBeGreaterThan(0);
    });

    it("unlocks once the lockout duration has elapsed since the most recent failure", async () => {
        const longAgo = new Date(Date.now() - 20 * 60_000); // 20 minutes ago, past the default 15-min lockout duration
        mockFind.mockResolvedValue([
            { createdAt: longAgo },
            { createdAt: longAgo },
            { createdAt: longAgo },
            { createdAt: longAgo },
            { createdAt: longAgo },
        ]);
        const service = new LoginSecurityService();

        const result = await service.checkLockout("user-1");

        expect(result.locked).toBe(false);
    });

    it("fails OPEN (does not lock out) if the DB query throws", async () => {
        mockFind.mockRejectedValue(new Error("DB connection lost"));
        const service = new LoginSecurityService();
        const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

        const result = await service.checkLockout("user-1");

        expect(result.locked).toBe(false);
        consoleSpy.mockRestore();
    });

    it("queries only FAILED outcomes (not SUCCESS/BLOCKED) for the given userId", async () => {
        mockFind.mockResolvedValue([]);
        const service = new LoginSecurityService();

        await service.checkLockout("user-42");

        expect(mockFind).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    userId: "user-42",
                    outcome: SignInOutcome.FAILED,
                }),
            })
        );
    });
});
