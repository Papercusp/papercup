---
title: DBOS system completion — fill non-cut capability gaps, wire-or-cut the dead roles, true up prompts to code
slug: dbos-system-completion-2026-06-01
status: draft
created: 2026-06-01
updated: 2026-06-01
owner: avi@storewolf.com
---

# DBOS system completion — fill non-cut capability gaps, wire-or-cut the dead roles, true up prompts to code

## Now

**State:** Draft — the synthesis of a full code-grounded audit of the legacy harness system (design soundness + prompt↔code fidelity, 2026-06-01) against the live DBOS engine. This **supersedes and absorbs** `dbos-pipeline-prompt-reconciliation-2026-06-01` (its orchestrator.md / pre-loop / CONVERT_ISSUES items are folded in as D-001/Phase 2/3). The audit found the DBOS migration is sound in its core (per-feature durable pipeline + chunk-loop worker are real improvements over the legacy global LLM-per-iteration loop), but it is **incomplete** in three ways this plan closes:
1. **Engine-parity gaps** — legacy capabilities NOT on the intentional cut list that DBOS silently dropped (pre-loop, CONVERT_ISSUES, debugger-before-worker).
2. **Designed-but-unwired roles** — 6 roles fully specified at the prompt layer with zero dispatch path in *either* engine (project_manager, crosscheck, ui-qa, summarizer, synthesizer, orchestrator-in-DBOS).
3. **Prompt↔code drift** — ~10 places where a live role's prompt misdescribes the actual contract (monitor has no prompt file, documenter's DONE call no-ops, reviewer's stdout-vs-file gate, scoper's dead modes, etc.).

**Governing directive (avi, 2026-06-01):** PRESERVE every legacy capability EXCEPT the ones the retire plan (`dbos-retire-legacy-orchestrator-2026-05-31`) explicitly records as intentional cuts. The **cut list** (D-REF below) is authoritative; any other legacy↔DBOS delta is a gap to FILL or a prompt to make accurate — never a new silent deprecation.

**Next:** human decisions on the wire-or-cut calls (D-002 the 6 dead roles; D-003 pre-loop; D-004 CONVERT_ISSUES; D-005 debugger-before-worker; D-006 orchestrator.md fate). Engine-parity items (Phase 2) gate the prompt-accuracy items (Phase 3) — a prompt can't truthfully describe a capability until it exists.

## Background — the audit verdict (FACTS, code-cited)

**Live engine:** DBOS durable per-feature pipeline (`apps/operator/lib/dbos/orchestrator-workflow.ts`, default-on since retire-plan P-009). Dispatcher (`orchestrator-dispatcher.ts`, 30s tick + on-settle refill) selects features in pure code (`selectFeaturesToDispatch`); per-feature decisions are made by the **`director`** role (`director.md`, 47 lines — accurate). The legacy `main-loop.ts` is RETIRED (revert via `PAPERCUSP_DBOS_ORCHESTRATOR=0`). Worker runs the chunk-loop via `run-worker-chunk-loop.ts` (shared by both paths since 2026-05-31).

**Design verdict (JUDGMENT):** DBOS is a genuine improvement, not a lateral move — it pushed deterministic cross-feature *selection* into code and reserved the LLM for the one ambiguous call (per-feature next-step), gaining crash-recovery + failure-isolation the legacy loop lacked. The legacy global loop's LLM-per-iteration (incl. no-op `IDLE`/`CONVERTED`/`FEATURE_FREEZE` verbs) was its weakest axis. So: complete the DBOS system; do not resurrect the legacy loop's structure.

**The cut list (intentional, from retire-plan D-001/D-009/D-012, recorded here as D-REF):** `NEXT_HARNESS`, `NEXT_WORKER_CEO_MODE`, parallel `NEXT_WORKER N=k` lanes; competition / adaptive-tiers / synthesizer (flag-gated behind FLAGS.TESTING, not deleted, per retire-D-011). Everything below is NOT on that list.

## Phase 1 — Decisions (wire-or-cut gates; needs-human)

- **P-001** `needs-human` Disposition of the 6 designed-but-unwired roles (see D-002): for each of `project_manager`, `crosscheck`, `ui-qa`, `summarizer`, `synthesizer`, and `orchestrator`(-in-DBOS) — decide WIRE (add a dispatch path) or CUT (remove prompt + AGENT_ROLES entry). These have a prompt + (mostly) an AGENT_ROLES entry but ZERO live dispatch in either engine. Per the directive they aren't "deprecated capabilities" (they never ran) — but leaving them as live-looking prompts is the worst state. Recommendation per role in D-002.
- **P-002** `needs-human` Pre-loop disposition (see D-003): the scoper-`MODE=initial` auto-populate + reviewer-`MODE=plan` gate are legacy-only, NOT on the cut list. FILL (DBOS pre-loop) or consciously CUT (declare plans:promote the sole ingestion path → then it joins the cut list). Recommendation: split — the plan-review gate has no replacement (fill it); the scoper-auto-populate is arguably already superseded by plans:promote (your call to make it an explicit cut).
- **P-003** `needs-human` CONVERT_ISSUES disposition (see D-004): global open-critical/major-issue → F-FIX promotion. Confirmed NOT covered by the DBOS autoloop (it fires per-feature `director`, not a global issue-scanner). Not on the cut list. FILL (a dispatcher/autoloop issue-scan step) or CUT (declare issue→feature human/agent-explicit only). Recommendation: fill as a dispatcher sweep.
- **P-004** `needs-human` debugger-before-worker disposition (see D-005): `director.md` claims "the substrate fires the debugger automatically before the worker once attempts ≥ 3" — the LEGACY loop did this; the DBOS path does NOT (it dispatches `worker` only). Not on the cut list. FILL (auto-fire debugger in the DBOS worker dispatch when attempts≥threshold) or correct the prompt. Recommendation: fill — it's a real quality mechanism and the prompt already promises it.

## Phase 2 — Engine-parity track (FILL the non-cut gaps) — gated on Phase 1

- **P-010** `todo` If D-003=fill: DBOS pre-loop — on a harness whose started-plan features exist but the initial plan was never scope/review-gated, run reviewer `MODE=plan` (gate) and, if a non-plan harness has an empty queue, scoper `MODE=initial`. Port the `pre-loop.ts` logic into the dispatcher path; idempotent + checkpointed; a reject blocks dispatch (legacy exit-7 equivalent). Unit-tested. blocked-by: P-002
- **P-011** `todo` If D-004=fill: global issue→feature conversion under DBOS — a dispatcher (or autoloop) sweep that scans `harness_issues` for open critical/major issues with no `linkedFeatureId` and promotes each to an F-FIX feature (reusing the existing `/issues/:id/promote` logic, which today is human-only). Matches legacy orchestrator decision D. Unit-tested. blocked-by: P-003
- **P-012** `todo` If D-005=fill: debugger-before-worker under DBOS — in the worker dispatch step, when `attempts ≥ debugger.threshold` (default 3) and no debug note exists, fire `debugger` before `worker` (port `main-loop.ts:1060-1097`). Idempotent (the existsSync(debugNote) guard). Unit-tested. blocked-by: P-004
- **P-013** `todo` If any of P-001's roles = WIRE: add the dispatch verb(s) + classifier case(s) in `orchestrator-decide.ts` and a director-prompt trigger, per the D-002 decisions. E.g. crosscheck → a post-validation-pass dispatch; ui-qa → gated on VAL-UI-* + uiQa.enabled; project_manager → a post-feature-pass trigger. One sub-item per role wired. blocked-by: P-001

## Phase 3 — Prompt-accuracy track (true up to code; gated on the parity fills)

- **P-020** `todo` `director.md`: confirm against `orchestrator-decide.ts` it emits only dispatch-classified verbs; reconcile the "debugger fires automatically before worker" claim with P-012's outcome (true if filled, remove if not); surface the preserved quality verbs (`NEXT_TESTER`/`NEXT_SECURITY`) at the right point WITHOUT forcing a role a harness lacks (heed retire-D-003). blocked-by: P-012
- **P-021** `todo` `orchestrator.md` per D-006: merge its still-true GLOBAL heuristics (issue-conversion criteria → feeds P-011; escalation judgment) into the appropriate live surface, strip the cut verbs (`NEXT_HARNESS`/`CEO_MODE`/`N=`) and the no-op verbs (`IDLE`/`CONVERTED`/`FEATURE_FREEZE`/`READY_FOR_PROD`/`RUN_TESTS`), drop the false `NEXT_PROJECT_MANAGER` section, then `git mv` to `prompts/_archived/` (preserved for the `=0` revert, out of the live load path). blocked-by: P-001
- **P-022** `todo` `scoper.md` / `reviewer.md`: rewrite to describe the ACTUAL DBOS flow per P-010's outcome (the pre-loop as it really runs, or its explicit removal). Remove the undispatchable `MODE=cleanup` / `MODE=consolidate` modes (no engine trigger) and fix the `NEXT_SCOPER phase2`→`SCOPER_PHASE=phase2` env-var mismatch (prompt documents only `MODE=`). Fix reviewer's stdout-vs-file gate language (the harness reads `.harness/plan-review.md`, not stdout). blocked-by: P-010
- **P-023** `todo` `documenter.md`: fix the DONE-finalization no-op — the terminal call passes `FEATURE_ID=-`, which the prompt's own "confirm status is passed, else exit silently" rule makes a guaranteed no-op every DONE. Either make the consolidate-mode call signature real (and the prompt handle it) or correct the finalizer + prompt to match. blocked-by: P-001
- **P-024** `todo` `monitor`: resolve the missing prompt file — `NEXT_MONITOR` dispatches `role:'monitor'` but there's no top-level `monitor.md` (only `production/monitor.md`); confirm phase-resolution actually finds it, else a monitor dispatch throws. Fix the resolution or add the prompt. blocked-by: P-001
- **P-025** `todo` `plan-gate.md`: delete it — vestigial stub, retired in favor of `reviewer`, `ROLE_ALIASES={}`, not in AGENT_ROLES (the one unambiguous cleanup). Confirm no harness config references `plan-gate` as a role before removing.
- **P-026** `todo` Minor-drift sweep (all confirmed by the fidelity audit, low risk): validator's `VALIDATOR …` stdout line is never parsed (state is PG) — soften the prompt's "harness greps this" language; infra/security-reviewer `::papercusp::…-done` telemetry lines parsed by nothing — same; curator identity-file path points at the legacy `~/autonomous-harness/` fallback rather than the canonical PG snapshot path — update. None change behavior; all stop misleading the agent.
- **P-027** `todo` Verify the scoper `${HARNESS_PORT:-3055}` finding: an audit flagged scoper plan-API calls defaulting to `:3055` (the Vite SPA) instead of `:3070` (the hono plans API). This MAY be a pre-`:3070`-scrub artifact or a distinct construct the earlier sweep missed — read the live `scoper.md` + confirm the default before editing. Fix only if real. blocked-by: P-022

## Phase 4 — Verify behavior, not just text

- **P-030** `todo` Spot-run a harness pipeline turn (testing docs `/internal/docs/testing` + agent-e2e) on a scratch harness: director's emitted verbs all dispatch-classified (no `unsupported` stops); the filled gaps fire (pre-loop on an un-gated start, debugger at attempts≥3, CONVERT_ISSUES sweep promotes an open issue); DONE runs curator+documenter for real; any newly-wired role (crosscheck/ui-qa/etc.) dispatches. This is the real "do the prompts make sense + does the system do what it claims" check. blocked-by: P-013, P-020, P-021, P-022, P-023

## Out of scope (the intentional cuts — do NOT port)
- `NEXT_HARNESS`, `NEXT_WORKER_CEO_MODE`, parallel `NEXT_WORKER N=k` lanes (retire D-001).
- competition / adaptive-tiers / synthesizer worktree-race model (retire D-009/D-012) — flag-gated behind FLAGS.TESTING, NOT deleted (retire D-011). If `synthesizer` is voted CUT in P-001, it only means removing its *live-looking* prompt framing, not the flag-gated machinery.
- The legacy `main-loop.ts` global LLM-per-iteration loop structure itself — DBOS's deterministic dispatcher is the deliberate, better replacement.

## Decisions

### D-REF — The authoritative cut list (everything else is preserve-or-fill)
Date: 2026-06-01. Per avi's directive, the ONLY capabilities allowed to disappear are those `dbos-retire-legacy-orchestrator-2026-05-31` explicitly recorded as intentional: `NEXT_HARNESS` / `NEXT_WORKER_CEO_MODE` / parallel `N=k` lanes (its D-001); competition / adaptive-tiers / synthesizer (its D-009/D-012, flag-gated not deleted per its D-011). Any other legacy↔DBOS delta surfaced by the audit is a gap to FILL or a prompt to make accurate — never a new deprecation — unless avi explicitly adds it to this list. This is the lens for every decision below.

### D-001 — Supersedes dbos-pipeline-prompt-reconciliation
Date: 2026-06-01. This plan absorbs `dbos-pipeline-prompt-reconciliation-2026-06-01` wholesale (orchestrator.md fate → D-006/P-021; pre-loop → D-003/P-010; CONVERT_ISSUES → D-004/P-011). That plan is marked superseded. The audit materially expanded the scope (6 dead roles, ~10 drifts, debugger-before-worker) so a single umbrella plan replaces the narrower one.

### D-002 — The 6 designed-but-unwired roles: wire-or-cut (OPEN — needs avi)
Date: 2026-06-01. Each has a prompt (and mostly an AGENT_ROLES entry) but ZERO dispatch path in either engine — confirmed: `NEXT_PROJECT_MANAGER` and `NEXT_SUMMARIZER` are explicitly absent from DECISION_VERBS (asserted in decision-parse.test.ts); `crosscheck`/`ui-qa` have no `NEXT_*` verb at all; `synthesizer` is competition-only (cut list); `orchestrator` is never invoked in the DBOS path (dispatcher selects in code). Per-role recommendation:
- **crosscheck** (post-validator anti-bias second opinion, different model): genuinely valuable for catching validator false-positives → **WIRE** (a post-pass dispatch, opt-in per harness).
- **ui-qa** (browser/verdict checks of VAL-UI-* a text validator can't see): valuable for UI features → **WIRE** (gated on VAL-UI-* claims + uiQa.enabled).
- **project_manager** (curates a project's living spec injected into future prompts): valuable at scale → **WIRE** (post-feature-pass trigger) OR defer if projects-layer is dormant.
- **summarizer** (periodic activity digest): low value under DBOS observability → lean **CUT** (or make it a periodic timer, not a role).
- **synthesizer**: on the cut list (competition) → **leave flag-gated**, remove only its live-looking prompt framing.
- **orchestrator**: not a role to wire — its global job is now the dispatcher (code). → merge-then-archive (D-006). 
Net recommendation: WIRE crosscheck + ui-qa (+ project_manager if projects-layer is live), CUT/timer summarizer, archive orchestrator, leave synthesizer flag-gated.

### D-003 — Pre-loop: split — fill the plan-review gate, decide the scoper-auto-populate (OPEN — needs avi)
Date: 2026-06-01. Confirmed gap: DBOS has no `runPreLoop` (`grep` → 0). Two behaviors with different dispositions:
- **reviewer MODE=plan (gate the initial plan before workers run):** NO replacement under DBOS — promote→start→dispatch goes straight to workers ungated. Clean accidental loss → **FILL** (P-010).
- **scoper MODE=initial (auto-populate an empty harness from a SPEC/plan):** arguably already SUPERSEDED by plans:promote-as-primary-ingestion (the same plans-central model that retired SPEC.md). This is borderline-cut-list — your explicit call: if you agree it's superseded, it joins the cut list and only the gate (above) gets filled; if not, fill both. Recommendation: treat scoper-auto-populate as superseded (don't fill), fill the plan-review gate.

### D-004 — CONVERT_ISSUES: fill as a dispatcher sweep (OPEN — needs avi)
Date: 2026-06-01. Confirmed gap (code-verified): the DBOS autoloop fires the per-feature `director` (single-feature scope, no issue-scan), NOT the global `orchestrator`; the dispatcher scans `harness_features` only, never `harness_issues`; `/issues/:id/promote` exists but no automated code calls it. So open critical/major issues are NEVER auto-promoted under DBOS. Not on the cut list. Recommendation: **FILL** as a periodic dispatcher/autoloop sweep (P-011) reusing the existing promote logic — cheaper + more deterministic than the legacy LLM-emitted `CONVERTED` verb (the conversion work was always agent-side curl anyway; the verb was just a confirmation).

### D-005 — debugger-before-worker: fill (OPEN — needs avi)
Date: 2026-06-01. `director.md` promises "the substrate fires the debugger automatically before the worker once attempts ≥ 3" — TRUE in the retired legacy loop (`main-loop.ts:1060-1097`), FALSE under DBOS (dispatches `worker` only). Not on the cut list, and the prompt already advertises it → the honest fix is to FILL it (P-012), not delete the promise. Recommendation: fill — port the attempts≥threshold + existsSync(debugNote) guard into the DBOS worker dispatch.

### D-006 — orchestrator.md: merge-then-archive, not delete (OPEN — needs avi)
Date: 2026-06-01. The 259-line orchestrator.md is the RETIRED global-loop persona; it poses as the live driver but is never invoked under DBOS (the dispatcher selects in code, the director decides per-feature). The legacy loop is the sanctioned `=0` revert, so the persona must survive the revert → salvage its still-true global heuristics (issue-conversion → feeds P-011), strip cut + no-op verbs + the false NEXT_PROJECT_MANAGER section, then `git mv` to `prompts/_archived/` (preserved, out of the live path). Never hard-delete.
