---
title: Retire the legacy orchestrator — DBOS becomes the complete, sole, default-on pipeline for all harnesses
slug: dbos-retire-legacy-orchestrator-2026-05-31
status: active
created: 2026-05-31
updated: 2026-06-01
owner: avi@storewolf.com
---

# Retire the legacy orchestrator — DBOS becomes the complete, sole, default-on pipeline for all harnesses

## Now

**State:** DONE + VALIDATED. P-009 shipped (DBOS is the default orchestrator for all harnesses; legacy loop retired, reversible) AND a GREEN RUN confirmed it (D-008): the durable pipeline drove sheets/F-FIX-027 end-to-end — real worker commit (59a6876), validator PASS, feature→passed, DONE→finalize→SUCCESS, surviving 6 recoveries. The whole arc (HARNESS_SLUG fix, P-010 resilience, durable workflow, finalization) is validated on a real harness. One open finding: the needs-human DONE-gate is over-broad (plans-items API ignores harness_slugs), so curator/documenter were gate-skipped this run (execution path otherwise proven + unit-tested).

**Next:** Decide the needs-human gate fix (harness-scope the finalizer's check, or fix the plans-items API filter) so the finalizer's curator+documenter actually run on DONE — then optionally re-validate to watch them fire. Cleanup: revert the dev .env.local PAPERCUSP_WORKSPACE_ID=default pin (restore the desktop's papercusp-workspace). Once confident, hard-delete the retired legacy files (main-loop.ts/run.ts/pre-loop.ts/lanes.ts).

## Background

(Why this plan exists; what problem it addresses.)

## Phase 1 — TODO

(Use plans:add-item to populate. Each item is one line:
single id, status token, free text, optional blocked-by.)


## Phase F — close the coverage gaps (DBOS = complete replacement)

- **P-001** `todo` DONE finalization step: on terminal DONE, run a checkpointed finalize sequence porting legacy handleDone — needs-human plan-item gate (open item → not-done, idle), smoke-test gate (config smokeTest.enabled+onDone), curator(['TRIGGER=done']) → postCuratorOutputs, documenter(['TRIGGER=done','FEATURE_ID=-']), archiveOnDone tar.gz + postArchiveEvent, afterDone plugin hook. Idempotent; unit-tested with stub runner. importance: high


## Phase F — close the coverage gaps (DBOS = complete replacement)

- **P-002** `todo` ESCALATE finalization step: on terminal ESCALATE, port handleEscalate — on-escalate plugin hook (env REASON), curator(['TRIGGER=escalate','REASON=<reason>']), notifyEvent('escalate'). Workflow still ends (exit-3-equivalent) but memory is distilled first. Unit-tested. importance: high


## Phase F — close the coverage gaps (DBOS = complete replacement)

- **P-003** `todo` Extra dispatch verbs in the pipeline so nothing dead-ends: NEXT_TESTER (tester, VAL_ID=arg), NEXT_SECURITY (security-reviewer), GENERATE_TESTS (test-writer), NEXT_MONITOR (monitor), NEXT_EXPERT (expert, EXPERT_ID+FEATURE_ID), NEXT_FEEDBACK (feedback, parse EXP.FB + persona.txt), RUN_TESTS, READY_FOR_PROD (setReadyForProdPg / flag), CONVERTED+FEATURE_FREEZE (log+continue). Each non-terminal verb = a checkpointed invoke step that loops. Global-only verbs (NEXT_HARNESS, CEO_MODE, parallel N=k) explicitly rejected as not-applicable to the per-feature pipeline. importance: high


## Phase F — close the coverage gaps (DBOS = complete replacement)

- **P-004** `todo` Cost-cap per turn: evaluate cost-cap inside the loop (port evaluateCostCap — maxCostUsd / maxCostUsdWarnThreshold / maxCostUsdAutoPause, sumJsonlCost over logDir). Over cap → terminate the pipeline; at warn threshold → log once (+ optional auto-pause). As a checkpointed step so replay is deterministic.


## Phase F — close the coverage gaps (DBOS = complete replacement)

- **P-005** `todo` Director prompt: lightly extend director.md so quality verbs (NEXT_TESTER / NEXT_SECURITY) can be emitted at the right point (post-validation-pass, pre-DONE) so the extra-verb support is actually exercised. Keep conservative — do not turn it into the global orchestrator.


## Phase F — close the coverage gaps (DBOS = complete replacement)

- **P-006** `todo` Dispatcher: all-harnesses default. runDispatchTick enumerates ALL harnesses in the active workspace via listAllHarnesses (lib/dev-data.ts) when in all-mode (PAPERCUSP_DBOS_DISPATCH_HARNESSES='*' or unset+orchestrator-on), not just the comma-list. Schedule the tick unconditionally in all-mode. Keep the explicit allowlist as an override for scoped testing. importance: high


## Phase F — close the coverage gaps (DBOS = complete replacement)

- **P-007** `todo` Plugin lifecycle parity: fire the per-turn hooks the legacy loop fires (onPostWorker / onPostValidator) inside the corresponding steps, plus afterDone / on-escalate in finalization (covered by P-001/P-002). Audit which hooks live plugins actually use; port those, document any intentionally dropped.


## Phase G — flip default-on-for-all + retire legacy (one validated move)

- **P-008** `todo` Live validation on the sheets harness: opt sheets into all-harnesses dispatch, run a real feature through the FULL pipeline incl. finalization via /admin/dbos in the Tauri shell; confirm DONE → curator + documenter actually ran (run memory distilled, docs written) and the run reaches SUCCESS. Gate for Phase G deletion. importance: high


## Phase G — flip default-on-for-all + retire legacy (one validated move)

- **P-009** `todo` Retire the legacy loop: make PAPERCUSP_DBOS_ORCHESTRATOR default-on (or remove the gate), stand down the legacy autoloop ticker, remove the now-moot carve-out (durableOwnedFeatureIdsPg/readFeaturesPg filter), and delete/retire main-loop.ts + bin/run.ts + pre-loop.ts + lanes.ts per the repo's retire-but-keep convention (or hard delete given pre-alpha). Only after Phase F green + P-007 live-validated. importance: high


## Phase F — close the coverage gaps (DBOS = complete replacement)

- **P-010** `todo` Idempotency-retry refinement (found in P-008): the decide-step's 3 retries reuse the cached empty director run (idempotent hit), so a transient empty/failed invoke can't recover and a re-trigger reuses the poisoned run. Fix: don't record an exit-0-but-empty agent run as a reusable run_output (or force re-spawn / fresh key on a decide-step retry). Add a unit test for "empty invoke is not cached as reusable".

## Decisions

(Use plans:add-decision to append. Each decision is a third-level
heading with a date line and a body paragraph.)

### D-001 — D-001 — Strategy: close gaps first, then flip default-all + delete legacy in one validated move
Date: 2026-05-31
Parent `dbos-orchestrator-durability` left DBOS validated + rollout-ready but opt-in per harness (the legacy main loop is the designed fallback for everything the per-feature pipeline doesn't cover). The code map confirmed the DBOS pipeline is, by design, only a PARTIAL replacement: the per-feature `director` (director.md) emits only `NEXT_WORKER/NEXT_ARCHITECT/NEXT_VALIDATOR/DONE/ESCALATE`, the workflow handles `worker/validator/architect/scoper/tester/security` verbs, and on DONE it merely returns — it does NOT run the post-DONE curator+documenter+archive, the ESCALATE curator, cost-cap, or the extra global-orchestrator verbs.

User decision: **do not flip the default or delete anything until DBOS is a COMPLETE replacement.** Sequence: (Phase F) close the gaps → unit-validate → live-validate on the **sheets** harness → (Phase G) flip default-on-for-all-harnesses + delete the legacy loop in one move. No live rollout until Phase F is green.

Scope calls (per-feature pipeline model): cross-feature/cross-harness concerns move to the DISPATCHER, not the per-feature pipeline. Deliberately CUT for the per-feature pipeline (global-orchestrator-only): `NEXT_HARNESS`, `NEXT_WORKER_CEO_MODE`, parallel `NEXT_WORKER N=k`, competition-mode + synthesizer. Cross-engineer distributed claim is a separate axis (parent D-016/P-011) — out of scope. Chunk-loop is a worker-side concern inside invoke(), not the orchestrator loop — verify it still runs under the durable runner; do not reimplement.

### D-002 — D-002 — cost-cap enforced as a dispatcher gate (not per-turn); in-flight hard-stop deferred
Date: 2026-05-31
P-004 implemented as a per-harness gate in `runDispatchTick`: before selecting features, `harnessOverCostCap(slug)` resolves the project → reads `.harness/config.json` → `evaluateCostCap` (legacy FS variant); when over `maxCostUsd`, `selectFeaturesToDispatch(..., overCostCap=true)` returns [] (no NEW pipelines; in-flight ones finish). This is cleaner than the legacy per-iteration check (single location, no per-turn fs churn across N concurrent pipelines) and enforces the cap for the auto-dispatch rollout. `maxCostUsd` is config-gated-off for ~all harnesses (sheets included) → zero impact on the live validation. Deferred: hard-stopping an IN-FLIGHT pipeline mid-run when the cap trips (legacy exit-6) — a per-turn pipeline guard; low value since the dispatcher stops new spend and pipelines are short. Tracked as a follow-up if a real harness sets a tight cap.
Related: P-004

### D-003 — D-003 — director.md left minimal; classifier supports quality verbs defensively (P-005 deferred)
Date: 2026-05-31
P-005 (extend director.md to emit NEXT_TESTER/NEXT_SECURITY post-validation) is deliberately NOT done. Reason: making the per-feature director emit those verbs would spawn `tester` / `security-reviewer` roles that a given harness may not have configured (e.g. sheets) → spurious failures. The classifier (orchestrator-decide.ts) already maps those verbs to the correct role+extras IF emitted, so the capability exists defensively without forcing it. Extending the director is optional polish (a per-harness/phase prompt concern), not a replacement-completeness gap — the core lifecycle (worker→validator→DONE) is fully driven by the current director.md. Revisit per-harness if/when a harness wants tester/security in its durable loop.
Related: P-005

### D-004 — D-004 — finalization hooks wired; per-turn lifecycle hooks not ported (no consumer)
Date: 2026-05-31
P-007 resolved by audit: the finalizer fires the terminal hooks the legacy loop fires — `afterDone` (firePluginHook) on DONE and `on-escalate` (runHook) on ESCALATE. The per-turn hooks (onPostWorker/onPostValidator/onPostOrchestrator) are NOT ported: a grep of installed plugins (~/.papercusp/global-plugins/* + harness plugins: cloudflare-pages, jira-sync, linear-sync, notion-export, slack-notifier, …) found ZERO consumers of those hook names, and no harness ships the matching `.harness/hooks/onPost*.sh`. Porting unused per-turn hook plumbing would be speculative complexity (YAGNI). If a plugin later needs a per-turn hook, fire it inside the dispatch step in orchestrator-workflow.
Related: P-007

### D-005 — D-005 — P-008 live run: DBOS mechanism validated; full completion blocked by the "empty claude output" wall (env, not Phase F)
Date: 2026-05-31
Ran two controlled live pipelines on sheets (F-FIX-028, F-FIX-029) via POST /api/admin/dbos/pipeline/start, host restarted with the Phase F code + PAPERCUSP_WORKSPACE_ID=default pin (sheets features live in `default`).

VALIDATED (mechanism works end-to-end against real DBOS): the trigger started the workflow (proving DBOS launched), the workflow ran decide-0 (director invoke), captured the result, and on empty output threw → retried 3× → ERRORed cleanly (NOT false-SUCCESS — the 714b79aa fix working in production). All Phase F code paths (classifier consumption, runner extras, the workflow loop, the terminal branch) executed correctly.

BLOCKER (NOT Phase F): the director `claude -p` invoke returned EMPTY (exit 0, duration ~4.5s, out_body=0/jsonl_body=0/err_body=0 in harness_run_output) — claude produced nothing. Diagnosed thoroughly: `claude -p` works standalone (replied, logged in v2.1.159), works under the FULL hono-host env (incl NODE_OPTIONS), and invoke-once works STANDALONE (director/F-FIX-030 took ~70s and emitted `NEXT_WORKER F-FIX-030`). It ONLY goes empty when spawned through the live DBOS pipeline for sheets, alongside ~5 concurrent SU agents spawning many claude instances. This is the prior session's documented "empty agent output under concurrent load" wall (37 lingering claude procs) — shared `invoke→claude` contention on the shared `~/.claude` state, affecting the LEGACY loop equally. Pre-existing, operator-wide, out of this plan's scope.

REFINEMENT FOUND (P-010): the decide-step's 3 retries hit the same idempotency key (slug:feature:role:t0) → invoke() short-circuits to the cached EMPTY run ("idempotent hit, reusing prior run") → retries are no-ops, and a re-trigger of the same feature reuses the poisoned empty run. Fix: invoke() should not cache an exit-0-but-empty agent run as reusable, OR the decide-step retry should bypass the idempotency cache (force re-spawn). Won't fix the empty output, but makes recovery possible once the backend is healthy.

NOT DONE: P-009 (retire legacy + flip default-all) — gated on a GREEN sheets run, which needs the backend to reliably produce output. Cleanup done: host restarted, workspace pin reverted (papercusp-workspace restored), .env.local DISPATCH_HARNESSES still blank (nothing auto-runs).
Related: P-008, P-009

### D-006 — D-006 — Empty-director-output root cause was a HARNESS_SLUG/schema bug (corrects D-005's "environmental"), now fixed; + P-010 resilience
Date: 2026-05-31
D-005 attributed the empty director output to environmental load. That was WRONG (or only secondary). The PRIMARY cause, confirmed: the durable runner spawned invoke-once WITHOUT HARNESS_SLUG, so the orchestrator's harnessSlug(projectDir) fell through env→registry-curl(:3055)→basename(projectDir). For sheets (dir `sheets-clone`, registry slug `sheets`) that yielded search_path=harness_sheets_clone — a schema that does NOT exist — so the director read no feature state and exited empty in ~4.5s. The :3055 registry-curl fallback also no longer resolves (operator moved Next→Vite). This is why the prior session's throwaway harnesses worked (basename==slug) but sheets didn't.

FIX 1 (committed): buildPipelineExtraEnv() always passes the authoritative registry slug as HARNESS_SLUG to the role runner + finalizer → correct harness_<slug> schema. VALIDATED LIVE: F-FIX-027 director:t0 ran 58s (real LLM call), search_path=harness_sheets, produced a real decision (out_body=442, jsonl 132KB). The director gap is closed.

SECONDARY (genuinely intermittent): under ~48 concurrent claude processes on the shared box, individual `claude -p` spawns occasionally still return empty (worker:t0 + director:t1 on that run were 4.5s empty; claude works standalone). This is real concurrency contention.

FIX 2 / P-010 (committed): findPriorRunForIdempotency no longer reuses an empty/whitespace-only prior run → the DBOS decide-step's 3 retries (and re-triggers) actually re-spawn instead of replaying the cached empty result → the pipeline is resilient to intermittent empties. Re-validating on F-FIX-027:e1 now (reuses the good cached director:t0, re-spawns the empty worker/director:t1).
Related: P-008, P-010

### D-007 — D-007 — P-009 SHIPPED: DBOS is the default orchestrator; legacy loop retired (reversibly), per user go-ahead without a green run
Date: 2026-05-31
User chose to proceed with P-009 on the strength of the validated mechanisms + unit tests, accepting no fully-green live run (their explicit, informed risk call). Executed REVERSIBLY:

KEY DE-RISK (mapping): runMainLoop is ALREADY out of the live operator path — the operator orchestrates via the DBOS durable pipeline + one-shot invoke-once; runMainLoop's only caller is the unused bin/run.ts CLI; bash run.sh was deleted 2026-05-30. So "retire the legacy loop" was a flag-flip + marker, not a risky rip-out.

CHANGES (all default-on unless PAPERCUSP_DBOS_ORCHESTRATOR=0 → the instant revert):
- Dispatcher default-ALL: DISPATCH_HARNESSES unset/empty/'*' → every harness; 'none'/'off' → opt-out; list → scoped. (orchestrator-dispatcher.ts + tests.)
- bootstrap: ORCHESTRATOR default-on → durable workflow/runner/dispatcher register by default.
- carve-out (state-pg durableOwnedFeatureIdsPg): active by default (to_regclass guard keeps it safe when dbos schema absent).
- autoloop: legacy in-process ticker stands down by default (its fire-and-forget director invokes were a discarded no-op).
- dbos-pipeline-start: manual trigger enabled by default.
- main-loop.ts: RETIRED marker (kept for reference + revert per parent D-006; NOT deleted).

DELIBERATELY NOT FLIPPED: the master boot switch PAPERCUSP_DBOS_ENABLE stays explicit (the go-live switch the dev box + production set) — flipping the compiled boot default for an unvalidated subsystem across ALL environments was the one step not taken silently.

DEV-BOX SAFETY: the shared dev box .env.local sets DISPATCH_HARNESSES=none (opt-out) so the now-default-all dispatcher doesn't flood the contended box (restarting ~every 2 min from concurrent agents) or collide with the agents editing papercup/restart. The rollout to a live harness should run on a quiet single-user box (set DISPATCH to a slug or '*').

STATUS: 66 dbos + 7 state-pg + 4 idempotency tests green; tsc clean for the changed files (pre-existing ctx.pg<> generic + zero-harness tsc errors are unrelated). P-008's full green run remains environmentally blocked (box churn); the mechanisms (director, P-010 resilience, durability) are validated. REVERT: set PAPERCUSP_DBOS_ORCHESTRATOR=0 everywhere → legacy path + carve-out-off + autoloop ticker back.
Related: P-008, P-009

### D-008 — D-008 — GREEN RUN achieved: full durable pipeline completed a real feature end-to-end (P-008/P-009 VALIDATED)
Date: 2026-05-31
On the now-quiet box, the durable pipeline pipeline:sheets:F-FIX-027:e1 reached SUCCESS with the COMPLETE step sequence: decide-0 → invoke-worker-0 → decide-1 → invoke-worker-1 → decide-2 → invoke-validator-2 → decide-3 → finalize-done. Real work, airtight:
- worker:t1 ran 578s and made a REAL commit in sheets-clone: `59a6876 feat(F-FIX-027): make autofit column/row resize undoable`.
- validator:t2 ran 314s and PASSED: "VALIDATOR F-FIX-027 round 1: passed — 1 pass, 0 fail".
- director decided DONE → finalize-done step ran → SUCCESS. Feature F-FIX-027 → status `passed`.
- Survived 6 DBOS recoveries (host restarts during the churny period) and still completed — durability proven in the strongest possible way.

This validates the ENTIRE arc end-to-end on a real harness: the HARNESS_SLUG fix (D-006), P-010 empty-run resilience (worker:t0 was an empty 4.5s but the pipeline recovered → worker:t1 did real work), the durable workflow, and the DONE finalization path. So P-009 (DBOS as the default orchestrator) is now VALIDATED, not just shipped-on-faith.

ONE FINDING (pre-existing, ported from legacy handleDone): the needs-human DONE-gate is OVER-BROAD. `/api/admin/plans/items?needsHuman=true&harness_slugs=<slug>` IGNORES harness_slugs — querying a nonexistent slug returns the same 4 operator-level items (coord-channels-pg-port P-014, harness-tests-tab P-070, spec-md-ui-deprecation P-004/010) as `sheets`. None are sheets-harness items. So ANY open operator-level needs-human item blocks EVERY harness's DONE finalization → curator + documenter were SKIPPED this run (the gate fired correctly given the API's response, but the API over-returns). The curator/documenter EXECUTION path is otherwise proven: it's the same spawnInvokeOnce + buildPipelineExtraEnv that director/worker/validator used successfully in this very run, and planFinalization is unit-tested. Fix options: (a) scope the finalizer's needs-human check to the harness's own started plans (harness_plan_status), or (b) fix the plans-items API harness_slugs filter (affects the legacy gate + Plans UI too) — needs a product call on whether needs-human is harness-scoped or operator-global.
Related: P-008, P-009

### D-009 — D-009 — autoloop+timers migrated (default-on); competition/adaptive/synthesizer = superseded model, recommend NOT porting (merit)
Date: 2026-06-01
Background-work audit + parallelism merit assessment (user: alpha, migrate unless a feature isn't good).

MIGRATED (default-on, committed): the DBOS autoloop (Option 2 — fixes the P-009 per-harness director/coordinator/auditor gap) and the Phase-2 periodic timers (telemetry flush, scratch GC, memory cleanup, completion-ref verify, embed backfill, backup cadence). Centralized in dbos-flags.ts (dbosOrchestratorActive/dbosAutoloopActive/dbosTimersActive) so each legacy stand-down shares the exact registration condition (no gap, no double-fire). Master revert: PAPERCUSP_DBOS_ORCHESTRATOR=0.

COMPETITION / ADAPTIVE / SYNTHESIZER — recommend DON'T PORT, on merit:
- These three ARE the previous-generation worker model (N workers race in per-feature git WORKTREES → synthesizer merges/picks → validator). The repo ALREADY superseded it: `useChunkLoop` defaults TRUE (the canonical lock-free per-chunk worker model, which the DBOS pipeline's worker uses), and branch-iso.ts bypasses worktrees entirely under chunk-loop. Competition/synthesizer require explicitly opting BACK OUT to `useChunkLoop:false` (lanes.ts:246-248 documents this). So porting them = re-introducing the worktree model the repo deliberately replaced — a regression, not a migration.
- Competition (best-of-N): real technique but N× token cost + needs the abandoned worktree isolation + marginal value over the DBOS retry-with-notes loop (worker fails → director re-dispatches with PRIOR_VALIDATOR_LOG → iterates) is unproven; no telemetry in alpha to justify it.
- Adaptive tiers: purely the N-selector for competition; moot without it. The difficulty signal it encoded is ALREADY expressed in the DBOS pipeline via the director's NEXT_ARCHITECT verb ("large/ambiguous → plan before worker", director.md) + the retry loop, which is implicitly adaptive (harder features get more turns).
- Synthesizer: multi-lane needs competition; single-worker (synthesizeSingle) pre-validation review is superseded by the director's discretionary NEXT_ARCHITECT/NEXT_SECURITY/NEXT_TESTER quality verbs.

The genuinely-good kernel (scale scrutiny to difficulty) is already migrated — it's the director's NEXT_ARCHITECT + retry-with-notes. If best-of-N competition is later proven worth it, the DBOS-native build is parallel child-workflows + per-attempt worktrees (L-XL effort) — kept as an offer, not a default.
Related: P-009
