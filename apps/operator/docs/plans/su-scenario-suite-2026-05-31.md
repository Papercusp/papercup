---
title: SU playbook scenario suite — behavioral test coverage for the engineer-collaborator prompt
slug: su-scenario-suite-2026-05-31
status: ready
created: 2026-05-31
updated: 2026-05-31
owner: avi@storewolf.com
related: [su-prompt-audit-round2-2026-05-31, llm-testing-phase1-status-2026-05-14]
---

## Now

> **State:** The SU engineer-collaborator playbook
> (`apps/operator/prompts/papercusp-su-engineer.tools.md`) has **zero automated
> behavioral coverage** — surfaced during the round-2 audit. The `llm-testing`
> framework (`apps/operator/lib/llm-testing/`) covers `operator`/`oracle`/
> `architect` only, and every existing target is an **HTTP chat endpoint**
> (`OperatorTarget` → `/api/agent-mcp/operator-converse` over HTTP-SSE). The SU
> playbook has **no such endpoint** — it's the system prompt for an interactive
> `claude-su`/`psu` agent driving the `papercusp-su` MCP catalog. So we can't
> just register a config entry; the suite's core is a **new target shape** that
> runs *playbook-as-system-prompt + the SU tool catalog* as the system-under-test.
> Goal: make SU-prompt changes measurable (we just shipped a from-scratch rewrite
> with only mechanical + content-preservation checks — no behavioral signal).
>
> **Next:** Decide the SUT shape (D-001 — in-process model loop vs a new
> su-converse route) — that gates everything. Then P-001 (the `su` target) +
> P-002 (`su` rubric), then the 5–6 starter scenarios (P-004) pinned to the
> failure modes we *know* happen (Tauri/webapp, harness-arg, polling, design,
> raw-SQL). Keep it small + assert-first per the framework's own guidance.

## Phase 1 — The `su` target (the core build)

- **P-001** `todo` Add a **`su` target** to `apps/operator/lib/llm-testing/targets/`
  (register in `targets/index.ts`; model it on `targets/operator.ts`). Unlike the
  existing HTTP-chat targets, its `ChatSession.send()` runs the **engineer
  playbook as the system prompt** + exposes the **`papercusp-su` tool catalog**,
  loops tool-calls to completion, and returns a `TurnResult` (assistantText +
  toolCalls + costUsd). Per D-001, do this **in-process** (reuse `llm-client.ts`
  for the model + `dispatchProjectedTool(Stream)` for tools) rather than standing
  up a new prod HTTP route — that sidesteps the operator-converse-on-`:3070` hang
  (the P5 blocker in `llm-testing` Phase 1) and adds no production surface.
  Load the playbook from source (`apps/operator/prompts/papercusp-su-engineer.tools.md`)
  so the test exercises the file we edit, not a stale `~/.papercusp` render.
  blocked-by:D-001
- **P-002** `todo` Add a **`rubrics/su.ts`** rubric. Axes: groundedness (cites
  docs/code, doesn't speculate), **tool-selection** (picks the right tool — e.g.
  `harness:'all'` not "can't"; design-phase for UI), **convention-adherence**
  (follows the playbook's hard rules), scope-discipline, helpfulness. Mirror the
  shape of `rubrics/operator.ts`. blocked-by:P-001
- **P-003** `todo` Add an `su` scenarios dir + register pattern
  (`scenarios/su/`, wire into `scenarios/index.ts` + the
  `__tests__/runner-aggregate.test.ts` registry assertion).

## Phase 2 — Starter scenarios (assert-first, on KNOWN failure modes)

- **P-004** `todo` Author ~5–6 scenarios — each with ≥1 **deterministic assert**
  (the framework warns judge-alone is noise) and a sim-user persona that *tempts*
  the wrong behavior without smuggling the answer into the prompt:
  - **SU-S01 harness-scope** — vague "show me the plan / the docs" at operator
    scope. Assert it passes a `harness` arg (`tool_called docs:*`/`plans:*` with
    `harness` set) and does **not** stall on `harness_required`
    (`text_excludes` "can't" / "no harness"). (The exact confusion we just fixed.)
  - **SU-S02 Tauri-only** — "open / check the app." Assert it does **not** try to
    browse `:3055`/`:3070` (`tool_not_called` a browser-nav; `text_excludes`
    ":3055"/":3070" in a browse context) and points at the Tauri/testing-docs flow.
  - **SU-S03 push-not-poll** — "make the UI live-update." Judge + `text_excludes`
    a polling loop unless it states a justification; credit IPC/SSE.
  - **SU-S04 design-first** — a UI/component ask. Assert it reads design docs /
    reaches for `design-phase:*` before hand-rolling (`tool_called` design-phase
    or docs:design).
  - **SU-S05 feature-mutation** — "mark F-NNN passed" / "change a feature." Assert
    it does **not** invent `features:update` or raw-SQL; uses the pipeline /
    `messages:feature_send` (`tool_not_called` a write that doesn't exist).
  - **SU-S06 shared-tree git** (optional) — "save your work." Judge: commits,
    doesn't fret about pushing / a clean single commit.
  - N=3 for judge-heavy ones; lean on the deterministic asserts for the load-bearing
    behavior.

## Phase 3 — Run, iterate, wire in

- **P-005** `todo` Run locally (`ANTHROPIC_API_KEY` + the in-process target →
  `pnpm llm-test --scenario su-S01-… --no-matrix`), iterate the asserts/rubric on
  real findings, then full matrix. Results persist to `harness_shared.llm_test_runs`
  → `/admin/testing?tab=llm`.
- **P-006** `todo` Make it the **measurement gate for SU-prompt changes**: run the
  `su` suite before deploying a playbook edit (the round-2 rewrite shipped with no
  behavioral signal — this closes that). Document the one-liner in the engineer
  playbook's "update a tool prompt or persona" workflow.

## Decisions

### D-001 — SUT shape: in-process model loop, not a new HTTP route

The existing targets are HTTP clients of chat endpoints; the SU playbook isn't an
endpoint. Two ways to make it testable: (a) an **in-process target** whose
`send()` runs a model (`llm-client.ts`) with the playbook as system prompt + the
SU tool catalog via `dispatchProjectedTool`, or (b) a **new `su-converse` HTTP
route** that the target hits. **Recommend (a):** it reuses the dispatcher
(tool-calls go through the real gating/telemetry), adds no production surface,
exercises the source playbook file directly, and sidesteps the
operator-converse-`:3070` hang that blocks the HTTP path (`llm-testing` Phase 1
P5). The cost: it's a genuinely new target *shape* (a model loop, not an SSE
client) — `targets/operator.ts` even flags "in-process" as the cleaner-but-unbuilt
transport, so there's no in-process precedent to copy; this builds it. Human call
needed before P-001 since it sets the whole suite's foundation.

Related: P-001

### D-002 — Keep it small + assert-first; cover known failures, not the whole playbook

The framework's own guidance: don't lean on the judge (noisy), pin load-bearing
behavior with deterministic asserts, don't boil the ocean. Scope to ~5–6 scenarios
on the failure modes we've *actually observed or just fixed* (harness-scope
confusion, browsing the retired webapp, polling-by-default, skipping design,
inventing `features:update`) rather than exhaustive coverage. Each gets a
`tool_called`/`tool_not_called`/`text_excludes` assert; the judge is the secondary
signal. Grow the suite when a new failure mode shows up, not pre-emptively.

Related: P-004

### D-003 — This is the fix for "flying blind" on the highest-leverage prompt

The SU playbook is loaded into every SU session and was just rewritten from scratch
with only mechanical + content-preservation checks — no behavioral measurement,
which violates the "change one variable and measure" principle. Standing up even a
small `su` suite makes future SU-prompt edits measurable and gives the rewrite a
retroactive behavioral check. That's the point of this plan; size it to that, not
to perfection.

Related: P-006
