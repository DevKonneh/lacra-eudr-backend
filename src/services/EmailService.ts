import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// Fallback sender identity used only when SMTP_FROM_NAME / SMTP_FROM_EMAIL
// are not set in the environment. CMIS sends under its own domain,
// lacracmis.com (not lacra.gov.lr, which the government controls and
// where DNS/config changes take a long time to land) — see RENDER.md's
// "Email / SMTP" section for the full setup (SPF/DKIM/DMARC records,
// confirmed working ports, etc).
const DEFAULT_FROM_NAME = "LACRA CMIS Support";
const DEFAULT_FROM_EMAIL = "no-reply@lacracmis.com";

// How long to wait for the SMTP connection/greeting and for the overall
// send before giving up. Without an explicit timeout, nodemailer/the
// underlying socket can hang far longer than any caller's HTTP request is
// willing to wait (observed: ~32s against mail.lacracmis.com on a cold
// connection), which both makes forgotPassword() feel broken to the end
// user (the mobile app's own client-side timeout fires first, showing
// "Can't reach the server" even though the request eventually succeeds
// server-side) and ties up a request-handling connection far longer than
// necessary. 15s is generous for a normal SMTP handshake while still
// failing fast enough to return a real error to the caller instead of
// stalling the whole request.
const SMTP_TIMEOUT_MS = 15000;

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
            // Port 465 is implicit TLS (the socket must be encrypted from the
            // very first byte); 587/25 use STARTTLS, negotiated in plaintext
            // after EHLO. Hardcoding `secure: false` silently breaks port 465
            // (the client never establishes TLS, so the server either drops
            // the connection or the handshake stalls until the client gives
            // up) while happening to still work on 587 — which is exactly
            // the bug that caused CMIS's lacracmis.com mail (configured on
            // 465) to never actually send despite the API reporting success.
            secure: port === 465,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
            connectionTimeout: SMTP_TIMEOUT_MS,
            greetingTimeout: SMTP_TIMEOUT_MS,
            socketTimeout: SMTP_TIMEOUT_MS,
        });
    }

    /**
     * Returns true only if real SMTP credentials are actually configured in
     * this environment. Used by AuthController.forgotPassword() to know
     * (server-side, never exposed to the caller) whether a verification
     * code was genuinely emailed or merely logged to the console.
     */
    isConfigured(): boolean {
        return !!process.env.SMTP_HOST;
    }

    /**
     * Builds the "From" header. Reads SMTP_FROM_NAME / SMTP_FROM_EMAIL from
     * the environment so the sender identity can be changed from Render's
     * dashboard without a code deploy, falling back to CMIS's
     * lacracmis.com identity if either is unset.
     */
    private getFromHeader(): string {
        const name = process.env.SMTP_FROM_NAME || DEFAULT_FROM_NAME;
        const email = process.env.SMTP_FROM_EMAIL || DEFAULT_FROM_EMAIL;
        return `"${name}" <${email}>`;
    }

    /**
     * Sends the password-reset verification code email.
     *
     * Returns a structured result instead of a bare boolean so callers can
     * distinguish "no SMTP configured, code was only logged" from "SMTP is
     * configured and the send genuinely succeeded" from "SMTP is
     * configured but the send failed" — this distinction matters so a
     * caller like AuthController.forgotPassword() can report a real error
     * back to the user instead of claiming success when nothing was
     * actually emailed (previously this method returned `true`
     * unconditionally on the mocked path and the caller never even checked
     * the return value, masking real SMTP failures as success).
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
