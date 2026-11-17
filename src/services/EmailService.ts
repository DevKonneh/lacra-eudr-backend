import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// CMIS sends under its own domain (lacracmis.com), not the government's
// lacra.gov.lr — the project owner controls lacracmis.com directly, while
// lacra.gov.lr DNS changes go through the government and take a long time
// (see RENDER.md). The sender identity is fully configurable via env vars
// (SMTP_FROM_NAME / SMTP_FROM_EMAIL) rather than hardcoded, so it can be
// changed (or pointed at a different domain/sub-brand later) without a
// code deploy. Defaults below match the current lacracmis.com setup, but
// are only a fallback — Render's real environment variables always win.
const DEFAULT_FROM_NAME = "LACRA CMIS Support";
const DEFAULT_FROM_EMAIL = "no-reply@lacracmis.com";

export class EmailService {
    private transporter: nodemailer.Transporter;

    constructor() {
        // Initialize transporter. 
        // In production, use environment variables.
        // For development/demo, we can log to console if credentials missing, 
        // but here we try to set up a robust structure.
        const port = Number(process.env.SMTP_PORT) || 587;
        this.transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port,
            // Port 465 requires implicit TLS from the first byte (`secure:
            // true`); every other port (587, 25) uses STARTTLS instead,
            // which nodemailer negotiates automatically when `secure` is
            // false. Hardcoding `secure: false` regardless of port broke
            // port 465 for the lacracmis.com mail server, which (like most
            // cPanel/Exim hosts) answers plaintext on 465 and expects the
            // client to open a TLS socket immediately rather than issue
            // STARTTLS after EHLO.
            secure: port === 465,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        });
    }

    /**
     * Builds the "From" header from env vars, falling back to the
     * lacracmis.com defaults above when unset. Centralised here (rather
     * than inlined at each sendMail call site) so every outbound email
     * this service ever sends uses the same, single configurable sender
     * identity.
     */
    private getFromHeader(): string {
        const name = process.env.SMTP_FROM_NAME || DEFAULT_FROM_NAME;
        const email = process.env.SMTP_FROM_EMAIL || DEFAULT_FROM_EMAIL;
        return `"${name}" <${email}>`;
    }

    /**
     * Returns true only if real SMTP credentials are actually configured in
     * this environment. Used by AuthController.forgotPassword() to know
     * (server-side, never exposed to the caller) whether a verification
     * code was genuinely emailed or merely logged to the console — and by
     * AdminMaintenanceController's integration-health endpoint, which
     * already reports this same boolean for operational visibility.
     */
    isConfigured(): boolean {
        return !!process.env.SMTP_HOST;
    }

    /**
     * Sends the password-reset verification code email.
     *
     * Returns a structured result instead of a bare boolean so callers can
     * distinguish "no SMTP configured, code was only logged" from "SMTP is
     * configured and the send genuinely succeeded" from "SMTP is
     * configured but the send failed" — this distinction matters for task
     * #6 ("verify password-reset delivery end to end"): previously this
     * method returned `true` even when SMTP was unconfigured and nothing
     * was actually emailed, which could mask a real production
     * misconfiguration (the caller had no way to tell the difference).
     */
    async sendVerificationEmail(to: string, code: string): Promise<{ delivered: boolean; mocked: boolean }> {
        if (!this.isConfigured()) {
            console.log(`[EmailService] SMTP not configured (SMTP_HOST unset). Mocking send to ${to}. Code: ${code}`);
            return { delivered: false, mocked: true };
        }

        try {
            const info = await this.transporter.sendMail({
                from: this.getFromHeader(),
                to: to,
                subject: "Password Reset Verification Code",
                text: `Your verification code is: ${code}. It expires in 15 minutes.`,
                html: `<b>Your verification code is: ${code}</b><br>It expires in 15 minutes.`,
            });

            console.log("Message sent: %s", info.messageId);
            return { delivered: true, mocked: false };
        } catch (error) {
            console.error("Error sending email", error);
            console.log(`[EmailService] FAILED to send. Mocking send to ${to}. Code: ${code}`);
            return { delivered: false, mocked: false };
        }
    }
}
