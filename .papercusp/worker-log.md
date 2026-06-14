# Worker log — EI-39 `locks:release {all_mine:true}` "channel name too long"

## Diagnosis
EI-39 (filed 2026-06-05): `locks:release { all_mine: true }` returned
`handler_error: channel name too long` and released nothing, leaving PreToolUse
locks wedged to their 20-min TTL.

Root cause: PG channel names cap at NAMEDATALEN-1 = 63 bytes. The coordination
domain is the repo realpath; `'ch_coord_' || domain` crosses 63 bytes for the
live checkout. `pg_notify()` (text arg) RAISES on an over-long name (while LISTEN
silently truncates), so any grant cascade that fired a NOTIFY aborted the whole
release transaction. The `all_mine` path is doubly exposed: it runs BOTH the
file-lock `grant_cascade` (via `tryRelease`) AND the resource `resource_grant_cascade`
(via `releaseAllResourcesForOwner` in `libs/papercusp/packages/locks/src/resource-lock-store.ts:422`).

The issue speculated about a resource-keyed or owner-keyed channel; that was
unfounded — the ONLY variable-length channel is domain-keyed.

## Already-shipped fix (NOT mine)
The channel-overflow root cause was fixed AFTER EI-39 was filed, by the 2026-06-09
"channel name too long" incident work:
- `libs/papercusp/packages/locks/src/sql/013-bounded-notify-channel.sql` — adds
  `coord_notify_channel(domain) = 'ch_coord_' || md5(domain)` (41 bytes, always
  valid) + a legacy bridge channel, and rewrites BOTH `grant_cascade` and
  `resource_grant_cascade` to use it.
- `sql/014-grant-cascade-expired-steal.sql` — re-creates `grant_cascade` keeping
  the bounded channel.
- `libs/papercusp/packages/locks/src/workspace-listener.ts` `coordNotifyChannel`
  mirrors the md5 on the TS LISTEN side.

So the bug no longer reproduces. Per the implement contract ("evidence says it no
longer exists → that IS a verified fix"), this resolves `fixed`.

## My change (test-only, non-protected surface)
The existing regression test (`su-locks-wait.integration.test.ts`) covered only
the FILE-lock cascade on a long domain. EI-39's exact repro is the RESOURCE
sweep on `all_mine:true`, which had no dedicated coverage. Added one:
- `packages/operator-core/lib/agent-tools/locks/__tests__/resource-locks.integration.test.ts`
  — new `it`: `releaseAllResourcesForOwner` on a >63-byte raw-channel domain must
  not raise "channel name too long" and must still flip a draining exclusive →
  held through the cascade's `pg_notify`. Mirrors the existing drain test's
  draining→held assertion.

No production/authority/migration code touched.

## Verification
- `npx vitest run --config vitest.integration.config.ts lib/agent-tools/locks/__tests__/resource-locks.integration.test.ts`
  → 12 passed (was 11; my new EI-39 test green). DB live, not skipped.
- `npx vitest run --config vitest.integration.config.ts lib/agent-tools/locks/__tests__/su-locks-wait.integration.test.ts`
  → 6 passed (companion file-lock channel regression still green).

## For the validator to re-verify
- The new test genuinely exercises a `pg_notify` on a >63-byte raw channel (the
  draining→held flip fires `resource_grant_cascade`; migration 013 shows its
  pg_notify on exactly that transition). Could not prove RED by reverting the
  migration (out of scope — STOP condition on migrations); confidence rests on
  the parallel su-locks-wait test proven against the original incident.
- The lands-via-release-gate path: no migration/authority edits, so deploy is a
  no-op beyond shipping the new test.
