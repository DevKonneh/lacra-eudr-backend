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

    async sendVerificationEmail(to: string, code: string): Promise<boolean> {
        try {
            if (!process.env.SMTP_HOST) {
                console.log(`[EmailService] SMTP not configured. Mocking send to ${to}. Code: ${code}`);
                return true;
            }

            const info = await this.transporter.sendMail({
                from: '"LACRA Support" <no-reply@lacra.gov>',
                to: to,
                subject: "Password Reset Verification Code",
                text: `Your verification code is: ${code}. It expires in 15 minutes.`,
                html: `<b>Your verification code is: ${code}</b><br>It expires in 15 minutes.`,
            });

            console.log("Message sent: %s", info.messageId);
            return true;
        } catch (error) {
            console.error("Error sending email", error);
            // Fallback for demo if SMTP fails
            console.log(`[EmailService] FAILED to send. Mocking send to ${to}. Code: ${code}`);
            return false;
        }
    }
}
