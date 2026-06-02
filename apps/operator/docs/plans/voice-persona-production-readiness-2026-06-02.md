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

### Phase 1 — terseness (highest impact)
- **P-001** `doing` Strengthened the voice block (`agent-tools/operator/converse-prompt.ts`,
  commit `99817ff20`): ≤220 chars HARD per `<say>`, lead with one fact + offer to
  continue (never dump lists), one question per turn. **Validation BLOCKED by the
  shared box's rate-limit/API overload (2026-06-02)** — a 3× sonnet-judge re-run
  mostly *errored* on environment ("fetch failed", "terminated", 600s timeout; mem0
  `AnthropicLLM` API errors in the host log), at near-zero cost = the brain produced
  nothing. The ONE run that completed (S13 run3) **passed** (encouraging, not
  conclusive). **Next: re-run `op-S13`/`op-S16` at 3× with a sonnet judge when the
  account isn't rate-limited** to confirm the over-length fix holds.
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

### Phase 3 — grounding + tool naming
- **P-004** `todo` Tighten grounding: never narrate an action as done without the
  tool call in the same turn; never pass a slug the user/tools didn't surface.
- **P-005** `todo` Confirm + fix the colon/underscore tool-name mismatch if the
  persona advertises colon names the model can't call.

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
