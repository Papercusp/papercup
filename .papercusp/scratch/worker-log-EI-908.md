# worker-log — EI-908 (auto-implement, final / resolved fixed)

**Item:** EI-908 (bug) — "Operator :3070 restart strands the pinned Queen-brain — wake-brain cron fires but never re-invokes the dormant brain session, so the Queen stops placing."
**Disposition:** `fixed` (verified). The bug no longer exists in-tree — both legs landed (by a concurrent committer after attempt 3's needs-human routing) and are regression-tested + green. I made NO code changes; this run VERIFIED the fix against the live call graph and the test suite.

## Why the prior 3 attempts routed to needs-human, and why that's now moot

Attempts 1-3 correctly routed to a human: at that time `resolveBrainOwner` carried a liveness guard that, on a `coord_presence` heartbeat older than `STALE_MS` (10m), CLEARED the pin and no-op'd — and an idle-but-alive brain's heartbeat is stale within minutes, so the dormant brain (the exact reported case) was never woken. Choosing what to do there (fire-anyway vs relaunch vs clear+no-op) was an open design decision on a protected surface (routines/scheduler + wake machinery) -> needs-human.

That decision has since been MADE in the committed code (option (a): fire the inbox-wake anyway and trust the wake-executor's liveness-adaptive resume ladder). I verified the current tree, not the comments.

## Verified current state (live call graph, not doc-strings)

1. **Headline — dormant-brain revival (LANDED).** `lib/harness/routines/wake-brain-action.ts`: the heartbeat guard + pin-clear are GONE. `resolveBrainOwner(workspaceId)` resolves the pinned session -> its `coord_owner_id` with NO liveness gate; the action fires `wakeRecipients([owner])` for a dormant brain. Header lines 21-37 document the rationale: the await-event executor is the single liveness authority (live pty -> inject; exited -> headless `claude --resume` spawned detached server-side; uninjectable -> park+nudge), so firing the wake revives the brain in every state without launch machinery the cron lacks.
2. **Root cause — workspace-pin collision (LANDED).** `lib/brain-pin.ts` scopes the pin per workspace (`brain_session_id:<workspaceId>`), so a `.papercusp-hive-demo` launch can no longer clobber the desktop's pin (the actual incident). The old `clearBrainSession` guard helper is now DEAD CODE — `grep clearBrainSession` -> only its own definition, zero callers.
3. **Prod TS2554 (attempt 1's blocker) — GONE.** `lib/hive/watchdog.ts:221` calls `resolveBrainOwner(workspaceId)` (workspace-scoped); the manual-mode liveness backstop resolves the right pin.

## Tests run — all green

- `cd packages/operator-core && npx vitest run lib/harness/routines/wake-brain-action.test.ts lib/hive/watchdog.test.ts` -> **26 passed** (2 files). Includes the EI-908 regression `wake-brain-action.test.ts:77` — "flag ON + pinned, tracked, but DORMANT (no heartbeat) -> STILL wakes its owner" (would fail under the removed guard; passes now).
- `npx tsc --noEmit` filtered to `wake-brain-action|hive/watchdog|brain-pin` -> **NO_EI908_TS_ERRORS** (the watchdog.ts prod error attempt 1 found is gone). The package's large pre-existing TS baseline elsewhere is unrelated.

## Note for a future reader (a small remaining tidy, out of scope for this bug)

`clearBrainSession` (`brain-pin.ts:113-123`) is now dead code carrying a stale "EI-908 liveness guard" doc-string. It is harmless (zero callers) but misleading; a follow-up cleanup could remove it. Left untouched here to keep this resolution to the smallest correct surface — the bug itself is fully fixed.
