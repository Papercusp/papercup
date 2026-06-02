---
title: Voice operator persona — production readiness
slug: voice-persona-production-readiness-2026-06-02
status: ready
created: 2026-06-02
owner: aviynw@gmail.com
companion-to: [voice-production-test-coverage-2026-06-01, operator-brain-test-isolation-2026-06-02]
---

# Voice operator persona — production readiness

## Now

The voice LLM-test scenarios now run live and evaluate real behavior (unblocked by
`operator-brain-test-isolation-2026-06-02`). Running them **validated 3× with a
sonnet judge** surfaced real, consistent operator voice-behavior gaps — the suite
is doing its job. This plan tracks closing those gaps so `op-S13..S16` pass on the
voice model. **No code is broken; this is persona/behavior + a model-selection
decision.** Test infra is done; what remains is operator voice-quality work.

## Background — validated findings (3× matrix, brain=sonnet, judge=sonnet, 2026-06-02)

Run: `LLM_TEST_BACKEND=claude-code LLM_TEST_SIM_MODEL=haiku LLM_TEST_JUDGE_MODEL=sonnet
PAPERCUSP_LLM_TEST_SKIP_CLAIM=1 npm --prefix apps/operator run llm-test -- --scenario <id> --no-persist`
(drop `--no-matrix` → the scenario's declared 3× `runMatrix`).

1. **Over-length `<say>` — the dominant gap.** The persona states "1–2 sentences,
   ≤220 chars" (`operator-converse-prompt.ts:201`) but sonnet **consistently**
   overruns: `<say>` of 260/275/361/442/549 chars across S13's runs (often 2×+),
   dumping multi-harness status + a question into one TTS breath. NOT a haiku
   artifact (a single N=1 sonnet run mislead — it sampled a compliant turn).
   `clampSay` (`operator-converse-tags.ts:86`, 220-char cap) exists but runs on the
   tag-parse/TTS path, not the converse delta stream — and truncation mid-thought
   is degraded speech, not a fix. The fix is **behavioral terseness**.
2. **No disambiguation card** (`cardUsage`, S16 every run). On an ambiguous voice
   instruction ("approve the busy one") the operator makes an autonomous pick in
   prose instead of surfacing a single `chat:ask_choice` `voiceAnswerable:true`
   card. The persona mentions cards (`converse-prompt.ts:217`) but too weakly for
   sonnet to reach for them (opus does — see model note).
3. **Question stacking** (`oneQuestionMarkPerTurn`, S13). Stacks 2 questions in one
   turn despite the persona's "Do not stack multiple questions."
4. **Groundedness misses** (sonnet judge). Hallucinated harness slugs
   (`prod-api-service`, never surfaced), and "dispatching hotfix-auth" announced
   with zero tool calls in that turn (action narrated but not executed).
5. **Tool-name confusion.** The brain's prose/calls mix canonical colon names
   (`harness:status`) with the real MCP underscore names (`harness_status`); the
   judge reads the colon forms as hallucinated. Worth confirming whether the persona
   shows tools by colon name while the model only has underscore tools, and aligning.
6. **High variance** (speakability stddev 1.70, tone 1.63 — both > the 0.5 flag).
   Voice behavior is unpredictable run-to-run; any fix must be re-validated at 3×.

## Model decision (firm, from latency)

Brain latency/turn: **haiku ~21 s, sonnet ~17 s, opus ~100 s.** Opus blows the
scenarios' 90 s wall-cap + 90 s initial-event timeout and is an unusable voice UX
(100 s dead air). **Run the voice surface on `sonnet`**, not the pinned
`claude-opus-4-7`. Prefer a per-surface override (agent-config `surfaceModels`) so
only voice changes, leaving the opus brain for text orchestration if desired.

## Phases (proposed)

### Phase 1 — terseness + cards (VALIDATED ✅)
- **P-001** `done` Strengthened the voice block (`agent-tools/operator/converse-prompt.ts`,
  commit `99817ff20`): ≤220 chars HARD per `<say>`, lead with one fact + offer to
  continue (never dump lists), one question per turn. **VALIDATED 2026-06-02** (3× matrix,
  brain=sonnet, judge=sonnet): S13 went **verdict FAIL → PASS** — `formatLength220` fired
  in ALL 3 pre-fix runs (260–549 chars) and **ZERO post-fix runs**. The over-length gap is
  closed.
- **P-003** `done` Card-disambiguation rule (same commit). S16's `cardUsage` dropped from
  failing-every-run to **no longer in the failure set** (variance 0.94). Helped.
- **P-002** `todo` If a stronger instruction doesn't hold the cap (models are weak
  at hard limits), consider a structural answer: emit multiple short `<say>` blocks,
  or a "headline + offer to continue" pattern, rather than relying on the model.
- **P-006** `todo` Investigate the recurring **600s `operator:converse` timeout** on
  S16 (pre- and post-fix) — the brain occasionally loops/hangs for the full
  `TOTAL_CAP_MS`. Likely a tool-call loop (ToolSearch + hallucinated names, see
  finding #5); could be its own SUT-health bug, not just persona.

### Phase 2 — disambiguation cards
- **P-003** `todo` Make card-based disambiguation explicit: "when a voice
  instruction is ambiguous (≥2 candidates), surface ONE `chat:ask_choice`
  `voiceAnswerable:true` card — do NOT guess." Re-validate S16 3×.

### ⚠ ROOT CAUSE FOUND (2026-06-02) — deferred-MCP-tool flailing is the dominant blocker

A 3× sonnet-judge validation of Phase 3 traced **almost every remaining S13/S16
finding to ONE root**: the operator brain on `claude-code` is handed the FULL
agentmcp surface (**226 tools**, because the mcpConfig URL uses `superuser=1`, which
bypasses all role/capability filtering — `gate-bypass.ts`). Claude Code **defers**
a tool set that large (client-side), so each tool must be **activated via
`ToolSearch` before it can be called**. The brain then flails:
- fires 4+ `ToolSearch`es per turn, tries `harness_list`, `harness:list`,
  `harness:list({})` — "four tool-name variants, none schema-loaded" — because the
  persona advertises **colon** names (`harness:status`) but the real tools are
  **underscore** (`harness_status`);
- **can't reliably surface the disambiguation card** (S16 `cardUsage` fails every
  run): it `ToolSearch`es `chat:ask_choice` then `chat_ask_choice` but neither
  emits a card → falls back to prose;
- **11 tool calls / 121 s for one turn**, narrates "checking…" before data returns
  (groundedness), and occasionally loops to the **600 s `operator:converse` cap
  (= P-006 / directive-3 bug — SAME root)**.

**This is an infrastructure issue, not a persona one** — `disallowBuiltins` +
terseness/grounding/jargon rules (all committed, all directionally good) cannot fix
it. **The fix: shrink the brain's exposed MCP surface to the ~15–40 tools the
operator actually uses, so Claude Code loads them DIRECTLY (no deferral → no
ToolSearch).** Options, in preference order:
- **P-009** `todo` (RECOMMENDED) Add a tool-allowlist to the agent-mcp HTTP endpoint
  (e.g. `?tools=harness_status,harness_list,…` filters `tools/list`), and have
  `converse.ts` pass the operator's core set. This is a change to the SHARED MCP
  endpoint (used by every spawned agent) — do it deliberately + test that worker/
  scoper/etc. spawns are unaffected. Verify the brain's init shows the tools
  NON-deferred + a 3× run stops flailing.
- **P-010** `todo` (parallel) Reconcile persona tool names to **underscore** (37
  colon refs in `converse-prompt.ts` :150/:191/:207, `operator.persona.md`,
  `operator.tools.md`) + add explicit guidance: "tools are deferred — `ToolSearch`
  the exact underscore name to load it, THEN call it; never a colon form; load
  each once." Helps even if the surface stays deferred.

### Phase 3b — grounding + tool discipline (remaining S16 blockers, confirmed post-Phase-1)
After Phase 1 fixed over-length + cards, the 3× post-fix run surfaced the NEXT layer
of S16/S13 findings (sonnet judge):
- **P-004** `todo` Grounding: never narrate state/an action before the tool result
  exists in the same/earlier turn (S13 run1 stated "5 harnesses all in progress" in
  Turn 0, contradicted by Turn 1's real data); never pass a slug the user/tools didn't
  surface.
- **P-005** `todo` Tool-name mismatch (RECURRING — root of the "tool flailing"). The
  persona advertises colon names (`converse-prompt.ts:207`: `harness:list / harness:status
  / issues:list / …`) but the model's actual tools are underscore
  (`mcp__agentmcp__harness_status`). The brain `ToolSearch`es the colon names → resolves
  nothing → flails/retries. Fix: refer to tools by the real (underscore) names in the
  persona, or add an explicit "tools are named `harness_status`, not `harness:status`,
  and are already loaded — don't ToolSearch for them" note.
- **P-007** `todo` Voice jargon: ban domain-internal jargon/IDs in `<say>` for voice
  ("papercusp flags match dash-delimited parsing", "dig the chunks") — speak plain
  language a generic listener parses.
- **P-008** `todo` Stray built-ins: the brain emitted `Bash({command:'echo …'})` as a
  no-op "comment" and a `<spawn role="debugger">`. The operator shouldn't reach for
  built-in `Bash`/Task at all on a chat turn — consider whether the spawn surface should
  exclude built-ins, or the persona should forbid them.

## Decisions

### D-001 — Verification recipe
Always run the declared 3× `runMatrix` (NOT `--no-matrix`) with `LLM_TEST_JUDGE_MODEL=sonnet`
before any verdict. N=1 + haiku-judge mislead (a wrong "resolves on sonnet"
conclusion came from exactly that). Deterministic asserts (length, one-question,
has-say) are reliable per-run; rubric findings need the sonnet judge. Set the brain
to `sonnet` via agent-config `models['operator']` for the run; restore `{}` after.

### D-002 — Scope
Test infra (`operator-brain-test-isolation`) is shipped. This plan is operator
voice-behavior only. It changes the production persona, so land + re-validate one
phase at a time; don't batch-tune blindly against a high-variance judge.
