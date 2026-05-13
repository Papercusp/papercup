# Auth-hardening WIP coordination note — round 12 audit

**TL;DR:** Three files form a load-bearing group. If the modified `route.ts`
gets committed without the two new lib files, the login route 500s on
`MODULE_NOT_FOUND`. Stage all three together.

## What's in flight (uncommitted)

- **Modified** `apps/operator/app/api/auth/login/route.ts` — adds
  `import { tryLoginAttempt } from '@/lib/rate-limit'` and
  `import { writeSecurityAudit, metaFromRequest } from '@/lib/security-audit'`
  at the top, plus an IP+username rate-limit gate before `login()` and
  `writeSecurityAudit` calls along the success/failure paths.

- **Untracked** `apps/operator/lib/rate-limit.ts` (74 LoC) — in-process
  token-bucket. NOT the same file as the existing
  `apps/operator/lib/operator-rate-limit.ts` (which is the PG-backed
  per-workspace operator-scan limiter — different concern, different
  storage, no overlap).

- **Untracked** `apps/operator/lib/rate-limit.test.ts` (5 tests, all green)

- **Untracked** `apps/operator/lib/security-audit.ts` (87 LoC) — best-effort
  writer for `harness_shared.audit_log` rows tagged `actor:'system:security'`,
  `action:'security.<kind>'`. SecurityEventKind is a closed enum. Writes
  via `getOrgPg()` (harness_admin) which bypasses RLS — so the rows go
  in with `workspace_id=''` and are read-back-visible to the admin-client
  audit tools (`dev:audit`, `operator:audit`'s admin paths).

## Required commit sequence

Stage and commit in one go:

```bash
git add apps/operator/app/api/auth/login/route.ts \
        apps/operator/lib/rate-limit.ts \
        apps/operator/lib/rate-limit.test.ts \
        apps/operator/lib/security-audit.ts
git commit -m "auth: rate-limit + security-audit on /api/auth/login"
```

If any of the four lands without the others, the operator build fails
at module resolution time.

## Audit notes that came out of round-11 review

These already came out clean — flagging so you don't re-audit:

- **Path traversal:** N/A (no scratch involvement).
- **XSS:** N/A (route returns JSON only).
- **Auth bypass:** the rate-limit gate is BEFORE `login()`; an attacker
  can't drain the bucket by guessing valid usernames to lock people out
  because both `${ip}:${username}` and `ip:${ip}` are consumed only on
  successful pass — but **see edge note** below.
- **audit_log RLS:** writes use `getOrgPg()` (admin, bypasses RLS) so
  `workspace_id=''` rows get inserted without policy rejection. Reads
  via the admin-client audit tools see them. Reads via
  `withWorkspace()` (RLS-respecting) won't see them — but security
  events are system-level (cross-workspace) by design, so this is
  correct, not a bug.

## Edge note — rate-limit consumption order

```ts
if (!tryLoginAttempt(`${ip}:${username}`) || !tryLoginAttempt(`ip:${ip}`)) {
  return 429;
}
```

`||` short-circuits when the first returns `false`. So:
- Both bucket calls succeed → both buckets consume 1 token, request proceeds.
- First call fails (per-username bucket exhausted) → ONLY that bucket
  is consumed (short-circuit). Request is rejected with 429.
- First call succeeds, second fails → BOTH buckets consume 1 token.
  Request rejected with 429.

This means a legitimate user with an exhausted per-username bucket gets
to also burn the per-IP bucket (asymmetric). Probably fine — denies the
attacker more aggressively — but worth knowing.

## Submodule + local-main status

While auditing this WIP I noticed `git branch -vv` reports
`main ... ahead 3, behind 3` of `origin/main`. The 3 commits ahead are
your local T2.1 merge + 2 cosmetic fixes; the 3 behind are the squashed
T2.2 (#73), T2.3 (#74) and the migration-066 bump (#72) that landed on
origin/main with rounds 10/11 fixes already incorporated. Sync up via
`git pull --rebase origin main` when convenient — running the operator
on the stale local view leaves you running without the replay buffer,
the migration-066 event_count column writer, my round-10/11 fixes, and
T2.3 scratch storage.

Plan reference: not directly in the Phase-4 plan; this work is auth
hardening sitting alongside the Tier 1+2 stream.
Audit round 12.
