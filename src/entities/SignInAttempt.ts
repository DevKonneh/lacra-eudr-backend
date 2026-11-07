import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

export enum SignInOutcome {
    SUCCESS = "SUCCESS",
    FAILED = "FAILED",     // Wrong password, or email not found
    BLOCKED = "BLOCKED",   // Account found + correct credentials path never
                            // reached because the account itself cannot sign
                            // in right now (PENDING/SUSPENDED/REJECTED status)
}

/**
 * Immutable record of every sign-in ATTEMPT (not just successes) against
 * /api/auth/login, for the Monitoring feature's "User Activity -> sign-in
 * history" requirement. Deliberately a dedicated table rather than reusing
 * UserAuditLog's LOGIN action, because:
 *   1. A failed/blocked attempt often has NO known userId (wrong email
 *      entirely) — UserAuditLog.userId is NOT NULL (FK to the target
 *      user), which a genuinely-unknown-email attempt cannot satisfy.
 *   2. Sign-in history must be excludable from the general "Activity
 *      History" shown on the ordinary User Management edit screen (per
 *      the explicit instruction to keep detailed login/location history
 *      out of general user views) — a separate table makes that
 *      separation trivial without special-casing one action value out of
 *      a shared feed everywhere it's queried.
 *
 * PRIVACY: per the explicit instruction, this table must never store
 * passwords (obviously), auth tokens, raw IP addresses, or the raw email
 * address typed for an attempt against an UNKNOWN account (a typo/
 * enumeration attempt should not leave a permanent record of whatever
 * string a stranger typed). For an attempt that DOES resolve to a real
 * account (success, wrong password, or blocked-status), `userId` links to
 * that account instead of storing the email text again.
 */
@Entity()
@Index(["userId", "createdAt"])
export class SignInAttempt {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    // Null when the attempted email did not match any account at all (per
    // the privacy note above, the raw email string for that case is
    // intentionally NOT stored anywhere on this row).
    @Column({ type: "uuid", nullable: true })
    userId!: string | null;

    @Column({ type: "simple-enum", enum: SignInOutcome })
    outcome!: SignInOutcome;

    // Short, human-readable reason - e.g. "Incorrect password",
    // "Account is SUSPENDED", "No account found for this email". Never
    // includes the password or any other secret.
    @Column({ type: "varchar", nullable: true })
    reason!: string | null;

    // Best-effort client platform label (e.g. "Web", "Android", "iOS"),
    // derived server-side from a client-declared header/body field (see
    // AuthController.login()) - NOT the raw User-Agent string, which can
    // be long/identifying and is unnecessary for this feature's display
    // requirement of just showing "platform where available".
    @Column({ type: "varchar", nullable: true })
    platform!: string | null;

    @CreateDateColumn()
    createdAt!: Date;
}
