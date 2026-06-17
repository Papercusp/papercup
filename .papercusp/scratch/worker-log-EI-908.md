# worker-log — EI-908 (auto-implement, attempt 2)

**Item:** EI-908 (bug) — "Operator :3070 restart strands the pinned Queen-brain — wake-brain cron fires but never re-invokes the dormant brain session."
**Disposition:** `needs-human` — but UNLIKE attempt 1, the SAFE, DECIDED half is now LANDED + fully tested. The remaining piece is a genuine design decision on the wake/liveness machinery (a protected surface).

## What I LANDED this run (the incomplete-landing completion — safe, mechanical, fully tested)

The committed EI-908 fix re-diagnosed the root cause as a **workspace-collision**: the brain
pin was ONE global unscoped `brain_session_id` row, so a `.papercusp-hive-demo` instance launch
overwrote it (last-write-wins) and `wake-brain` resolved the WRONG (demo) session. The committed
fix scopes the pin per workspace (`brain_session_id:<workspaceId>`, `brain-pin.ts`). That design is
sound and complete — but it landed INCOMPLETE: one production call site + several test files were
never threaded to the new workspace-scoped signatures. I completed that landing:

- **`lib/hive/watchdog.ts:217` (PRODUCTION bug):** `resolveBrainOwner()` -> `resolveBrainOwner(workspaceId)`
  (`workspaceId` was already in scope). Before: the manual-wake-mode liveness backstop resolved the
  owner against `undefined` -> always null -> silently staged nothing (the backstop was dead in prod).
- **`lib/hive/watchdog.test.ts`:** added a regression assertion that the manual-mode path calls
  `resolveBrainOwner(WS)` (fails before the prod fix, passes after).
- **`lib/brain-pin.integration.test.ts`:** updated to the workspace-scoped API (`setBrainSession(WS, ...)`,
  `getBrainSession(WS)`, `brainSessionKey(WS)`) + added an **EI-908 workspace-isolation regression**
  (a demo workspace's pin can't clobber the desktop workspace's pin — the actual root-cause guard).
- **`lib/endpoint-route/routes/agent-mcp/bootstrap-su-brain-hive.test.ts`:** `resolveBrainPin()` ->
  `resolveBrainPin('ws')` (now requires the workspace) + asserts it reads the scoped pin.
- **`lib/endpoint-route/__tests__/bootstrap-su.test.ts`:** `setBrainSession` assertion -> two-arg
  `(workspace, uuid)`; GET `/brain` response assertions -> include the new `workspace` field.
- **`lib/harness/routines/wake-brain-action.test.ts`:** the live-wake test mock now models a fresh
  `coord_presence.heartbeat_at` (a genuinely-live brain reports one) so the live path resolves the owner.

**Tests run — all green:**
- Unit: `npx vitest run lib/hive/watchdog.test.ts lib/endpoint-route/routes/agent-mcp/bootstrap-su-brain-hive.test.ts lib/endpoint-route/__tests__/bootstrap-su.test.ts lib/harness/routines/wake-brain-action.test.ts` -> **68 passed**.
- Integration: `npx vitest run --config vitest.integration.config.ts lib/brain-pin.integration.test.ts` -> **5 passed** (incl. the new workspace-isolation regression).
- `tsc --noEmit` grep over the EI-908 files -> **0 errors** (the package has a large pre-existing
  TS-error baseline elsewhere, unrelated to EI-908; the watchdog.ts:217 prod error is gone).

## What REMAINS — the design decision (needs-human, STOP condition)

The committed fix ALSO added a liveness guard to `resolveBrainOwner` (`wake-brain-action.ts:72-85`):
if the pinned session's `coord_presence.heartbeat_at` is older than `STALE_MS`, it treats the brain
as DEAD -> **clears the pin** and **no-ops** (does NOT wake, does NOT relaunch).

**This guard defeats EI-908's own headline for the reported timeline — confirmed with hard evidence:**
- `STALE_MS = 600_000` (10 min) and the heartbeat "only fires on tool boundaries" (`liveness.ts:30`).
- Reported incident: brain's last turn 11:10, then idle; wakes fired 11:30 + 12:00. By 11:30 the idle
  (but alive) brain's heartbeat is >10 min old -> STALE -> the guard treats it as dead -> clears + no-ops
  -> the dormant-but-alive brain is **never woken**. That is exactly "wake-brain fires but never
  re-invokes the dormant brain." The guard cannot distinguish "dead process" from "alive but idle >10m"
  using only the presence heartbeat.
- The routine's own header says its mechanism is "fire the inbox-wake -> the always-armed resume ladder
  re-invokes the dormant session." The guard short-circuits exactly that revival.

**Decision a human must make (all on protected surfaces — routines/scheduler + wake/launch machinery):**
1. For a pinned session with a STALE presence heartbeat but a LIVE OS process (idle-but-alive — the
   reported case), should `wake-brain` (a) fire the inbox-wake ANYWAY (trust the resume ladder), (b)
   RELAUNCH it (needs launch machinery a server-side cron lacks — the brain is launched by
   `psu-launcher.mjs` in the desktop dock), or (c) keep the current clear+no-op? Today's committed (c)
   strands it.
2. Should an idle pinned brain maintain a heartbeat at all (a liveness signal independent of tool
   boundaries), so the guard can tell dead from dormant?
3. Verify which root cause actually held in the incident (demo-collision vs dormant-but-alive) — the
   committed workspace-scoping fixes the former; the dormant-revival is unaddressed.

Both legs are STOP conditions (design question + routines/scheduler + launch machinery), not
verifiable by a self-inline change + unit test.
