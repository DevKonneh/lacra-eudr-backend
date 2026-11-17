# 2033 — Security Hardening

## What this migration does

1. Adds `"tokenVersion" integer NOT NULL DEFAULT 0` to `"user"`.
   Embedded in every JWT issued at login; `authMiddleware` compares the
   token's claim against the live DB value on every request. Bumping this
   column instantly invalidates every previously-issued token for that
   account. Backs three features:
   - Suspension/status-change enforcement (task #1)
   - Admin-triggered session revocation (task #5)
   - Password reset/change invalidating existing sessions (task #5)

2. Adds two new values to `user_audit_log_action_enum`:
   - `SESSIONS_REVOKED` — written whenever a user's sessions are
     invalidated (admin-triggered revoke, status change, password
     reset/change).
   - `PERMISSION_GROUP_CHANGED` — written whenever a user's `assignedRole`
     ("Permission Group") is set/changed/cleared. Previously
     `UserController.update()` changed this silently with no audit trail
     at all.

## Column-by-column rationale

- `tokenVersion`: plain integer, defaulted to `0` so every existing row is
  immediately valid — no backfill pass needed. Every account's very first
  JWT after this migration ships will carry `tokenVersion: 0`, matching the
  column's default, so no one is logged out by this migration alone.

## Dependencies

None. Does not depend on any other pending migration.

## Safety

- No existing column, enum value, row, or table is altered, retyped, or
  dropped. Purely additive.
- Idempotent: every statement is guarded (`IF NOT EXISTS` / `DO $$` checks),
  safe to re-run after a partial failure.
- See `down.sql` for the rollback procedure and its documented limitation
  (Postgres cannot `DROP VALUE` from an enum type).

## Applied to

- [x] Local dev (`eudr_db`)
- [x] Staging (`eudr_db_agency_staging`) — applied during this work session
- [ ] Production — **NOT applied, per explicit instruction not to deploy
      to production yet**
