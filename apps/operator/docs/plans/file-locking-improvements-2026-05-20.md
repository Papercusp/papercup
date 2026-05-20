---
title: File-locking improvements — SU-locks + FileLockQueue
status: Awaiting review
date: 2026-05-20
supersedes: none
related:
  - apps/operator/docs/plans/su-agent-coordination-v3-2026-05-14.md
  - apps/operator/docs/plans/file-locking-systems-comparison-2026-05-20.md
updated: 2026-05-20
---

## Now

**State:** Papercusp has two file-locking systems:

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


# File-locking improvements — SU-locks + FileLockQueue

## §0 Context

Papercusp has two file-locking systems:

1. **`FileLockQueue`** — `libs/papercusp/packages/orchestrator/src/file-lock-queue.ts`. In-process, in-memory; coordinates async worker dispatches inside one orchestrator Node process. ~240 lines.
2. **SU-locks** — `apps/operator/lib/agent-tools/locks/`. Cross-process, Postgres-backed (`papercusp_su` database); coordinates independent `papercusp-su` engineer-collaborator agents (OMP sessions). Committed in `9ebb499a` on 2026-05-20.

A full design comparison lives in `file-locking-systems-comparison-2026-05-20.md`. The short version: same conceptual API (`acquire/release/extend/reap`, FIFO, atomic multi-path), different constraint set (one heap vs. N processes), so the implementations correctly diverge but the **vocabulary and contract should be shared**.

This plan captures **11 improvements** identified during that comparison. They span correctness gaps (silent), observability holes, polish, and one structural refactor.

The plan is intentionally *not* a single monolithic change — improvements are independent enough that each is its own PR with its own verification. Sequencing matters only where one improvement's API affects another.

## §1 Goals / non-goals

### Goals

- Close the **silent correctness gaps** in SU-locks (path canonicalization, unverified per-session identity for OMP — see #2).
- Wire up or remove `FileLockQueue.reap` — its current "exists but no caller" state is a latent reliability hole.
- Kill the E2E flakes by extracting the inline janitor work from the acquire hot path.
- Extract a **shared `FileClaimCoordinator` interface** so the two systems align on vocabulary, contract, and conformance — without merging implementations (they correctly can't share one).
- Make hook failures **visible** instead of silent — enforcement degrading invisibly is worse than not having it.

### Non-goals

- **Do not merge SU-locks and FileLockQueue.** They solve different problems with the same noun; merging them is the category error called out in the comparison doc.
- **Do not migrate FileLockQueue to PG.** Persistence buys nothing when the orchestrator process death takes every worker with it. The "no persistence" property is correct.
- **Do not extend SU-locks to multi-workspace until needed.** `workspace_id = 'default'` everywhere today; future-proofing without a user is overdesign.
- **Do not replace `pg_advisory_xact_lock`.** It's the right primitive. Keep it.
- **Do not build Claude Code / Codex / Gemini integration.** Per the 2026-05-20 OMP-only decision, OMP is the sole engineer-collaborator harness; users who want Claude, GPT, or Gemini models run them *through* OMP. The Claude Code PreToolUse shell hooks shipped in `9ebb499a` (`pretooluse-locks-acquire.sh`, `posttooluse-locks-release.sh`) become dead code and are deleted as part of #2.

### What "done" looks like for the plan as a whole

- Tier 1 items (#1, #2, #7) all shipped, tested, committed on `main`.
- Tier 2 items (#3, #4, #5, #8) shipped where the user agrees they're worth the effort.
- Tier 3 (#11, shared interface) shipped after Tier 1 lands — it consumes the cleaned-up surface.
- Polish items (#6, #9, #10) folded into adjacent PRs opportunistically; not their own work.
- `file-locking-systems-comparison-2026-05-20.md` updated with "as-built deltas" addendum.


## §2 Improvement catalog

Each improvement is numbered to match the chat discussion. Tier assignments reflect *priority for shipping*, not size — Tier 1 items are silent correctness gaps; Tier 2 items are observability/reliability gaps with workarounds today; Tier 3 is the structural refactor; polish is opportunistic.

---

### Tier 1 — must do (silent correctness gaps)

---

### #1 — SU-locks: path canonicalization

**Problem.** `apps/operator/lib/agent-tools/locks/su-lock-store.ts:229–233` defines `normalizePaths()` as *sort + dedupe only* — no canonicalization. Today, these all hash to distinct lock keys for the same file:

- `apps/foo.ts`
- `./apps/foo.ts`
- `apps/./foo.ts`
- `apps//foo.ts`
- `apps/foo.ts/` (trailing slash)
- A symlink pointing at `apps/foo.ts`

The OMP hook (see #2) normalizes to canonical repo-relative POSIX paths, so the bug is masked along that path. Any caller using `locks:acquire` directly via curl, or via a future tool that constructs paths differently, can sidestep the lock entirely — two agents holding "the same file" simultaneously.

**Why this is silent.** All 43 vitest + 25 E2E + smoke tests use canonical paths. The bug cannot surface in the test suite without explicitly testing for it.

**Proposed fix.** Tighten `normalizePaths()` in `su-lock-store.ts`:

1. Strip leading `./`.
2. Collapse `//` → `/`.
3. Strip trailing `/`.
4. **Reject** (don't normalize) `..` segments — keep the existing throw; the path is malformed.
5. **Reject** absolute paths — must be repo-relative.
6. **Reject** Windows-style backslashes — POSIX forward slashes only.
7. Document the canonical-path contract in `apps/operator/lib/agent-tools/locks/README.md` and in the tool descriptions.

**Symlinks — explicitly out of scope.** Resolving symlinks would require a server-side stat against the agent's working directory, which the operator doesn't share. Document that symlinks within the repo are the caller's responsibility to resolve before calling `locks:acquire`. Add a check in the OMP hook to refuse to acquire on a symlink (one `readlink -f` equivalent).

**Files touched.**
- `apps/operator/lib/agent-tools/locks/su-lock-store.ts` — `normalizePaths()` (~20 lines).
- `apps/operator/lib/agent-tools/locks/__tests__/su-lock-store.test.ts` — 6 new test cases (one per canonicalization rule + one for rejection).
- `apps/operator/lib/agent-tools/locks/README.md` — contract section.
- the OMP hook (see #2) — symlink refusal (~3 lines).
- `apps/operator/scripts/su-locks-e2e.sh` — §13 — equivalent paths collide test.

**Test strategy.** Unit: each canonicalization rule, isolated. Integration: two acquires of equivalent-but-non-identical strings (`apps/foo.ts` and `./apps/foo.ts`) — second must get `busy`. E2E: same scenario via real HTTP.

**Effort.** Half-day including tests and doc.

**Risk.** Low. Tighter normalization can only *reject* paths the current code accepts; existing tests should all still pass because they use canonical paths already. The one risk: a real agent has been quietly relying on a non-canonical path string in production. Mitigation: log (not throw) once for a few days before flipping to reject, in a small canary PR.

---

### #2 — SU-locks: OMP enforcement hook

**Problem.** Per-session identity (the fix shipped in `9ebb499a`) works **if and only if** the MCP client maintains a distinct `Mcp-Session-Id` header per process. That fix was verified end-to-end against **Claude Code** — the CLI the 2026-05-20 OMP-only decision now drops. It is **unverified for OMP**, which is the *only* CLI the system still coordinates.

If OMP's MCP client doesn't send `Mcp-Session-Id` (or sends a static one), two real OMP shells collapse to the same `owner` derived from the shared `?client=<machine-uuid>` baked into the config by `install-standalone-mcp.sh`. The lock store can't tell them apart; the system silently provides nothing.

**Why this is now critical-path.** The system's *primary correctness claim* — "two SU agents on one machine don't stomp each other" — rests entirely on OMP per-session identity, and that is presently unproven. This is no longer "3 of 4 CLIs unverified"; it is *the one CLI we keep*, unverified. The OMP enforcement hook below resolves it structurally — by owning identity at the hook layer, the hook makes per-process identity unconditional and the `Mcp-Session-Id` question moot.

**Proposed fix — the OMP enforcement hook.**

OMP v15.1.3 exposes a `tool_call` hook (verified in `/home/marsh-office/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/hooks/`) that fires *before* a tool runs and can `return { block: true, reason }` to refuse execution.

Build `apps/operator/scripts/hooks/omp/su-locks-hook.ts` (TypeScript module, OMP-required) that:

1. **On `session_start`** — mint a per-process owner id (`omp-<sessionId>-<pid>`); cache it.
2. **On `tool_call`** for `edit`/`write`/`multi_edit` — extract the file path from tool input, normalize to repo-relative POSIX, POST `locks:acquire` to the operator URL read from `~/.omp/agent/mcp.json` → `papercusp-su.url`. On `busy`, return `{ block: true, reason: "Held by ${holder.owner_label} until ${expires_ts}: ${holder.intent}" }`. On `ok`, cache the `lock_id` keyed by the OMP-provided `toolCallId`.
3. **On `tool_result`** for the same tools — release the cached `lock_id`.
4. **On `session_shutdown`** — release all outstanding locks for this owner (defensive — should be empty if `tool_result` always fires).
5. **Fail-open on operator unreachable** — let the edit through on infra failure rather than wedging the agent. But surface the failure (see #3).

This hook bypasses `Mcp-Session-Id` entirely — it owns its identity at the hook layer, before the MCP client even gets involved. That's a structural fix: the hook makes per-process identity *unconditional* for OMP, not contingent on whether OMP's MCP client implementation sends a session header.

Wiring: `install-standalone-mcp.sh` drops the hook into `~/.omp/agent/hooks/` (auto-discovery dir — must verify exact path against OMP's hook discovery code; the `--hook=<path>` flag is the explicit fallback if discovery's path differs).

**Files touched.**
- `apps/operator/scripts/hooks/omp/su-locks-hook.ts` — new OMP hook, ~150 lines. (Path under `hooks/omp/` per the OMP-bundle plan D-008(a) single-source convention.)
- `apps/operator/scripts/hooks/pretooluse-locks-acquire.sh`, `posttooluse-locks-release.sh` — **deleted.** Dead code once Claude Code is dropped; the OMP hook replaces them.
- `apps/operator/scripts/install-standalone-mcp.sh` — install the OMP hook into `~/.omp/agent/hooks/`; drop the `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md` / `~/.gemini/GEMINI.md` injection (OMP-only now); update README.
- `apps/operator/scripts/hooks/README.md` — rewrite for the OMP-only hook story; correct the stale claim that *"OMP ships no registered-config-file hook surface"* (false in v15.1.3+).
- `apps/operator/scripts/su-locks-omp-smoke.sh` — new, programmatic two-OMP-shell test (similar shape to the §12 per-session checks).

**Test strategy.**
- Unit: hook module exports the expected event handlers; path-normalization within the hook is consistent with `normalizePaths()` (shared util preferable — extract from `su-lock-store.ts` into `apps/operator/lib/agent-tools/locks/path-normalize.ts`, import from both server and hook).
- Smoke: spawn two OMP processes, both edit the same file; observe one blocks.
- E2E: extend `su-locks-e2e.sh` §12 with an OMP equivalent (§14).

**Effort.** 2–3 days — build + test + install integration, plus deleting the dead Claude Code shell hooks. (Down from the prior estimate: the Codex/Gemini identity probes are gone with the OMP-only decision.)

**Risk.** Moderate. OMP's hook API contract is documented but not battle-tested in our use; specific concerns:
- Auto-discovery dir might differ from `~/.omp/agent/hooks/` — *must verify before building, not after*.
- `edit`/`write`/`multi_edit` tool input field names — must inspect OMP's tool registry, not guess.
- `HookToolWrapper` instantiation must actually be in OMP's default tool path — confirm by grep before trusting that hooks are wired in.
- TypeScript module loading inside OMP may have restrictions on imports (no `node_modules`?) — must test.

These are pre-requisites, not risks during build — they're "questions to answer before writing code."

---

### #7 — FileLockQueue: `reap()` is unused

**Problem.** `lockQueue.reap(owner)` is defined in `file-lock-queue.ts:213` with the documented purpose *"clean up after a dead lane"*. Grep confirms **no production caller** — only `file-lock-queue.test.ts:411,424,436,445` references it. `worker-chunk-loop.ts` always releases via `finally`, which is correct for normal completion + exceptions but *not* for force-cancellation (`AbortController.abort()`, process-level signals that bypass the JS finally).

A lane that's force-killed (lane budget exceeded → orchestrator cancels; supervisor kills a runaway) leaves its locks held forever. Other lanes block forever. The orchestrator's own concurrency primitive has a leak path with no recovery.

**Why this is silent.** Force-cancel is rare. When it happens, the next worker that tries to acquire the same path waits forever — looking like a hang, not a lock leak. No telemetry distinguishes the two.

**Proposed fix — two viable options. User picks one.**

**Option A: wire `reap()`** into the lane supervisor. When a lane terminates abnormally (`AbortSignal` fired without the worker calling `release`, lane-budget timeout, supervisor kill), the supervisor calls `lockQueue.reap(lane.ownerId)`. ~10 lines in `main-loop.ts` lane-pool code, depending on lane-pool shape.

**Option B: delete `reap()`** with the argument that in-process means a corrupted process is going down anyway — orchestrator restart clears the heap. Acknowledge the gap explicitly in `file-lock-queue.ts` header comment, with a note about future cross-process needs.

I recommend **Option A**. The lane pool already supervises lane lifecycle for budget/cancellation purposes; adding a `reap` call to its termination path is small, principled, and removes a latent hang. Option B is a cleanup but the supervisor is going to grow more error paths over time and we'll want this primitive anyway.

**Files touched (Option A).**
- `libs/papercusp/packages/orchestrator/src/main-loop.ts` — lane supervisor termination hook (~10 lines).
- `libs/papercusp/packages/orchestrator/src/file-lock-queue.test.ts` — new test for reap-on-abort.

**Test strategy.** Two `runChunkLoop` calls share a `FileLockQueue`. Cancel the first mid-acquire via `AbortController`. Assert the second's `acquire` resolves rather than hangs.

**Effort.** 1 hour (Option A) or 30 min (Option B).

**Risk.** Low. `reap()` itself is implemented and tested; wiring is the only delta.

---

### Tier 2 — should do (observability + reliability)

---

### #3 — SU-locks: visible hook fail-open

**Problem.** The OMP hook's `tool_call` handler (see #2) fails open on any unrecoverable error — operator unreachable, malformed payload, network timeout — letting the edit through. The hook **silently degrades to no enforcement.** A misconfigured hook is indistinguishable from a working one. The system's enforcement property changes from "you have it" to "you have it unless..." and the user cannot tell which.

This is a security/correctness property: enforcement that silently disappears is worse than not having enforcement, because the user *believes* they have protection.

**Why fail-open is still the right exit-code call.** Wedging an agent's edit on infra failure (operator restarted, transient network blip) is the wrong tradeoff. The right design is *exit 0 + leave a marker*.

**Proposed fix.**

1. On any error path in the OMP hook's `tool_call` / `tool_result` handlers, write a JSON record to `~/.papercusp/locks-cache/last-error.json`:
   ```json
   { "ts": "<ISO>", "handler": "tool_call", "phase": "<connect|http|parse>", "detail": "<short>", "operator_url": "<url>" }
   ```
   Atomic write via temp file + rename.
2. Add an operator endpoint `GET /api/su-locks/hook-health` that reads `~/.papercusp/locks-cache/last-error.json` and the timestamp of the most recent successful hook call (track this similarly), returning `{ healthy: bool, last_success_ts, last_error }`.
3. Add a banner to the operator UI (likely the harness page, since that's where SU agents are most relevant) that surfaces *"SU-locks hook unhealthy — file edits unprotected since T"* when `healthy: false`.
4. Optionally: add a small CLI `papercusp-su-doctor` that prints the same status for debugging from a terminal.

**Files touched.**
- `apps/operator/scripts/hooks/omp/su-locks-hook.ts` — error logging in the `tool_call` / `tool_result` handlers (~15 lines).
- `apps/operator/app/api/su-locks/hook-health/route.ts` — new endpoint.
- Harness page UI — banner component (likely `apps/web/app/harness/SuLocksHealthBanner.tsx`).
- `apps/operator/scripts/papercusp-su-doctor.sh` — optional CLI.

**Test strategy.**
- Smoke: kill the operator, attempt an edit, observe the marker file populates and the banner appears within next page load.
- Unit: route returns correct shape for healthy and unhealthy states.

**Effort.** Half-day for marker + endpoint + banner. Doctor CLI is a stretch goal — skip if time-bound.

**Risk.** Low. Banner UI is the only new surface; the marker file is straightforward.

---

### #4 — SU-locks: extract janitor from acquire hot path

**Problem.** `su-lock-store.ts:328–333` — every `tryAcquire` call runs `janitorAndCollectExpiredWorkspaces` and conditionally `grant_cascade`, all inside the per-statement 500ms `statement_timeout` set in `in-workspace-txn.ts`. Under dev-server load (Tauri dev shell saturating the connection pool, Next.js recompiles), this timeout fired in two E2E runs out of ~20 — dismissed as "environmental" but it's actually architectural: the acquire's worst-case bound is the janitor's worst-case bound, which is bounded by partial indexes but bursty.

**Why this matters.** A single slow acquire is annoying. A flaky acquire that *fails* an edit is a real problem — the agent retries, the user wonders why the system is unreliable. The flake masks the success of the rest of the system in tests.

**Proposed fix.**

Move the janitor from "runs inside every acquire" to:

1. **Background interval** — workspace listener (`workspace-listener.ts`) runs `janitorAndCollectExpiredWorkspaces + grant_cascade` every 30s. The listener already has a long-lived PG connection; piggyback there.
2. **Reactive on TTL boundary** — when an acquire detects a path with `expires_ts <= now`, run an *inline-but-narrow* expiry sweep for just that path (~1 PG round trip, no broad scan), then retry the acquire. The path-narrow sweep is bounded; the broad sweep happens out-of-band.

`tryAcquire` becomes: pure read-check + upsert. Acquire's worst-case bound drops from "janitor bursty work" to "PG upsert," which the 500ms timeout comfortably covers.

**Files touched.**
- `apps/operator/lib/agent-tools/locks/su-lock-store.ts` — remove inline janitor calls; add path-narrow expiry sweep helper (~30 lines net change).
- `apps/operator/lib/agent-tools/locks/workspace-listener.ts` — add periodic janitor invocation (~15 lines).
- `apps/operator/lib/agent-tools/locks/__tests__/su-lock-store.test.ts` — adjust tests that depended on janitor-on-acquire (search for any; convert to explicit janitor calls if so).
- `apps/operator/scripts/su-locks-e2e.sh` — should pass more reliably; no test changes needed.

**Test strategy.**
- Unit: TTL-expired lock is acquirable after the periodic sweep runs (fake timers in test).
- Stress: 100 concurrent acquires under load — assert none time out. Today this is flaky; after the fix it should not be.

**Effort.** Half-day.

**Risk.** Moderate. The janitor's transactional placement matters — moving it out-of-line risks a race where a lock looks held but is actually expired. The path-narrow inline sweep is the mitigation: any acquire that sees an expired holder for *its* path resolves it synchronously. Need careful test coverage of the boundary case.

---

### #5 — SU-locks: acquire response echoes resolved owner

**Problem.** Today `locks:acquire` returns `{ ok, lock_id, expires_ts, held }` — but not the **owner identity the server actually used**. The agent calling acquire may believe it's identified by `?client=<X>` while the server resolved it from `Mcp-Session-Id: <Y>`. Debugging "why doesn't my acquire collide with the other agent's?" requires `psql -d papercusp_su -c "select owner from agent_file_locks where..."`.

**Why this matters.** It's a transparency / self-explanation issue, not a correctness one. But the per-session identity fix (`9ebb499a`) makes the identity-resolution path nontrivial, and the system gives the caller no way to verify what it resolved to.

**Proposed fix.** Add `owner` (full, server-canonical) and `owner_label` (truncated, for logs) to the success response of `acquire`. Also surface in `release`, `heartbeat`, and the `busy` response (`busy` already includes `holder.owner_label`; add the unredacted `holder.owner` too, since `papercusp-su` is admin-tier).

**Files touched.**
- `apps/operator/lib/agent-tools/locks/acquire.ts` — append to response.
- `apps/operator/lib/agent-tools/locks/release.ts` — same.
- `apps/operator/lib/agent-tools/locks/heartbeat.ts` — same.
- `apps/operator/lib/agent-tools/locks/__tests__/*.test.ts` — assert new fields.
- Tool descriptions / docs.

**Test strategy.** Trivial — assertion in existing tests.

**Effort.** 1 hour.

**Risk.** None. Additive to response shape.

---

### #8 — FileLockQueue: acquire timeout

**Problem.** `lockQueue.acquire(owner, paths)` has no timeout. A hung worker holds locks forever; later workers block forever. Today, the LLM client and lane budget enforce timeouts at the supervisor level — the lane is killed externally and (post-#7) `reap` runs. But `acquire` itself has no escape hatch.

If the lane supervisor's own bookkeeping has a bug (a lane never gets a budget timer started, lane-pool drops a task), the system has no second line of defense.

**Proposed fix.** Extend the signature:

```ts
acquire(owner: string, paths: readonly string[], options?: { timeoutMs?: number }): Promise<LockHandle>
```

On timeout, reject with a typed `LockAcquireTimeoutError` carrying the contending owners. Callers can opt-in by passing `timeoutMs`; default behavior unchanged (no timeout).

**Files touched.**
- `libs/papercusp/packages/orchestrator/src/file-lock-queue.ts` — ~15 lines.
- `libs/papercusp/packages/orchestrator/src/file-lock-queue.test.ts` — 1–2 new tests.
- `libs/papercusp/packages/orchestrator/src/worker-chunk-loop.ts` — pass a generous default (5–10 min) so a degenerate hang surfaces as an error instead of forever-block.

**Test strategy.** Acquire blocks; expire timer fires; promise rejects with typed error.

**Effort.** 1 hour.

**Risk.** Low. Opt-in feature; existing callers unaffected unless they pass the new option.

---

### Tier 3 — structural refactor

---

### #11 — Shared `FileClaimCoordinator` interface + conformance suite

**Problem.** The two systems use **near-identical vocabulary** for **near-identical contracts**, but neither knows the other exists in code:

| Concept | `FileLockQueue` | SU-locks |
|---|---|---|
| Acquire | `acquire(owner, paths)` | `tryAcquire({ owner, paths, ttlSec, ... })` |
| Release | `release(handle)` | `release({ lockId, owner })` |
| Extend | `tryExtend(handle, addPaths)` | re-acquire is idempotent + extends |
| Heartbeat | (n/a in-process) | `heartbeat({ lockId, owner, ttlSec })` |
| Reap | `reap(owner)` | TTL expiry + janitor sweep |
| Wait/wake | promise resolution | LISTEN/NOTIFY |

Same conceptual API, different names, different argument shapes, different deadlock-freedom rationales recorded in headers (one wrong, per the comparison doc). The next engineer adding a *third* coordinator (filesystem-lockfile, Redis, anything cross-process for an environment without PG) will reinvent the wheel a third time, differently.

**Why this matters more than it looks.** This isn't about reducing line count — they correctly can't share an implementation (`Map` vs PG). It's about:

1. **Vocabulary alignment.** Two engineers staring at the codebase shouldn't have to learn two APIs that mean the same thing.
2. **Conformance.** A single test suite that runs against *both* implementations forces them to agree on edge cases: what does `acquire` do when one path of a multi-path set is already held? What's the order of waiter wake-up? Today both answer the same way; tomorrow they could drift silently.
3. **Documentation single-source.** The deadlock-freedom property has one explanation, with both implementations pointing at it (and citing why their specific mechanism achieves it). Today FileLockQueue's header explains it wrong.
4. **Future-proofing for real.** A future filesystem-lockfile coordinator (for environments without PG — air-gapped, offline-first desktop) drops in behind the same interface.

**Proposed fix.**

1. **Define** `libs/papercusp/packages/coordination/src/file-claim-coordinator.ts`:

   ```ts
   export interface ClaimHandle {
     readonly id: string;          // opaque
     readonly owner: string;
     readonly paths: readonly string[];
     readonly expiresAt: Date | null;  // null = no TTL (in-process)
   }

   export interface AcquireOptions {
     ttlSec?: number;     // implementations may ignore (in-process)
     timeoutMs?: number;  // ignored if undefined
     intent?: string;     // observability only
   }

   export type AcquireResult =
     | { ok: true; handle: ClaimHandle }
     | { ok: false; reason: 'busy' | 'timeout'; conflicts: ConflictInfo[] };

   export interface FileClaimCoordinator {
     acquire(owner: string, paths: readonly string[], options?: AcquireOptions): Promise<AcquireResult>;
     release(handle: ClaimHandle): Promise<void>;
     extend(handle: ClaimHandle, addPaths: readonly string[]): Promise<ClaimHandle>;
     reap(owner: string): Promise<void>;
     heartbeat?(handle: ClaimHandle, ttlSec: number): Promise<void>; // optional — in-process implementations can omit
   }
   ```

2. **Refactor** `FileLockQueue` to implement the interface. Existing callers in `worker-chunk-loop.ts` still call `acquire`, but on the typed interface — they don't care which implementation.

3. **Refactor** SU-locks `acquire.ts` / `release.ts` / `heartbeat.ts` to be thin tool-wrappers around `SuLocksCoordinator implements FileClaimCoordinator`. The PG store stays where it is; the *user-facing tool surface* (the MCP `locks:*` tools) thin out to dispatch into the coordinator. Tools still take their existing argument shapes (don't break the wire); they translate to interface calls internally.

4. **One conformance test file** — `libs/papercusp/packages/coordination/__tests__/conformance.test.ts`. Parameterized over `[FileLockQueueCoordinator, SuLocksCoordinator]`. Asserts:
   - Multi-path atomicity (no partial holds).
   - FIFO waiter order.
   - Re-acquire same-owner extends (idempotent).
   - Re-acquire different-owner gets `busy`.
   - `reap` clears all of an owner's holds.
   - (Conditional, with `ttlSec` set) TTL expiry releases.
   - (Conditional, with `timeoutMs` set) Timeout fires.

   Each implementation gets a setup/teardown lambda; conformance test stays implementation-blind.

5. **Single doc** — `libs/papercusp/packages/coordination/README.md`:
   - The contract (atomic acquire → no hold-and-wait → deadlock-free).
   - Both implementations, what each is for, when to use which.
   - **Corrects** FileLockQueue's header about the sort being load-bearing (it isn't; the no-hold-while-waiting is).
   - Points future implementations at the conformance suite.

**Files touched (large but mostly mechanical).**
- New package: `libs/papercusp/packages/coordination/` — interface, README, conformance suite.
- Wrap: `libs/papercusp/packages/orchestrator/src/file-lock-queue.ts` (no logic change; type adaptations).
- Wrap: `apps/operator/lib/agent-tools/locks/su-lock-store.ts` (no SQL change; type adaptations).
- Tool wrappers: `apps/operator/lib/agent-tools/locks/{acquire,release,heartbeat,cancel_wait,queue}.ts` (signature unchanged externally; internals dispatch into coordinator).
- All caller sites: typed against interface, not concrete class.

**Test strategy.** The conformance suite *is* the test strategy. If it passes for both implementations, behavior is unified.

**Effort.** 1 day.

**Risk.** Moderate. Lots of files touched mechanically; risk is a missed call site or a subtle signature drift. Mitigation: do this *after* Tier 1 (#1, #7) so the surfaces are clean. The wrappers (the #2 OMP hook, #5's response field, etc.) are easy to add through the interface afterward.

**Important sequencing constraint.** Don't start #11 until Tier 1 lands. The interface should reflect cleaned-up shapes, not today's surface + later renames.

---

### Polish items (opportunistic — fold into adjacent PRs)

These don't justify their own PR but should be picked up when an adjacent PR is already touching the same file.

---

### #6 — Replace `xmax = 0` PG-internals dependency

**Problem.** `tryAcquire`'s clever partial-rollback logic distinguishes fresh INSERT from ON CONFLICT UPDATE via `xmax = 0`. Works on every PG version we've seen but `xmax` isn't part of PG's documented stable API contract.

**Proposed fix.** Replace with an explicit pre-check `SELECT path FROM agent_file_locks WHERE workspace_id = $1 AND path = ANY($2)` to partition the requested paths into "exists same-owner" vs "exists different-owner" vs "doesn't exist." One extra round trip; one less PG-internals dependency.

**Effort.** 1 hour.
**Where to fold in.** When touching `tryAcquire` for #4 (janitor extraction) — already in the same function.
**Alternative.** Document the `xmax` dependency explicitly in `advisory-lock-keys.md` and accept it. Cheaper; the dependency is real but stable.

---

### #9 — Fix `FileLockQueue` header about sort vs. deadlock-freedom

**Problem.** The header credits the alphabetical-sort step for deadlock-freedom. The sort *isn't* load-bearing for that property — the "no hold while waiting" property is (atomic whole-set acquire means a caller never holds one path while blocking on another). The next engineer reading the header concludes "I must sort my path sets" when porting the pattern; they don't.

**Proposed fix.** Rewrite the header paragraph to explain it correctly. ~5 lines.

**Effort.** 15 minutes.
**Where to fold in.** Either #7 (wiring `reap`) or #11 (the refactor will rewrite headers anyway).

---

### #10 — `tryExtend` type cast

**Problem.** `file-lock-queue.ts:159` — `(handle as { paths: readonly string[] }).paths = ...`. Cosmetic / type-safety; mutates a `readonly` field through a cast.

**Proposed fix.** Two options:
- Drop `readonly` on `LockHandle.paths` (the field is intended to be mutable mid-extend).
- Have `tryExtend` return a *new* `LockHandle` rather than mutating; caller swaps references.

The second is cleaner — handles become immutable; the cast goes away. Slightly more churn at callsites.

**Effort.** 30 minutes.
**Where to fold in.** #11 — the new interface should specify `extend` returns a fresh handle, since SU-locks does (it issues a new `lock_id` on path-set growth). Unifying both implementations on "extend returns new handle" is consistent with the rest of the interface.

---

### #12 — `workspace_id` → `coordination_domain` rename (filed from agent-coordination-architecture-v2 audit S4)

**Problem.** The SU-locks `workspace_id` column does not name what it holds. The lock partition is per-machine / per-coordination-domain, *not* per-Papercusp-workspace — `workspace_id = 'default'` everywhere today (see §1 Non-goals). `agent-coordination-architecture-v2` §13 committed to owning this rename; the audit of that plan (finding S4) found the commitment had slipped — the rename is in no plan's queue. Filing it here so the decision is explicit, not orphaned.

**Real footprint** (audit S4 — *not* cosmetic): the column appears in a PRIMARY KEY, two GIN indexes, the `grant_cascade` PL/pgSQL function signature, and the `LISTEN/NOTIFY` channel name. A rename is a real migration, not a `sed`.

**Tension to resolve first.** §1's non-goal says future-proofing the workspace dimension without a user is overdesign. The rename does *not* add multi-workspace behaviour — it only renames the column to stop implying a Papercusp-workspace scope it does not have. The locks-plan owner should decide: (a) do the rename for naming honesty, or (b) decline it and instead document in `advisory-lock-keys.md` that `workspace_id` is a misnomer for "coordination domain." Either resolves the orphan; option (b) is near-free.

**Effort.** Option (a): ~half a day (migration + handler/index/function updates + the PG-backed locks test suite to verify). Option (b): 15 minutes.
**Where to fold in.** Option (a) belongs with #11 (the structural refactor already rewrites this surface). Option (b) is a standalone doc edit.

---

## §3 Sequencing

Improvements are mostly independent. Real dependencies:

```
  #1 path canonicalization  ─┐
  #7 reap wiring             ├──► #11 shared interface ──► (#10 type cast cleanup folded in)
  #5 owner in response       ─┘                          └─ (#9 header fix folded in)
                                                         └─ (#6 xmax replacement optional)

  #2 OMP enforcement hook   [critical path — resolves OMP per-session identity; see §2]

  #3 visible fail-open      [independent — anytime]
  #4 janitor extraction     [independent; benefits from #6 if doing both]
  #8 FileLockQueue timeout  [independent; small]
```

**Recommended sequence.**

1. **Week 1, day 1** — #5 (1hr), #9 (15min), #8 (1hr). All trivial, all independent. Bundled PR or split — user's call.
2. **Week 1, day 2** — #1 path canonicalization. Half-day. Standalone PR. The canary log-only deploy lives for 2–3 days before flipping to reject; that lag overlaps the next items.
3. **Week 1, day 3** — #7 reap wiring (1hr) + #4 janitor extraction (half-day). Both touch concurrency. Standalone PRs, but adjacent.
4. **Week 1, day 4** — #3 visible fail-open (half-day).
5. **Week 2, days 1–2** — #2: OMP enforcement hook. Two days of build + test + install integration, plus deleting the dead Claude Code shell hooks. Pre-requisites first: verify OMP hook auto-discovery dir, tool input field names, TypeScript module loading constraints.
6. **Week 2, days 3–4** — #11 shared interface. Folds in #6, #9, #10 polish. One day of build, half-day of conformance suite cleanup.

Total: ~2 weeks for the full set. Tier 1 alone (#1, #2, #7) is ~3 days.

**If time-bound to one week** — do #1, #5, #7, #2. That closes the silent correctness gaps and resolves OMP per-session identity. Skip #11; revisit when a third coordinator is on the horizon.

## §4 Verification

What each tier proves when complete.

### Tier 1 verification

- **#1** — E2E §13 (equivalent-paths-collide test) added and passing. README contract section published.
- **#2** — `su-locks-omp-smoke.sh` shows two OMP shells contending correctly: distinct owners, second shell hard-blocked on the held file. The dead Claude Code shell hooks are gone from the tree.
- **#7** — `file-lock-queue.test.ts` includes reap-on-abort test. Lane supervisor termination path verified to call `reap`.

### Tier 2 verification

- **#3** — Manually kill operator while hook is running; observe `~/.papercusp/locks-cache/last-error.json` updates; reload harness page; banner shows.
- **#4** — Run E2E suite 20 times; observe no `statement_timeout` flakes (baseline today: ~2 in 20).
- **#5** — Existing tests assert new `owner` / `owner_label` fields.
- **#8** — `file-lock-queue.test.ts` includes timeout-rejection test.

### Tier 3 verification

- **#11** — Conformance suite passes for both implementations. All call sites typed against the interface, not concrete class (compile-time check).

### System-level acceptance

After all tiers ship:

1. **Two-agent test** (the test we never ran from earlier in this thread): Two OMP terminals, both targeting the same file. Hook-enforced. Verified that B is hard-blocked, not just told. Lock visible in `locks:queue` with both owners correctly distinguished.
2. **Three-coordinator hypothetical**: a developer adding a hypothetical Redis-backed `FileClaimCoordinator` (not in scope, just as a thought experiment) can do so by implementing the interface and running the conformance suite. They don't need to read either existing implementation.
3. **No silent gaps remaining.** The acceptance test for "no silent failures" is the harness page banner: if SU-locks is silently broken, the banner says so. If silently broken means "doesn't even fire" — that's still failure, but it's the irreducible kind (the watchdog has to be watched too; we accept the regress at one level).

## §5 What's explicitly *not* changing

To prevent scope creep during implementation:

- **PG choice.** SU-locks stays on `papercusp_su` embedded PG. No SQLite, no filesystem lockfiles, no Redis.
- **The `Mcp-Session-Id` → `?client=` identity resolution order.** Stays as the server-side fallback chain. The OMP hook (#2) sits *in front of* it — owning identity at the hook layer — but does not replace it for non-hooked callers (curl, direct tool calls).
- **`pg_advisory_xact_lock` per workspace.** Stays. The advisory key (`hashtext('su:'||ws)`) stays.
- **FileLockQueue's in-memory model.** Stays. Persistence buys nothing.
- **Worktree isolation for the harness orchestrator.** Stays. The harness does *not* adopt SU-locks; it doesn't need it.
- **The `papercusp-su.tools.md` playbook**, injected into `~/.omp/agent/CLAUDE.md` only (OMP-only — the `~/.claude` / `~/.codex` / `~/.gemini` injections are dropped). Stays. May get a paragraph added for the #2 OMP hook.
- **Existing tool wire shapes.** `locks:acquire` / `locks:release` / etc. argument names and shapes stay the same. The shared interface is internal; tools translate.

## §6 Open questions for user

Things I want your read on before any code lands:

1. **#2 scope** — the OMP hook adds genuine enforcement for OMP agents (and structurally resolves the per-session identity question). Confirm building it is approved.
2. **#7 option choice** — wire `reap` (recommended), or delete it with an explicit "by design" note? Either is defensible.
3. **#11 build now vs. later** — the shared interface is the highest structural pay-back item but it's also a refactor across many files. Do it as part of this batch, or hold until there's a third coordinator on the horizon?
4. **#3 banner placement** — harness page is the natural location, but if you'd rather the banner live somewhere globally visible (top of every operator page), say so before I commit to harness-only.
5. **Canary period for #1** — propose 2–3 days log-only before flipping path canonicalization to reject. Too short / too long?
6. **PRs per chunk vs. bundled** — Tier 1 splits naturally into 3 PRs. Tier 2 polish (#5, #9, #8) bundles cleanly into one PR. Tier 2 substantive (#3, #4) each get their own. #11 is one PR. Tier 3 polish (#6, #10) fold into #11. Confirm or adjust.
7. **What did I miss?** — this list came from one comparison-doc session. The two-agent live test (never run) would likely surface more. Worth running it *before* starting any of this work, against the pre-improvement codebase, to baseline?

## §7 Risk register

- **OMP hook discovery quirks.** Auto-discovery directory and TypeScript-module-loading constraints are not yet verified. If OMP requires hooks to be plain JS or restricts imports, the #2 hook's complexity goes up. Pre-requisite probe before building (~30 min).
- **#4 janitor race.** Moving the janitor out-of-line introduces a narrow window where a lock looks held but is expired. The path-narrow inline sweep is the mitigation; the test for the boundary case must be tight.
- **#11 missed call site.** Mechanical refactors are prone to missed updates. Mitigation: typecheck must pass, all conformance tests pass against both implementations, plus a grep audit for the old API names after the refactor.
- **#1 hidden caller.** A real agent might be silently relying on non-canonical paths. The canary log-only period is the mitigation.
- **Operator URL discovery.** The OMP hook reads its operator URL from `~/.omp/agent/mcp.json`. If a user has multiple OMP profiles or the config layout changes, the hook breaks. Document the contract; consider a fallback to env var.

---

End of plan.
