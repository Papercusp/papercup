---
title: Reconcile substrate role prompts to DBOS — preserve legacy capabilities except the intentional cuts
slug: dbos-pipeline-prompt-reconciliation-2026-06-01
status: superseded
created: 2026-06-01
updated: 2026-06-01
owner: avi@storewolf.com
---

# Reconcile substrate role prompts to DBOS — preserve legacy capabilities except the intentional cuts

## Now

**State:** SUPERSEDED by dbos-system-completion-2026-06-01. This plan's scope (orchestrator.md retire/merge, the pre-loop gap, CONVERT_ISSUES) was a subset of what the full legacy-system audit surfaced. All of it is carried forward into the umbrella plan: orchestrator.md → D-006/P-021; pre-loop → D-003/P-010; CONVERT_ISSUES → D-004/P-011. Do not work this plan; work dbos-system-completion-2026-06-01.

**Next:** Work dbos-system-completion-2026-06-01 instead.

## Background — what DBOS already preserves vs. what you cut (from the retire plan's own decisions)

Verified against `dbos-retire-legacy-orchestrator-2026-05-31` (D-001…D-014) + `orchestrator-decide.ts` + `decision-parse.ts`, 2026-06-01.

**DBOS already PRESERVES (Phase F of the retire plan closed these gaps deliberately):**
- Lifecycle verbs `NEXT_WORKER` / `NEXT_VALIDATOR` / `NEXT_ARCHITECT` / `NEXT_SCOPER` → all `dispatch` in `orchestrator-decide.ts`.
- Quality/expert verbs `NEXT_TESTER` / `NEXT_SECURITY` / `GENERATE_TESTS` / `NEXT_MONITOR` / `NEXT_EXPERT` / `NEXT_FEEDBACK` → all `dispatch` (retire-plan P-003). `director.md` is kept minimal (retire D-003) so it doesn't *force* a role a harness lacks — but the capability is wired.
- DONE finalization (curator → documenter → archive → afterDone hook) + ESCALATE finalization (on-escalate hook → curator) → retire P-001/P-002, D-004.
- Cost-cap (dispatcher gate, retire D-002), chunk-loop worker (retire D-013/D-014), per-harness concurrency + continuous refill (retire D-013), autoloop + periodic timers (retire D-009).

**You INTENTIONALLY CUT (the only allowed deprecations):**
- `NEXT_HARNESS`, `NEXT_WORKER_CEO_MODE`, parallel `NEXT_WORKER N=k` — global-orchestrator-only, cut from the per-feature model (retire D-001).
- competition (best-of-N) / adaptive worker-count tiers / synthesizer — the pre-chunk-loop worktree-race model, superseded 2026-05-08 (retire D-009/D-012). **Flag-gated behind FLAGS.TESTING, NOT deleted** (retire D-011) — reachable for testers, hidden in V1.

**Legacy-only, NOT on the cut list → these are GAPS TO FILL, not deprecations:**
- **Pre-loop** (`pre-loop.ts`): scoper `MODE=initial` (auto-populate an empty harness's queue) + reviewer `MODE=plan` (gate the initial plan before any worker runs). The DBOS dispatcher has no `runPreLoop` (`grep runPreLoop apps/operator/lib/dbos/` → 0). Nothing in the retire plan lists the pre-loop as an intentional cut → by the directive it must be ported, not reframed away.
- **`CONVERT_ISSUES`** (orchestrator.md decision D): global open-issue → feature promotion. Per-feature `director` doesn't do it. Need to confirm whether the DBOS **autoloop's** global director (retire D-009 migrated an autoloop) covers it; if not, it's a gap to fill, not a capability to drop.

**Engine reality (so the prompts can describe it accurately):**
- Live driver is the **DBOS per-feature pipeline**; the per-turn decision agent is **`director.md`** (47 lines, accurate today — emits only `NEXT_WORKER`/`NEXT_ARCHITECT`/`NEXT_VALIDATOR`/`DONE`/`ESCALATE`, explicitly disclaims `N=k`).
- `orchestrator.md` (259 lines, "You are the ORCHESTRATOR in a 3-agent harness") is the **RETIRED** main-loop persona, still present in `prompts/` and still posing as the live driver — the clearest single inaccuracy.
- The legacy loop is reachable only via `PAPERCUSP_DBOS_ORCHESTRATOR=0` (the documented instant-revert) → orchestrator.md must be **archived (preserved), not deleted**, so the revert path keeps its persona.

## Phase 1 — Decisions (needs-human gates)

- **P-001** `needs-human` `orchestrator.md`'s fate. It's the retired-loop persona but the loop is the sanctioned revert path (`PAPERCUSP_DBOS_ORCHESTRATOR=0`). Recommendation: **(b) merge-then-archive** — lift its still-true *global-scope* heuristics (issue-conversion, escalation criteria, cross-feature judgment) somewhere appropriate, then `git mv` it to `prompts/_archived/` (preserved for the revert, out of the live load path). NOT hard-delete (would strip the revert path's persona). See D-001.
- **P-002** `needs-human` Pre-loop disposition — **the crux of the directive.** The scoper-`MODE=initial` + reviewer-`MODE=plan` pre-loop is legacy-only and NOT on your cut list. Per "don't deprecate non-acknowledged capabilities," recommendation is now **(b) FILL the gap**: add a DBOS pre-loop equivalent (scoper auto-populates an empty harness; optional plan-gate), then the prompts describe a real capability. (My earlier draft recommended reframing the prompts to "on-demand only" — that would have *deprecated* the auto-populate behavior, contradicting the directive. Corrected.) See D-002.
- **P-002b** `needs-human` `CONVERT_ISSUES` disposition: confirm from code whether the DBOS autoloop's global director performs issue→feature conversion. If yes → prompt-accuracy only. If no → it's a gap to FILL (port `CONVERT_ISSUES` into the dispatcher/autoloop), since it's not an acknowledged cut. See D-003.

## Phase 2 — Engine-parity track (FILL the non-cut gaps) — gated on P-002 / P-002b

- **P-011** `todo` If D-002 = fill: implement a DBOS pre-loop — on a harness with eligible features but an un-scoped/empty queue, run scoper `MODE=initial` (and optional reviewer `MODE=plan` gate) before the per-feature pipeline dispatches workers. Port from `pre-loop.ts` into the dispatcher path; idempotent + checkpointed like the rest of the DBOS work. Unit-tested. blocked-by: P-002
- **P-012** `todo` If D-003 = fill: ensure global issue→feature conversion (`CONVERT_ISSUES`) runs under DBOS (dispatcher or autoloop), matching the legacy orchestrator's decision D. Unit-tested. blocked-by: P-002b

## Phase 3 — Prompt-accuracy track (no behavior change; describe what's actually true)

- **P-003** `todo` `director.md`: confirm against `orchestrator-decide.ts` that every verb it emits is `dispatch`-classified and it never advertises a cut verb (`NEXT_HARNESS`/`CEO_MODE`/`N=`). Optionally surface the preserved quality verbs (`NEXT_TESTER`/`NEXT_SECURITY`/…) at the right point — but heed retire-D-003 (don't make it spawn a role a harness lacks); gate any such addition per-harness. blocked-by: P-001
- **P-004** `todo` Merge-then-archive `orchestrator.md` per P-001: salvage the still-true global heuristics, drop the multi-iteration-loop framing + the cut verbs (`NEXT_HARNESS`/`CEO_MODE`/`N=`) + the `IDLE`/`READY_FOR_PROD`/`FEATURE_FREEZE`/`RUN_TESTS` global-loop verbs, then `git mv` to `prompts/_archived/`. blocked-by: P-001
- **P-005** `todo` `scoper.md` / `reviewer.md` / `plan-gate.md`: rewrite to describe the **actual** DBOS flow once P-011 lands — i.e. the pre-loop as it really runs under DBOS (NOT "deprecated; on-demand only"). Drop the dead `run.sh`/legacy-loop framing; keep the capability. Resolve the reviewer-vs-plan-gate overlap (confirm from `role-registry.ts` which is live; archive the redundant one rather than leaving two). blocked-by: P-011
- **P-006** `todo` Sweep all prompts + `README.md` for the cut verbs and the retired fixed-sequence narrative: remove `NEXT_HARNESS`/`CEO_MODE`/`N=` from live prompts (README may keep them under a clear "legacy / revert-only" label); reframe any rigid "scoper→…→curator" pipeline language to "the director decides each turn; finalization runs curator+documenter on DONE." Do NOT remove competition/adaptive/synthesizer *mentions* if they're flag-gated-live (per the retire plan's flag-gating decision) — label them testing-only instead.

## Phase 4 — Verify behavior, not just text

- **P-007** `todo` Spot-run a harness pipeline turn (testing docs: `/internal/docs/testing` + agent-e2e) on a scratch harness: confirm the director's emitted verbs are all `dispatch`-classified (no `unsupported` stops), the pre-loop fires on an empty queue (if P-011 landed), DONE runs curator+documenter, and worker/validator behave against the rewritten personas. The real "do the prompts make sense" check. blocked-by: P-003, P-004, P-005, P-011

## Decisions

### D-001 — orchestrator.md: merge-then-archive, do not delete (OPEN — needs avi)
Date: 2026-06-01. `orchestrator.md` (259 lines) is the RETIRED main-loop persona; `director.md` (47 lines) drives the live DBOS pipeline. But the legacy loop is the sanctioned instant-revert (`PAPERCUSP_DBOS_ORCHESTRATOR=0`, retire D-007), so its persona must survive the revert. Recommendation: salvage its still-true global heuristics, then `git mv` to `prompts/_archived/` (preserved, out of the live load path) — never hard-delete. Keeps both the revert path AND a single live decision persona.

### D-002 — Pre-loop is a gap to FILL, not a deprecation (OPEN — needs avi) — flips this plan's earlier rec
Date: 2026-06-01. The scoper-`MODE=initial` auto-populate + reviewer-`MODE=plan` gate run only in the legacy `pre-loop.ts`; DBOS has no `runPreLoop`. The retire plan does NOT list the pre-loop as an intentional cut. Per the governing directive (preserve all non-acknowledged capabilities), this is an **accidental loss to port**, not a behavior to document-away. Recommendation: **(b) implement a DBOS pre-loop** (P-005a), THEN make the scoper/reviewer/plan-gate prompts describe it accurately (P-005). This explicitly supersedes the earlier draft's "(a) reframe to on-demand only," which would have deprecated a capability you didn't sign off on cutting. (If on reflection you DO consider the pre-loop intentionally superseded by plans:promote-as-primary-ingestion, say so and it joins the cut list — but that's your call to make explicit, not mine to assume.)

### D-003 — CONVERT_ISSUES: confirm DBOS coverage, fill if missing (OPEN — needs avi)
Date: 2026-06-01. Legacy orchestrator decision D promotes open critical/major issues → F-FIX features globally. The per-feature director doesn't; the retire D-009 autoloop migration may or may not cover it. Not on the cut list. Recommendation: confirm from code (autoloop global director scope); if uncovered, port it (P-005b) rather than silently lose global issue-conversion.

### D-004 — The cut list is authoritative; everything else is preserve-or-fill
Date: 2026-06-01. Per avi's directive, the ONLY capabilities allowed to disappear are those the retire plan explicitly records as intentional: `NEXT_HARNESS` / `NEXT_WORKER_CEO_MODE` / parallel `N=k` lanes (retire D-001), and competition / adaptive-tiers / synthesizer (retire D-009/D-012, flag-gated not deleted per D-011). Any other legacy/DBOS delta found during this work is treated as a gap to FILL or a prompt to make accurate — never a new deprecation — unless avi explicitly adds it to the cut list. This decision is the lens for triaging anything new this work surfaces.
