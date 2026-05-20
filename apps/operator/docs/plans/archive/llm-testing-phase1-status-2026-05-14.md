---
title: LLM testing framework — Phase 1+1.5+2 status (superseded)
slug: llm-testing-phase1-status-2026-05-14
status: superseded
created: 2026-05-14
updated: 2026-05-20
owner: pandawamble@gmail.com
superseded-by: llm-testing-status-2026-05-14
---

## Now

**State:** **Date:** 2026-05-14 **Plan:** `apps/operator/docs/plans/llm-testing-framework-2026-05-14.md` (v2, Round-2 review applied) **Status:** Framework shippable, end-to-end smoke not yet run.

**Next:** Archived — no further work expected. Restore from archive/ only if context warrants.


# LLM testing framework — Phase 1 + 1.5 + 2 status snapshot

**Date:** 2026-05-14
**Plan:** `apps/operator/docs/plans/llm-testing-framework-2026-05-14.md` (v2, Round-2 review applied)
**Status:** Framework shippable, end-to-end smoke not yet run.

This doc captures everything delivered against the plan, where the
gaps are, and the exact commands to drive the framework end-to-end.

---

## 1. What works today

### Three-role pipeline
- **Sim-user LLM** (Haiku by default) drives the conversation as a
  persona with a goal. Strict-JSON action output, 1 retry on schema
  fail. (`lib/llm-testing/sim-user.ts`)
- **SUT** is the live operator chat over HTTP+SSE. Distinct `uiClientId`
  per run (`llm-testing/<runId>`) lets the framework filter telemetry.
  (`lib/llm-testing/targets/operator.ts`)
- **Judge LLM** (Sonnet default; Opus on `criticality: 'high'`) scores
  the transcript against a rubric (`lib/llm-testing/rubrics/operator.ts`).
  Score-5 anchor + multi-pass on high-criticality keep noise down.

### Deterministic assert layer
Eleven kinds registered (`lib/llm-testing/asserts/`):
- `tool_called` / `tool_not_called` (SSE tape + PG telemetry, tail-matches `mcp__*__`)
- `text_contains` / `text_excludes` (regex/literal across all or one turn)
- `card_emitted` (kind + voiceAnswerable + options)
- `control_tag_present` (`<continue/>` / `<sleep/>` / `<spawn/>` with min/max count)
- `auto_fire_happened` / `auto_fire_did_not_happen` (PG `operator_continue_chains` ledger)
- `continue_chain_within_cap` (ledger-based time + turn caps)
- `latency_under` / `cost_under` / `finish_reason_is`
- `mem0_wrote` / `mem0_read` / `spawn_dispatched` (PG telemetry)
- `custom` for one-off predicates with `name` + `eval()`

### Telemetry plumbing (Phase 0 gate)
- `packages/agent-mcp/dispatch-projected.ts` **auto-fills `ctx.uiClientId`
  into `metadata_json`** on all completion paths. Handler overrides win
  when explicit. 5 unit tests cover ok/timeout/error paths.
- `apps/operator/app/api/agent-mcp/operator-converse/route.ts` plumbs
  `body.uiClientId` into `ctxBase.uiClientId` (and `body.conversationId`
  into the chain ledger writer).
- Static audit test (`__tests__/telemetry-tagging-audit.test.ts`) guards
  the route plumbing as a regression check.

### V8 chain ledger writes
`apps/operator/lib/operator-continue-chains.ts` writes one row per
chain turn:
- `trigger='continue'` on `<continue/>` auto-fire
- `trigger='auto_fire_terminal'` on V8 terminal-question auto-fire
- `trigger='reset'` when user input ends an active chain (within 5 min)

Stateless chain-id reconstruction: looks at the most recent row for
`(conversationId, uiClientId)` within 5 min; extends or mints fresh.
Production provider and framework target both write through the same
helper.

### Persistence + UI
- Migration 073 (`harness_shared.llm_test_runs`, `llm_test_findings`,
  `llm_test_fixtures`, `operator_continue_chains`, +
  `llm_test_matrix_results` view) lives in the libs/papercusp submodule
  bumped at `34d489dd`.
- `lib/llm-testing/storage.ts` persists run + findings.
- `/admin/testing?tab=llm` subtab with three views:
  - **Runs**: filterable list (target, status), with score + cost
    summary per row.
  - **Scenarios**: in-process registry view (id, persona, matrix,
    transport, caps).
  - **Findings**: cross-run triage queue. Open/Acknowledged toggle.
    Promotion column: `promoted` / `candidate ≥3×` / `recurring ≥2×`.
    "Copy as agent prompt" button on every row (matches
    nothing-auto-implemented rule).
- `PATCH /api/admin/llm-tests/findings/[id]` for ack.

### CLI verbs
```
pnpm llm-test --scenario <id>          # one scenario, default N
pnpm llm-test --target operator        # all scenarios for a target
pnpm llm-test --list                   # scenarios + targets
pnpm llm-test --no-matrix              # force N=1
pnpm llm-test --no-persist             # don't write to PG

pnpm llm-test replay --fixture <id> --scenario <id>
                                       # re-judge stored .sse tape
pnpm llm-test replay --re-evaluate <run-uuid> --scenario <id>
                                       # re-judge a historical run

pnpm llm-test promote-candidates       # novel-failure shapes ≥3×/14d
pnpm llm-test promote --shape <hash>   # scaffold asserts/promoted-X.ts
```

### Scenario suite (12 / 12 from plan §10.2)
| ID  | Behavior tested |
|-----|-----------------|
| S01 | terminal status, harness tool, mem0 |
| S02 | multistep — Phase 1 self-validation gate (catches V8 F1: narrate-without-`<continue/>`) |
| S03 | `<continue/>` count cap |
| S04 | `<continue/>` time cap (ledger assert) |
| S05 | `<sleep/>` honored |
| S06 | spawn-worker (or choice-card escape hatch) |
| S07 | passive mode — `realWorkspace: true` |
| S08 | silence-nudge → ready card |
| S09 | Generate Ideas → user_says_ready |
| S10 | ambiguous → choice card |
| S11 | voice modality, voiceAnswerable cards |
| S12 | tool-error recovery (natural error path) |

### Fixtures
`lib/llm-testing/fixtures/operator/v8-baseline/` — 7 SSE tapes +
markdown notes migrated from `/tmp/v8-e2e-recordings/`. Includes
scenario 02 (the V8 F1 evidence: "Checking..." narration with no
`<continue/>` tag, no follow-up tool call).

### Tests
- **50/50** vitest in `apps/operator/lib/llm-testing/__tests__/`:
  identity (13), asserts (20), runner-aggregate (6), fixture-loader (6),
  parallelism-smoke (2), telemetry-tagging-audit (3).
- **5 new** dispatcher auto-fill tests in
  `packages/agent-mcp/src/dispatch-projected.test.ts` (32 total there).

---

## 2. What's deferred

### Brain-subprocess tool override
Plan §10.4's `ToolDispatchOverride` infrastructure is in place
(`lib/llm-testing/dispatch-override.ts` + 4 helper functions, the
override interface added to the dispatcher's deps surface). But the
brain (claude/omp subprocess) calls tools via its MCP config that
points back to the operator's HTTP routes. To inject an override into
*nested* tool calls, the framework would need each of those routes to
read `X-Tool-Dispatch-Override-Id` and forward it into the dispatcher.

**Workaround for now:** Scenarios use natural error paths (S12 asks
for a non-existent entity → real lookup failure) and natural slow
chains (S04 asserts the ledger row's elapsed time, not synthetic
slowness). When the subprocess override path lands, S04 + S12 can
switch to deterministic injection without changing their assertions.

### In-process operator transport
`OperatorTarget.send()` currently throws when `transport: 'in-process'`
is requested. The plan's argument for this path was reduced HTTP/SSE
flake; in practice the HTTP path is reliable and the in-process call
would require the framework runner to either run *inside* the Next
process or import the converse handler module (which transitively
imports Fumadocs MDX — Vite's import-analysis chokes on it in vitest;
tsx might tolerate it). Defer until concrete need.

### End-to-end smoke against a live operator
Requires `ANTHROPIC_API_KEY` + `papercusp-desktop && npm run dev` on
the default `:3055`. Not something the framework itself can validate.

Recommended first smoke run:
```bash
export ANTHROPIC_API_KEY=...
cd papercusp-desktop && npm run dev   # in another terminal
cd apps/operator
pnpm llm-test --scenario op-S01-status-quick --no-matrix
```

Expected: ~30-60s wallclock, ~$0.20 cost, status=passed (preview
without matrix). Output also persists to PG; check `/admin/testing?tab=llm`.

### Phase 4: brain-debug target
Plan §11 — a second `ChatTarget` to validate the abstraction. Lands
~3 brain-debug scenarios. Not started.

### Phase 5: nightly cron
Plan §12 — systemd-user timer + alert hookups when new findings or
pass-rate drops. Not started; the storage + CLI are ready when wanted.

---

## 3. The framework's own self-validation gate

Plan §12 Phase 1 binding criterion:
> S02 must FAIL against current operator code (catches V8 F1) AND
> PASS against a hand-patched operator that emits `<continue/>` after
> "Checking..." narration.

**Not run yet.** To execute:
```bash
# Pre-fix run — expect S02 status=failed with terminationFit + missing
# `tool_called: issues:list` findings.
pnpm llm-test --scenario op-S02-multistep-investigation --no-matrix

# Hand-patch the operator prompt or runtime to force <continue/> after
# narration. Re-run — expect status=passed.
```

The natural-error path of S12 + the multistep nature of S02 are
substantively the same evidence as the v8-baseline scenario-02 fixture
captured pre-framework.

---

## 4. Commits chronologically

```
697c46df  docs(plans): LLM testing framework v2
34d489dd  chore(submodule): migration 073
4216939d  feat(llm-testing): Phase 1 core (sim-user, judge, runner, S01/S02/S08, CLI)
cdad23d7  feat(llm-testing): /admin/testing 'LLM' subtab + read APIs
e5d96b26  feat(llm-testing): telemetry pull + real mem0/spawn asserts + 39 tests
a29f07fc  feat(llm-testing): promotion CLI + v8-baseline fixtures
046e79f5  feat(agent-mcp+llm-testing): dispatcher auto-fills metadata_json.uiClientId
99acd153  feat(llm-testing): replay verbs — fixture + re-evaluate
86816f65  test(llm-testing): parallelism smoke
f65bdae7  feat(operator+llm-testing): operator_continue_chains write side
f0455e2e  feat(llm-testing): Phase 2 scenarios S03/S05/S07/S10
1b345e3b  feat(llm-testing): findings cross-run view
<this turn> feat(llm-testing): Phase 2 scenarios S04/S06/S09/S11/S12 + scripted triggers
```

---

## 5. File map

```
apps/operator/lib/llm-testing/
├── types.ts                  ChatTarget, Scenario, Persona, Judge, Assert
├── runner.ts                 orchestrator + matrix aggregation
├── judge.ts                  rubric scoring + multi-pass
├── sim-user.ts               persona-driven JSON-action loop
├── llm-client.ts             @anthropic-ai/sdk wrapper + cost estimation
├── identity.ts               composite identity_hash (scenario+persona+rubric+SUT+judge)
├── dispatch-override.ts      ToolDispatchOverride interface + helpers
├── storage.ts                persist RunSummary + findings to PG
├── telemetry.ts              pull tool_invocations + operator_continue_chains
├── replay.ts                 replayFixture() + reEvaluateRun()
├── targets/
│   ├── operator.ts           HTTP+SSE transport
│   └── index.ts              target registry
├── personas/
│   ├── traits.ts             composable trait system
│   └── blends.ts             6 named blends (brief-admin, adversarial, ...)
├── asserts/
│   ├── index.ts              globalThis-backed registry
│   ├── tool.ts               SSE + PG counting, tail-match
│   ├── text.ts               regex/literal
│   ├── card.ts               kind + options + voiceAnswerable
│   ├── control-tag.ts        <continue/> / <sleep/> / <spawn/>
│   ├── auto-fire.ts          ledger-derived
│   ├── continue-chain.ts     ledger-derived caps
│   └── latency.ts            latency/cost/finish + mem0/spawn stubs
├── rubrics/operator.ts       7-axis operator rubric v1.0.0
├── scenarios/
│   ├── index.ts              registry (12 scenarios)
│   └── operator/S01–S12.ts
├── fixtures/
│   ├── loader.ts             .sse tape → TurnResult
│   ├── README.md
│   └── operator/v8-baseline/ 7 SSE tapes
├── promotion/
│   ├── candidates.ts         GROUP BY shape ≥3 scenarios / 14d
│   └── promote.ts            scaffolds asserts/promoted-<short>.ts
└── __tests__/                50 unit tests

apps/operator/bin/llm-test.ts          CLI entry
apps/operator/lib/operator-continue-chains.ts   ledger writer (used by route + framework)
apps/operator/app/admin/testing/_components/LlmTab.tsx    UI subtab
apps/operator/app/api/admin/llm-tests/{runs,findings,scenarios}/   read APIs
apps/operator/app/api/admin/llm-tests/findings/[id]/route.ts       PATCH ack

packages/agent-mcp/src/dispatch-projected.ts   uiClientId auto-fill
```
