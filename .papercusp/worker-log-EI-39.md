# Worker log — EI-39 (auto-implement, dispatch attempt 2)

## Item
`[bug] locks:release {all_mine:true} fails with "channel name too long" — leaves wedged PreToolUse locks` (kind=bug, scope=operator).

## What I did
Verification-only run. The fix was already landed and committed in-tree before
this dispatch; my job was to confirm reality (not trust the prior comment) and
close the loop.

### Confirmed the fix is genuinely in-tree
- `libs/papercusp/packages/locks/src/sql/013-bounded-notify-channel.sql`
  (committed in the submodule, 574abb0) introduces
  `coord_notify_channel(domain) = 'ch_coord_' || md5(domain)` (41 bytes, always
  < PG's 63-byte channel cap) and re-creates **both** `grant_cascade` and
  `resource_grant_cascade` to NOTIFY on the bounded channel (+ a `left(...,63)`
  legacy channel for pre-013 listeners).
- `sql/014-grant-cascade-expired-steal.sql` re-creates `grant_cascade` again,
  still on the bounded channel.
- TS LISTEN side mirrors it: `workspace-listener.ts coordNotifyChannel()` uses
  node:crypto md5 — SQL and TS can never disagree on the name.

### Confirmed the whole `all_mine` release path is bounded
`locks:release {all_mine:true}` (packages/operator-core/.../locks/release.ts):
1. file-lock `tryRelease` -> `grant_cascade` — bounded (013/014). OK
2. `releaseAllResourcesForOwner` -> `resource_grant_cascade` — bounded (013). OK
   (resource-lock-store.ts:422)
3. `broadcastResourceBackUp` — `.catch(() => {})` best-effort, cannot surface
   as handler_error. OK
Remaining raw `ch_coord_<domain>` strings in operator-core are only in test
preconditions; old migrations 003/004/005/010 are superseded by 013/014 via
CREATE OR REPLACE.

### Reproduced (regression tests, green)
`cd packages/operator-core && npx vitest run --config vitest.integration.config.ts
lib/agent-tools/locks/__tests__/resource-locks.integration.test.ts`
-> 13 passed, including the two EI-39 regressions that drive the all_mine
sweep through `resource_grant_cascade`'s NOTIFY on a >63-byte domain and assert
no throw + lock released + draining exclusive flips to held.

## Not done (intentional, matches prior worker)
The issue's secondary ask — make the per-edit PreToolUse hook's release
resilient — touches the file-lock authority / hook (a protected surface) and is
not needed to close the channel-too-long bug. Left as a follow-up.

## For the validator
The core bug is fixed and verified; only the regression tests
(resource-locks + su-locks-wait integration) are uncommitted in the tree —
git-sync will pick them up. No code change made this run.
