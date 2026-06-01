# Handoff brief — `dbos-system-completion-2026-06-01`

You are taking over execution of plan **`dbos-system-completion-2026-06-01`** (DBOS
system completion: fill the non-cut capability gaps, wire-or-cut the dead roles,
true up prompts to code). All Phase-1 decisions are already made by avi — you are
**executing**, not deciding scope.

**Read first:** `plans:get { slug:'dbos-system-completion-2026-06-01', harness:'all' }`
(or `apps/operator/docs/plans/dbos-system-completion-2026-06-01.md`) — especially the
`## Now` block (cold-resume anchor) and decisions **D-001…D-016**. The governing
directive: **preserve every legacy capability EXCEPT the cut list in D-REF**; any
other legacy↔DBOS delta is a gap to FILL or a prompt to make accurate.

---

## ✅ Done this session (committed + verified — do NOT redo)

| Item | Commit(s) | What | Verified |
|---|---|---|---|
| **P-005** | `4326d4d9c` | `spawnInvokeOnce` captures child **stderr**, surfaces on non-zero exit (`formatInvokeStderr`) — throw-before-run was invisible | 8/8 |
| **P-006** | `75554fca8` | early end-to-end smoke gate `apps/operator/test/dbos-happy-path-smoke.integration.test.ts` (real-PG D-008 regression: `readFeaturesPg` source_plan gating + `readPlan` legacy-files decode; + decision-loop wiring + finalize) | 5/5 |
| **P-016** | `ce9ea4b2d` | rename DBOS dispatcher → orchestrator (`orchestrator-dispatcher.ts` → `orchestrator-loop.ts`) | 69/69 + 5/5 |
| **P-040** | submodule `34a2cd0`, parent `1112f7092` + `4be85585b` + `22d8a6741` | conflict-safety floor, **fully done in 3 parts** (see below) | locks 77+31, chunk-loop 39, recovery 6, coordinator 15, smoke 5 |

### P-016 naming note (so you don't "fix" it)
I applied a principle: **the component is the "orchestrator"; "dispatch" survives only
as a verb.** So `runDispatchTick`→`runOrchestratorTick`, workflow/env/log names became
"orchestrator", but **`selectFeaturesToDispatch`, `dispatchOneHarness`,
`refillHarnessOnSettle` kept their verb names** (`selectFeaturesToDispatch` is the one
**P-042 rewrites wholesale** anyway). Env: `PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES` is
primary, `PAPERCUSP_DBOS_DISPATCH_HARNESSES` still accepted as a back-compat alias.

### P-040 — what landed (3 parts)
1. **Relocation:** `@papercusp/locks` moved from the parent `packages/locks` **into the
   `libs/papercusp` submodule** (`libs/papercusp/packages/locks`, next to `file-claim`,
   its only dep) so `@papercusp/orchestrator` can depend on it intra-submodule.
2. **D-015 (file-lock domain fix):** the live `locks:*` `coordinationDomain` is now the
   **canonical repo root (realpath), NOT `workspaceId`** — file locking is a physical-file
   concern (`apps/operator/lib/agent-tools/locks/coordination-domain.ts`,
   `identity.ts`). Fixes the in-spec multi-workspace-same-harness clobber AND unifies
   workers ↔ SU agents.
3. **Worker wiring:** chunk-loop `FileLockQueue` → `FileClaimCoordinator`;
   `invoke-once.ts` builds the coordinator (default in-process `FileLockQueueCoordinator`;
   when `PAPERCUSP_CHUNK_LOCK_PG=1` + `DATABASE_URL` → PG `SuLocksCoordinator` keyed by
   `realpath(repoPath)`). Gate set in `buildPipelineExtraEnv` (pipeline spawns only).

> ⚠️ **D-015 + the worker-PG behavior go LIVE only at the next `:3070` restart** (no
> hot-reload). Until then the running operator uses the old workspace-keyed domain. The
> cutover is atomic (all callers + the PreToolUse hook switch together on restart).

---

## ⏳ Outstanding (recommended order — nothing dropped)

> Phase-1 dispositions are **already decided** (D-002/003/004/005/007) — just execute.
> Re-run the **P-006 smoke gate** after each Phase-2 fill (the plan requires it).

1. **P-011 — FILL CONVERT_ISSUES** (next; parent-only; **read D-016 — it has the full design**).
   Deterministic sweep in `orchestrator-loop.ts` (`dispatchOneHarness`, after
   `readFeaturesPg`, own try/catch) that promotes open `critical`/`major` issues with no
   `linkedFeatureId` to `F-FIX` features. **Key constraints (D-016):** `issues.json` is
   **canonical** (PG is a mirror) → MUST go through the canonical promote path (HTTP
   self-call to the promote route, or extract its inline logic to a function) — **NOT
   raw-SQL on `harness_issues`**. Set `metadata.source_plan` (inherited from the parent's
   `metadata->>'source_plan'`), NOT a `source_plan_slug` column (consolidated-only).
   Idempotency = an **in-process per-harness mutex** (the 30s-tick + on-settle double-fire
   are in ONE operator process). **Confirm the live promote route path** first
   (`issues.ts:277` vs the note at `issues.ts:10` pointing to `_hono/harness.ts`).
   Unit-test the double-fire. blocked-by P-006 (done).
2. **P-012 — FILL debugger-before-worker.** In the worker dispatch step
   (`orchestrator-workflow.ts`), when `attempts ≥ debugger.threshold` AND
   `!existsSync(.harness/debug/<fid>.md)`, fire the read-only `debugger` before `worker`
   (port `main-loop.ts:1059-1097`). **IDEMPOTENCY (D-014): the guard-check + the invoke
   must live in the SAME durable DBOS step** (else a partial replay re-fires). blocked-by
   P-006 (done).
3. **P-046 — `blocked_by` as a first-class field.** Real import field + column on
   `harness_features` (+ consolidated) + `order`; resolve refs→canonical ids at import
   (reject unresolvable loudly); Kahn cycle-detect at import. Import shape:
   `features.ts:364-375`. **Note:** `source_plan_slug` is consolidated-only — decide
   column-vs-metadata for the new fields the same way. Shared prereq for P-042/P-043.
   blocked-by P-016 (done).
4. **P-041 — promote-time parallelism.** Extend `plans:promote` (`promote.ts`) so the
   promoting agent declares wave/parallelism grouping; write the realized shape back into
   the plan's `## Promoted`. blocked-by P-016 (done).
5. **P-042 — frontier dispatch.** Replace `selectFeaturesToDispatch` (the kept name) with
   a single-pass frontier: `terminal={passed,deprecated}`; `ready=NEEDS_WORK where
   blocked_by ⊆ terminal`; group by plan; order groups by `harness_plan_status.priority`
   then `(metadata.order ASC NULLS LAST, feature_id)`; fill greedily to `cap − liveCount`.
   Edge cases: missing `blocked_by` id → treat satisfied + log; a `failing` blocker is
   non-terminal. blocked-by P-016 (done), P-041, P-046.
6. **P-043 — deterministic `for_each` resolver.** Named query resolver (glob/grep/AST/SQL/
   jq), promote-time or completion-time. Completion-time hooks the finalizer
   (`orchestrator-finalize.ts:79-87`) — add an `expand-generators` step, **idempotent
   (dedup on `generated_by`)**. NO generator LLM (semantic discovery → expert path).
   blocked-by P-042.
7. **P-044 — retire the 30s wave poll.** Re-run the frontier on the settle hook; retire
   `wave-advance-sweep-live.ts` + the wave-cursor lazy-creation. **PRESERVE (D-014):** the
   settled-hook fires **only on `done`** (`orchestrator-workflow.ts:202-209`) → a long
   backstop must cover `escalate`/`idle`; and keep an equivalent of the `onBlocked`
   stuck-wave `I-WAVE-*` signal. blocked-by P-042, P-043.
8. **P-045 — plan-priority drag UI.** Add `priority int` to
   `harness_shared.harness_plan_status` (migration). Plans page: drag-reorder started
   plans persisting `priority` (PG state, **not** useState) + a hint. Verify in the **Tauri
   shell** (testing docs). blocked-by P-042.
9. **P-013 — WIRE crosscheck** (decided, default-off). `NEXT_CROSSCHECK` verb
   (`DECISION_VERBS` + `orchestrator-decide.ts` classifier → `dispatch role:'crosscheck'`),
   post-validator-PASS different-model second opinion; on disagree revert `passed`→`failing`
   + requeue. Consumer-bar: only once a real harness has observed validator
   false-positives. blocked-by P-001/P-006 (done).
10. **P-014 — WIRE ui-qa** (decided). `NEXT_UI_QA` + classifier → `dispatch role:'ui-qa'`,
    double-gated on a `VAL-UI-*` claim AND `config.json uiQa.enabled`. blocked-by
    P-001/P-006 (done).
11. **P-015 — CUT project_manager + summarizer** (decided). Remove the prompts
    (**`libs/papercusp/packages/harness/prompts/` = SUBMODULE → owner-sync**), their
    `AGENT_ROLES` entries (`packages/agent-mcp/src/role-config.ts`), and `.tools.md`/
    `.persona.md`/registry refs. Grep-confirm zero dispatch. **Do NOT** touch the
    `projects.spec` PG column or `experts:spec_get`. blocked-by P-001 (done).
12. **P-017 — CUT pre-loop** (decided). Remove reviewer `MODE=plan` + scoper `MODE=initial`
    as live behaviors + from `reviewer.md`/`scoper.md` (submodule). The legacy `pre-loop.ts`
    stays for the `=0` revert. blocked-by P-002 (done).
13. **Phase 3 — prompt trueup (P-020…P-027).** P-020 director.md (reconcile the debugger
    claim with P-012). P-021 orchestrator.md merge-then-`git mv` to `_archived/` (verb-strip
    per **D-014** — only `NEXT_HARNESS`/`NEXT_WORKER_CEO_MODE`/`N=`/`CONVERTED`/
    `NEXT_PROJECT_MANAGER` are actually in the prompt). P-022 scoper/reviewer rewrite
    (**`MODE=cleanup` IS reachable — keep it**; `MODE=consolidate` is dormant;
    `SCOPER_PHASE` was bogus, dropped). P-023 documenter DONE no-op (`FEATURE_ID=-`). P-024
    monitor prompt-resolution (confirm-only). P-025 delete `plan-gate.md` (it's a full copy
    of reviewer.md — sequence **after** P-022). P-026 minor-drift sweep (parallel, no dep).
    P-027 scoper `:3055`→`:3070` verify. **Most prompts are in the submodule.**
14. **P-030 — behavioral verify.** Spot-run a real harness pipeline turn (testing docs
    `/internal/docs/testing` + agent-e2e) — the comprehensive end check. blocked-by ~all.

---

## 🔴 External action pending (not mine to do)
**Submodule owner-sync push:** `cd libs/papercusp && git push origin main` — pushes through
**`34a2cd0`** (the locks relocation + P-040 worker wiring). The parent pin (`4be85585b`)
references it; a fresh clone / CI won't resolve until it's pushed. (I commit submodules but
don't push — flagged via `coord` twice.)

---

## Environment guardrails (read before editing)
- **Work on `main`, commit EVERY turn** with `git commit --no-verify`. **Don't push.
  Don't branch/worktree. NEVER `git stash`** (a failed/empty `stash push` makes a later
  `pop` grab another agent's stash — I hit this; recover with `git checkout HEAD -- <file>`;
  to check pre-existing failures use `git show HEAD:path`). Scope submodule commits to your
  own files (others have in-flight edits to `curator.md`/`validator.md`/`plugins/*`).
- **`libs/papercusp` is a submodule** (`github.com/Papercusp/papercusp.git`). Edits there =
  submodule commit + parent pointer bump + flag the owner to push.
- **`:3070` Hono host has NO hot-reload.** Restart to pick up `lib/**` edits
  (`systemctl --user restart papercup-dev-api.service`, or Tauri reload). Probe where your
  write lands before trusting a result.
- **`npm install` is broken repo-wide** (`workspace:*` on agent-mcp). For a package
  relocation, manage `node_modules/@papercusp/<name>` symlinks by hand (that's how P-040's
  relocation works at runtime).
- **File locks** are enforced by a `PreToolUse` hook (auto per-edit). Hand-call
  `locks:acquire` only for a multi-file change held across the commit.
- **Tests — 4 homes:** Vitest (`<pkg>/lib/**/*.test.ts`), Playwright
  (`apps/operator/e2e/*.spec.ts`), Cargo, LLM scenarios. **Integration** tests run via
  `npx vitest run --config vitest.integration.config.ts <file>` from `apps/operator`
  (needs Docker). **Re-run the P-006 smoke gate after each Phase-2 fill.**
- **App is the Tauri desktop** — never open `:3055`/`:3070` in a browser; verify UI in the
  Tauri shell per the testing docs.
- **Plan bookkeeping:** update item status as you go
  (`plans:set-status { slug, harness:'all', itemId, status, note }`), keep `## Now` current
  (`plans:set-now`), record material findings as decisions (`plans:add-decision`).

## Memory guardrails worth knowing (already saved)
`never-git-stash-shared-tree`, `npm-install-broken-workspace-protocol`,
`packaged-tauri-build-viable`, `shared-tree-commit-arg-order`,
`live-verify-papercup-ui-via-tauri-bridge`.
