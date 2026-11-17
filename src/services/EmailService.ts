import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

export class EmailService {
    private transporter: nodemailer.Transporter;

    constructor() {
        // Initialize transporter. 
        // In production, use environment variables.
        // For development/demo, we can log to console if credentials missing, 
        // but here we try to set up a robust structure.
        this.transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT) || 587,
            secure: false, // true for 465, false for other ports
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        });
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
                from: '"LACRA Support" <no-reply@lacra.gov>',
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
