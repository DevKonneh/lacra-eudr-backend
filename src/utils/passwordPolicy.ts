/**
 * passwordPolicy.ts — Single source of truth for password strength rules,
 * applied consistently across every path that sets or changes a password:
 *   - AuthController.register()
 *   - AuthController.changePassword()  (in-app, requires current password)
 *   - AuthController.resetPassword()   (forgot-password email-code flow)
 *   - UserController.create()          (admin creates a staff account)
 *   - UserController.update()          (admin resets a user's password)
 *
 * Previously only changePassword() had any check at all, and it was just
 * `length < 6` — register(), resetPassword(), UserController.create() and
 * UserController.update() accepted literally any string, including an
 * empty one, as a password. This file replaces all of those ad-hoc/missing
 * checks with one shared, testable function.
 *
 * POLICY (deliberately readable/memorable over "maximum entropy" — this is
 * a government staff system, not a bank, and overly strict rules just push
 * users toward "Password1!" pattern reuse):
 *   - At least 8 characters
 *   - At least one uppercase letter
 *   - At least one lowercase letter
 *   - At least one digit
 *   - At least one special character (non-alphanumeric)
 *   - Must not be one of a short list of common/trivial passwords
 */

const MIN_LENGTH = 8;

// Small, deliberately short deny-list of the most common trivially-guessed
// passwords. This is NOT a substitute for the composition rules above — it
// exists only to block the handful of values that technically satisfy
// every composition rule above but are still worthless
// (e.g. "Password1!").
const COMMON_PASSWORDS = new Set(
    [
        "password", "password1", "password1!", "password123", "password123!",
        "12345678", "123456789", "qwerty123", "qwerty1234", "admin1234",
        "letmein123", "welcome123", "changeme123", "iloveyou1",
    ].map((p) => p.toLowerCase())
);

export interface PasswordValidationResult {
    valid: boolean;
    errors: string[];
}

/**
 * Validates a candidate password against the shared policy. Returns ALL
 * violated rules at once (not just the first) so the caller/UI can show a
 * complete checklist in one response instead of a frustrating
 * one-error-at-a-time loop.
 */
export function validatePassword(password: unknown): PasswordValidationResult {
    const errors: string[] = [];

    if (typeof password !== "string" || password.length === 0) {
        return { valid: false, errors: ["Password is required."] };
    }

    if (password.length < MIN_LENGTH) {
        errors.push(`Password must be at least ${MIN_LENGTH} characters long.`);
    }
    if (!/[A-Z]/.test(password)) {
        errors.push("Password must contain at least one uppercase letter.");
    }
    if (!/[a-z]/.test(password)) {
        errors.push("Password must contain at least one lowercase letter.");
    }
    if (!/[0-9]/.test(password)) {
        errors.push("Password must contain at least one number.");
    }
    if (!/[^A-Za-z0-9]/.test(password)) {
        errors.push("Password must contain at least one special character (e.g. ! @ # $ % ^ & *).");
    }
    if (COMMON_PASSWORDS.has(password.toLowerCase())) {
        errors.push("This password is too common. Please choose a less predictable password.");
    }

    return { valid: errors.length === 0, errors };
}

/** Convenience helper: throws-free boolean check, for call sites that only
 * need a yes/no answer (e.g. a pre-check before doing other work). */
export function isPasswordValid(password: unknown): boolean {
    return validatePassword(password).valid;
}
