// Regression test for a real production bug: AuthController.forgotPassword()
// previously called EmailService.sendVerificationEmail() and discarded its
// return value entirely, so the API always responded "Verification code
// sent." even when the underlying SMTP send genuinely failed (e.g. the
// port-465 TLS misconfiguration fixed alongside this test — see
// EmailService.ts). That masked the failure from both the caller and from
// anyone monitoring the API, and from the end user's perspective: the app
// showed a generic success message while no email ever arrived. This test
// asserts the controller now actually checks EmailService's result and
// surfaces a real error when the send fails, while still responding with
// the existing generic/enumeration-safe messages for the already-handled
// "unknown email" and "SMTP not configured" cases.

import { Request, Response } from "express";

const sendVerificationEmailMock = jest.fn();

jest.mock("../../services/EmailService", () => ({
    EmailService: jest.fn().mockImplementation(() => ({
        sendVerificationEmail: sendVerificationEmailMock,
        isConfigured: () => true,
    })),
}));

const findOneByMock = jest.fn();
const saveMock = jest.fn();

jest.mock("../../data-source", () => ({
    AppDataSource: {
        getRepository: jest.fn(() => ({
            findOneBy: findOneByMock,
            save: saveMock,
        })),
    },
}));

function buildRes() {
    const res: Partial<Response> = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res as Response;
}

describe("AuthController.forgotPassword", () => {
    let AuthController: any;

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        ({ AuthController } = require("../AuthController"));
    });

    it("returns a 502 error (not a false success) when the email genuinely fails to send", async () => {
        findOneByMock.mockResolvedValueOnce({ id: "u1", email: "user@example.com" });
        saveMock.mockResolvedValueOnce(undefined);
        sendVerificationEmailMock.mockResolvedValueOnce({ delivered: false, mocked: false });

        const controller = new AuthController();
        const req = { body: { email: "user@example.com" } } as Request;
        const res = buildRes();

        await controller.forgotPassword(req, res);

        expect(res.status).toHaveBeenCalledWith(502);
        const payload = (res.json as jest.Mock).mock.calls[0][0];
        expect(payload.status).toBe(false);
        expect(payload.message).not.toMatch(/sent/i);
    });

    it("returns success when the email is genuinely delivered", async () => {
        findOneByMock.mockResolvedValueOnce({ id: "u1", email: "user@example.com" });
        saveMock.mockResolvedValueOnce(undefined);
        sendVerificationEmailMock.mockResolvedValueOnce({ delivered: true, mocked: false });

        const controller = new AuthController();
        const req = { body: { email: "user@example.com" } } as Request;
        const res = buildRes();

        await controller.forgotPassword(req, res);

        expect(res.status).not.toHaveBeenCalledWith(502);
        const payload = (res.json as jest.Mock).mock.calls[0][0];
        expect(payload.status).toBe(true);
        expect(payload.message).toMatch(/sent/i);
    });

    it("still returns a generic success when SMTP is unconfigured (mocked), to avoid masking this as an enumeration signal", async () => {
        findOneByMock.mockResolvedValueOnce({ id: "u1", email: "user@example.com" });
        saveMock.mockResolvedValueOnce(undefined);
        sendVerificationEmailMock.mockResolvedValueOnce({ delivered: false, mocked: true });

        const controller = new AuthController();
        const req = { body: { email: "user@example.com" } } as Request;
        const res = buildRes();

        await controller.forgotPassword(req, res);

        expect(res.status).not.toHaveBeenCalledWith(502);
        const payload = (res.json as jest.Mock).mock.calls[0][0];
        expect(payload.status).toBe(true);
    });

    it("returns the existing generic success for an unknown email without calling EmailService", async () => {
        findOneByMock.mockResolvedValueOnce(null);

        const controller = new AuthController();
        const req = { body: { email: "nobody@example.com" } } as Request;
        const res = buildRes();

        await controller.forgotPassword(req, res);

        expect(sendVerificationEmailMock).not.toHaveBeenCalled();
        const payload = (res.json as jest.Mock).mock.calls[0][0];
        expect(payload.status).toBe(true);
    });
});
