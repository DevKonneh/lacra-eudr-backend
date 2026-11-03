# Identity Verification — Live Deployment Plan

This is the concrete, step-by-step runbook for taking this feature live on
Render, written after local staging/browser testing passed (28/28 smoke
checks) and all 8 `IDENTITY_REVERIFICATION_FIELDS` were individually
confirmed to trigger the re-review safeguard. It assumes `README.md` in
this same folder as background (migration rationale, testing methodology,
rollback) — this document is the ordered checklist to actually execute it.

**Do not skip steps or reorder them.** Each step exists because skipping
it was specifically flagged as a risk during development (see commit
messages on `b229a24`, `6b83a22`, `aa2e159`).

---

## 0. Pre-flight — confirm what you're deploying

Code to ship, in this exact order of dependency:

| Commit | What it is |
|---|---|
| `b229a24` | Explicit migration files (`up.sql`/`down.sql`/`README.md`) — **schema change** |
| `6b83a22` | Fix: verification endpoint crashed the admin panel to a blank page (missing `farms` relation on response) |
| `aa2e159` | Fix: empty-string `email` collided with the unique constraint, 500'ing any farmer profile save |
| Admin panel `200dad6` | Frontend: Identity Verification queue page, ADMIN+INSPECTOR nav/route access |

Confirm your local `HEAD` matches what you intend to deploy:
```bash
cd gh-backend-clone && git log --oneline -5
# Expect aa2e159 at HEAD, b229a24/6b83a22 beneath it
```

Confirm nothing else slipped in unintentionally:
```bash
git status --short   # should be empty
```

---

## 1. Take a database backup

**Not optional. Do this even though the migration is additive and was
validated on a full schema clone.**

- **Render managed Postgres** (if that's what's in use): Render Dashboard
  → your Postgres instance → **Backups** tab → trigger a manual backup.
  Wait for it to complete and note its timestamp/ID before proceeding.
- **Portable alternative** (works for any Postgres, including if you want
  a local copy in addition to Render's):
  ```bash
  pg_dump "$DATABASE_URL" -F c -f lacra_pre_identity_verification_$(date +%Y%m%d_%H%M%S).dump
  ```
  Store this somewhere outside the Render instance itself (local machine,
  S3, etc.) so it survives even if the Render service/DB is affected.

**Do not proceed to Step 2 until you have confirmed the backup exists and
is restorable in principle** (you don't need to test-restore it right
now, but know where it is and that it completed without error).

---

## 2. Run the migration against production

From a machine with `psql` and network access to the production DB
(e.g. Render Shell, or your own machine with the production
`DATABASE_URL`):

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2026_identity_verification/up.sql
```

Expected output: a sequence of `ALTER TABLE` / `DO` block statements,
ending in `COMMIT`, no errors. If anything errors, the `BEGIN`/`COMMIT`
wrapper around the column additions means that part rolls back cleanly —
**stop and investigate before retrying**, don't re-run blindly.

If the backend has NOT yet been deployed with the new code at this point
(recommended order — migrate first, then deploy code), `synchronize: true`
has not had a chance to auto-apply these same changes yet, so this is a
clean first application.

---

## 3. Verify the schema (before deploying code)

```bash
npx ts-node src/verifyIdentityVerificationSchema.ts
```
(Run this against production — set `DATABASE_URL` / your production env
vars for this invocation, or run it via Render Shell where the env is
already production.)

Expected: `=== VERIFICATION PASSED ===`. This only confirms structure
(columns + enum values exist with the right shape) — it is not a
substitute for the functional checks in Step 6.

**If this fails, stop. Do not deploy the application code.** Investigate
the schema diff before proceeding — do not attempt to "fix forward" by
deploying code that assumes columns exist which don't.

---

## 4. Deploy the latest backend code

Deploy `aa2e159` (which includes `b229a24` and `6b83a22` beneath it) to
Render, however deploys are normally triggered for this service (e.g.
push to the branch Render watches, or **Manual Deploy** → **Deploy latest
commit** in the Render dashboard).

Watch the deploy logs for the startup sequence:
```
✅  LACRA startup — all env vars accounted for.
Database connected successfully.
Server is running on port 8100
```

Any `❌ REQUIRED` line means a critical env var is missing — fix it and
redeploy before continuing. Do not proceed past a failed/incomplete
startup.

---

## 5. Deploy the latest frontend (admin panel)

Deploy the admin panel build containing `200dad6` (Identity Verification
queue page + ADMIN/INSPECTOR nav + route access) to wherever it's hosted
(e.g. `npm run build` → static host, or your existing CI/CD pipeline for
this repo).

Confirm the live site loads and that you can log in before moving to the
post-deployment checks below.

---

## 6. Post-deployment checks (run in this order)

These mirror the local smoke test that passed 28/28 and the 8-field
re-review confirmation, but against the **real production environment**
with **real production data** — this is the step that actually confirms
the feature works live, not just that the schema is correct.

### 6a. Schema re-check (belt-and-suspenders)
Re-run Step 3's verification script once more now that the app has
connected post-deploy:
```bash
npx ts-node src/verifyIdentityVerificationSchema.ts
```
Still expect `=== VERIFICATION PASSED ===`.

### 6b. API smoke check
Using an ADMIN account's JWT:
```bash
curl -H "Authorization: Bearer <admin-jwt-token>" \
  https://lacra-eudr-backend.onrender.com/api/farmers/verification-queue
```
Expect a 200 with a list (even if empty) — confirms the queue endpoint is
reachable and the ADMIN-only guard isn't misconfigured.

### 6c. Browser check — pick ONE real, low-stakes existing farmer record
(not a synthetic test record — see Step 6d for why no new test record
should be created in production) and manually walk through, logged in as
an actual ADMIN user on the live site:
1. Open the Identity Verification queue — confirms nav visibility + table load.
2. Open that farmer's profile — confirms the badge renders.
3. Flag Identity Conflict with a reason, confirm the badge updates to Conflict.
4. Revert to Unverified with a reason, confirm the badge updates back.
5. Mark Identity Verified, confirm the badge updates to Verified.
6. Edit ONE non-identity field (e.g. phone number) and save — confirm the
   Verified badge is **unaffected** (this field is NOT in
   `IDENTITY_REVERIFICATION_FIELDS`, so it should NOT trigger a revert —
   this is the negative-case check, equally important as the positive one).
7. Edit the farmer's `lastName` (or another identity field) and save —
   confirm the badge **does** auto-revert to Unverified, and that an audit
   entry appears (via `GET /farmers/:id/audit-log` or however the UI
   surfaces it) referencing the field that changed.
8. Log in as an INSPECTOR account — confirm read-only access to the queue
   (no checkboxes/Verify buttons, "View/Correct" link present).
9. Log in as a FARMER account — confirm no nav access and that directly
   visiting the queue URL is blocked.

**If any of these fail**, do not proceed to Step 7 (pilot). Roll back
application code (redeploy the previous commit) if the failure is
code-related; the schema migration itself does not need to be rolled back
for a code-level failure (see README.md's rollback section — the additive
columns are inert if the feature's endpoints aren't called).

### 6d. Do NOT create a synthetic/disposable test farmer or user in production
Unlike the local staging tests (which used a disposable `farmer.test@eudr.com`
account, deleted afterward), production should be checked against a real
existing record precisely because there is no safe way to guarantee a
synthetic production record is fully cleaned up afterward (unlike a local
dev DB you fully control). If Step 6c absolutely requires a FARMER-role
login to check item 9, use an existing real farmer's account if one with
known credentials is available, or coordinate with whoever manages
production user accounts — do not create and then try to delete a
throwaway production user as the default approach.

---

## 7. What happens next

Only after **every** check in Step 6 passes:
- Report the result (pass/fail per check, same honesty standard as the
  local smoke test report) before considering the feature live.
- Begin the small pilot with a few real farmer records, as agreed — this
  deployment plan's job ends here; the pilot itself is a separate,
  subsequent activity.

If anything in Step 6 fails, stop, document exactly what failed, and
decide whether to fix-forward (new commit, repeat from Step 4) or roll
back (redeploy prior commit, leave the additive schema in place per
README.md's rollback guidance) before any pilot begins.
