// Covers task #6 ("verify password-reset delivery end to end") at the unit
// level: EmailService.sendVerificationEmail() must correctly distinguish
// three outcomes — (1) SMTP not configured at all (SMTP_HOST unset) →
// mocked/no real send attempted, (2) SMTP configured and the send genuinely
// succeeds, (3) SMTP configured but nodemailer throws (bad credentials,
// network failure, etc.) → delivered:false, mocked:false. AuthController's
// forgotPassword() branches its logging on exactly this {delivered, mocked}
// shape, so this is the contract that must hold for that visibility to be
// trustworthy.
//
// This cannot and does not prove that a *real* SMTP server is configured on
// the live staging/production Render service — that can only be confirmed
// by inspecting the actual deployed environment variables (e.g. via the
// `/api/admin-maintenance/integration-health` endpoint against a running
// deployment, or the Render dashboard directly), neither of which is
// accessible from this sandbox. What this test DOES prove is that the
// delivery-status logic itself is correct, so that whichever of the three
// states is true in production, the system will report it accurately
// instead of silently claiming success.

const sendMailMock = jest.fn();

jest.mock("nodemailer", () => ({
    createTransport: jest.fn(() => ({
        sendMail: sendMailMock,
    })),
}));

describe("EmailService.sendVerificationEmail", () => {
    const ORIGINAL_ENV = process.env;

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        process.env = { ...ORIGINAL_ENV };
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    it("reports {delivered:false, mocked:true} and does not call nodemailer when SMTP_HOST is unset", async () => {
        delete process.env.SMTP_HOST;
        const { EmailService } = require("../EmailService");
        const service = new EmailService();

        expect(service.isConfigured()).toBe(false);

        const result = await service.sendVerificationEmail("user@example.com", "123456");

        expect(result).toEqual({ delivered: false, mocked: true });
        expect(sendMailMock).not.toHaveBeenCalled();
    });

    it("reports {delivered:true, mocked:false} when SMTP_HOST is set and sendMail succeeds", async () => {
        process.env.SMTP_HOST = "smtp.example.com";
        process.env.SMTP_USER = "user";
        process.env.SMTP_PASS = "pass";
        sendMailMock.mockResolvedValueOnce({ messageId: "abc-123" });

        const { EmailService } = require("../EmailService");
        const service = new EmailService();

        expect(service.isConfigured()).toBe(true);

        const result = await service.sendVerificationEmail("user@example.com", "123456");

        expect(result).toEqual({ delivered: true, mocked: false });
        expect(sendMailMock).toHaveBeenCalledTimes(1);
        expect(sendMailMock.mock.calls[0][0]).toMatchObject({
            to: "user@example.com",
            subject: expect.stringContaining("Verification"),
        });
    });

    it("reports {delivered:false, mocked:false} when SMTP_HOST is set but sendMail throws", async () => {
        process.env.SMTP_HOST = "smtp.example.com";
        process.env.SMTP_USER = "user";
        process.env.SMTP_PASS = "pass";
        sendMailMock.mockRejectedValueOnce(new Error("Connection refused"));

        const { EmailService } = require("../EmailService");
        const service = new EmailService();

        const result = await service.sendVerificationEmail("user@example.com", "123456");

        expect(result).toEqual({ delivered: false, mocked: false });
        expect(sendMailMock).toHaveBeenCalledTimes(1);
    });

    it("isConfigured() reflects SMTP_HOST presence independent of other SMTP_* vars", () => {
        delete process.env.SMTP_HOST;
        let { EmailService } = require("../EmailService");
        expect(new EmailService().isConfigured()).toBe(false);

        jest.resetModules();
        process.env.SMTP_HOST = "smtp.sendgrid.net";
        ({ EmailService } = require("../EmailService"));
        expect(new EmailService().isConfigured()).toBe(true);
    });
});
