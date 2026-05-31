---
title: Retire the legacy orchestrator — DBOS becomes the complete, sole, default-on pipeline for all harnesses
slug: dbos-retire-legacy-orchestrator-2026-05-31
status: active
created: 2026-05-31
updated: 2026-05-31
owner: avi@storewolf.com
---

# Retire the legacy orchestrator — DBOS becomes the complete, sole, default-on pipeline for all harnesses

## Now

**State:** Phase F (close the coverage gaps) is essentially COMPLETE + committed: P-001/P-002 finalization (curator/documenter/archive/afterDone on DONE; on-escalate+curator on ESCALATE) via a pure planFinalization + injected executor; P-003 full verb coverage via pure classifyDecision (fixed NEXT_SECURITY→security-reviewer; global-only verbs→unsupported); P-006 all-harnesses dispatch via '*' + listAllHarnesses; P-004 cost-cap as a dispatcher gate (D-002). P-005 (director prompt) + P-007 (per-turn hooks) resolved as deliberate no-build decisions (D-003/D-004). 58 dbos unit tests green, tsc clean. Live rollout levers still untouched (DISPATCH_HARNESSES blank).

**Next:** P-008: restart papercup-dev-api to load the new lib/dbos code (no hot-reload), then controlled live validation on the sheets harness — manually trigger ONE sheets feature via POST /api/admin/dbos/pipeline/start and watch it reach DONE → curator + documenter → SUCCESS in /admin/dbos. Gate for P-009 (flip default-all + delete legacy).

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
