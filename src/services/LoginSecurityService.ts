/**
 * LoginSecurityService.ts — Account-level lockout after repeated failed
 * login attempts, on top of (not instead of) the IP-based `loginLimiter`
 * in rateLimit.middleware.ts.
 *
 * WHY A SEPARATE, ACCOUNT-KEYED CHECK IS NEEDED: the IP rate limiter alone
 * is insufficient for credential-stuffing/brute-force protection against a
 * SPECIFIC known account, because:
 *   - An attacker distributing attempts across many IPs (botnet, proxy
 *     rotation) never trips a per-IP limit no matter how many guesses they
 *     make against one victim's email.
 *   - A legitimate shared-IP scenario (an office/agency behind one NAT
 *     address) could otherwise lock out every OTHER user's login attempts
 *     just because one person mistyped their own password repeatedly, if
 *     the limiter were the only protection.
 * Keying the lockout off the already-existing `SignInAttempt` rows (one
 * per login attempt, see AuthController.login()) lets us block further
 * attempts against ONE account specifically, regardless of source IP,
 * without needing any new table.
 *
 * POLICY (tunable via env vars so Render admins can adjust without a code
 * change, same convention as rateLimit.middleware.ts):
 *   LOGIN_LOCKOUT_THRESHOLD        (default: 5)  — failed attempts
 *   LOGIN_LOCKOUT_WINDOW_MINUTES   (default: 15) — lookback window
 *   LOGIN_LOCKOUT_DURATION_MINUTES (default: 15) — how long the account
 *                                                   stays locked once the
 *                                                   threshold is hit
 *
 * Mechanism: if there are >= THRESHOLD FAILED SignInAttempt rows for this
 * userId within the last WINDOW minutes, the account is locked for
 * DURATION minutes measured from the MOST RECENT failed attempt — so the
 * lock extends if the attacker keeps trying, and naturally expires once
 * attempts stop. A BLOCKED outcome (status change) or a SUCCESS resets the
 * count implicitly, since this only ever counts FAILED rows within the
 * rolling window.
 */

import { AppDataSource } from "../data-source";
import { SignInAttempt, SignInOutcome } from "../entities/SignInAttempt";
import { MoreThanOrEqual } from "typeorm";

const LOCKOUT_THRESHOLD = Number(process.env.LOGIN_LOCKOUT_THRESHOLD ?? 5);
const LOCKOUT_WINDOW_MINUTES = Number(process.env.LOGIN_LOCKOUT_WINDOW_MINUTES ?? 15);
const LOCKOUT_DURATION_MINUTES = Number(process.env.LOGIN_LOCKOUT_DURATION_MINUTES ?? 15);

export interface LockoutStatus {
    locked: boolean;
    retryAfterSeconds?: number;
}

export class LoginSecurityService {
    private signInAttemptRepository = AppDataSource.getRepository(SignInAttempt);

    /**
     * Checks whether `userId` is currently locked out due to repeated
     * recent failed login attempts. Never throws — a failure to check
     * lockout status should not itself block a legitimate login (fails
     * open, matching the existing best-effort SignInAttempt logging
     * philosophy elsewhere in AuthController), but IS logged loudly since
     * silently failing open on a security control is worth noticing.
     */
    async checkLockout(userId: string): Promise<LockoutStatus> {
        try {
            const windowStart = new Date(Date.now() - LOCKOUT_WINDOW_MINUTES * 60_000);
            const recentFailures = await this.signInAttemptRepository.find({
                where: {
                    userId,
                    outcome: SignInOutcome.FAILED,
                    createdAt: MoreThanOrEqual(windowStart),
                },
                order: { createdAt: "DESC" },
                take: LOCKOUT_THRESHOLD,
            });

            if (recentFailures.length < LOCKOUT_THRESHOLD) {
                return { locked: false };
            }

            // The threshold-th most recent failure (oldest of the ones we
            // fetched, since we took the DESC-most-recent LOCKOUT_THRESHOLD
            // rows) is the one whose timestamp anchors the lockout window —
            // the account stays locked for LOCKOUT_DURATION_MINUTES after
            // the MOST RECENT failure, not the oldest, so continued
            // attempts extend the lock.
            const mostRecentFailureAt = recentFailures[0].createdAt;
            const unlockAt = new Date(mostRecentFailureAt.getTime() + LOCKOUT_DURATION_MINUTES * 60_000);
            const now = new Date();

            if (now < unlockAt) {
                return {
                    locked: true,
                    retryAfterSeconds: Math.ceil((unlockAt.getTime() - now.getTime()) / 1000),
                };
            }
            return { locked: false };
        } catch (error) {
            console.error("LoginSecurityService.checkLockout failed (failing open)", error);
            return { locked: false };
        }
    }
}
