# worker-log — EI-908 (auto-implement)

**Item:** EI-908 (bug) — "Operator :3070 restart strands the pinned Queen-brain — wake-brain cron fires but never re-invokes the dormant brain session."
**Disposition:** `needs-human` (design decision on a protected surface). No code changed.

## What I verified (call graph, not comments)
- **Reported root-cause hypothesis is contradicted by the shipped design.** The "always-armed inbox-wake" arming is NOT in-memory: it is a durable PG standing row in `harness_shared.event_awaits` (mig 183, partial unique index), re-armed at SessionStart by `activity:report` (`always-armed-inbox-wake.md`; `inbox-wake-arm.ts`/`store.ts`). It survives a `:3070` restart. So "the restart wiped in-memory arming" is wrong; the real reason a wake doesn't revive the brain needs re-diagnosis.
- **The committed EI-908 fix (workspace-scoped pin + liveness guard) landed INCOMPLETE.** `npx tsc --noEmit` (operator-core) reports a real production error:
  - `lib/hive/watchdog.ts(217,27): TS2554 Expected 1 arguments, but got 0` — `resolveBrainOwner()` called with no `workspaceId` (EI-908 made it required). In manual wake-mode `armFallbackHiveWake` therefore always resolves `owner=null` → `skipped: "no pinned brain — nothing staged"`: the manual-mode liveness backstop is dead in prod. The unit test hides it because `watchdog.test.ts` fully mocks `resolveBrainOwner`.
  - Same incomplete-landing broke test call sites: `brain-pin.integration.test.ts(44/50/57/66)`, `bootstrap-su-brain-hive.test.ts(55/62)` — all `TS2554 Expected 1 arguments, but got 0`.
- **The liveness guard may be counterproductive for the reported case.** `wake-brain-action.ts resolveBrainOwner()` now treats a stale-`coord_presence`-heartbeat brain as dead → clears the pin and NO-OPS rather than firing the durable inbox-wake. A dormant-but-alive idle session (no turn → no heartbeat) is exactly the reported timeline, so wake-brain gives up on it — matching "fires but never re-invokes the dormant brain."

## Why needs-human (STOP conditions)
The headline fix — revive a dormant-but-alive pinned `psu --brain` session — requires either:
1. **Relaunching** a desktop-Tauri-shell / launcher-driven interactive session from a server-side cron routine. The brain is launched by `psu --brain` (apps/operator/scripts/psu-launcher.mjs) resolving the pin in the desktop dock; a server-side `wake-brain` routine has no shell to relaunch it into — new launch machinery (protected: routines/scheduler + launch). OR
2. **Redesigning the brain liveness/heartbeat + wake-delivery model** — decide whether a dormant idle session heartbeats, and whether the guard should fire-anyway (trust the wake-executor resume ladder) vs clear-and-no-op. A design decision that can't be verified by a self-inline change + unit test; it is the queen-liveness machinery's own core.

Both are STOP conditions (routines/scheduler + launch machinery; design question; not self-inline-verifiable).

## Concrete, actionable handoff for the human
- Fix the incomplete-landing call sites in one coherent change: pass `workspaceId` at `watchdog.ts:217` (it is already in scope as `workspaceId`), and update `brain-pin.integration.test.ts` + `bootstrap-su-brain-hive.test.ts` to the workspace-scoped signatures. Add a `watchdog.test.ts` assertion that the manual-mode path calls `resolveBrainOwner(WS)` (fails before, passes after).
- Decide the revival policy for a dormant-but-alive brain (fire-anyway vs clear+no-op vs relaunch), and the heartbeat semantics of an idle pinned session — that is the real EI-908.
