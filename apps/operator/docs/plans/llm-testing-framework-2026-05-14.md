# LLM testing framework — plan

**Date:** 2026-05-14
**Status:** Round-2 review applied — approved for implementation
**Revision:** v2 (12 amendments from Round-2 review baked in)
**Scope:** Generic-from-day-1 framework for testing any LLM-driven chat surface in Papercup. First target = operator chat. Operator coverage doubles as the framework's own validation. UI driving is **out of scope** — that lives in `tests-page-2026-05-14.md` (Chaos / AI-Explore / WDIO). This framework drives the *backend* (HTTP/SSE / IPC) only.

---

## 1. Goals & non-goals

### Goals

- Catch behavioral regressions in any LLM chat surface (operator first, architect / brain-debug / oracle / scoper next) without running a browser.
- Surface qualitative issues a deterministic test can't see (premature termination, hallucinated tools, wrong tone, ignored constraints) — that's the judge's job.
- Surface quantitative regressions (auto-fire fired when it shouldn't, continue-cap exceeded, missing tool call, latency spike) — that's the deterministic-assert layer.
- Produce a **report artifact** with copy-as-prompt findings; never auto-implement fixes (matches user rule).
- Re-runnable cheaply on cached transcripts (judge-only re-evaluation when the rubric changes).
- Reusable across surfaces via a small `ChatTarget` interface.

### Non-goals

- UI driving. Use `tauri-agent-tools` from the testing playbook for that — separate concern.
- Replacing existing route-level Vitest specs (`*.route.test.ts`). Those test transport contracts; this tests *behavior*.
- Replacing the Chaos / WDIO perf harness on `/tests`. Different axis (perf vs. correctness/judgment).
- Replacing the smaller deterministic SSE captures we already have under `/tmp/v8-e2e-recordings/`. Those become *fixtures* that this framework can replay against the judge without burning sim-user tokens.

---

## 2. Architecture

### 2.1 Three roles

```
┌──────────────┐   user turn    ┌────────────────────┐
│  User-Sim    │ ─────────────► │  System Under Test │
│  (LLM)       │                │  (e.g. operator)   │
│              │ ◄───────────── │                    │
└──────────────┘  asst turn +   └────────────────────┘
       │         tool/card/etc.           │
       │                                  │ telemetry
       │                                  ▼
       │                        ┌─────────────────────┐
       │                        │ deterministic asserts│
       │                        │  (PG tool_invocations│
       │                        │   + SSE event tape)  │
       │                        └─────────────────────┘
       ▼                                   │
   stop?  ───── transcript ───────────────►│
                                           ▼
                                  ┌──────────────────┐
                                  │  Judge LLM       │
                                  │  (rubric scoring)│
                                  └──────────────────┘
                                           │
                                           ▼
                                       findings
```

- **User-Sim**: LLM with a persona + goal. Reads the assistant's last message + cards, decides next move (text reply / pick choice / give up / declare success). Has hard caps (max turns, max wallclock, max $).
- **SUT**: a `ChatTarget` implementation. For operator: POSTs to `/api/agent-mcp/operator-converse`, parses SSE, accumulates the assistant turn (text + tool_calls + cards via the planned `ctx.emit` envelope).
- **Judge**: separate LLM, separate provider when feasible (avoid grading-yourself bias), receives full transcript + scenario contract + per-turn telemetry, returns structured findings keyed to the rubric.

### 2.2 Why separate sim-user and judge

- Sim-user is *embedded* (it has to act in-loop, with limited info — same context the real user would have).
- Judge sees *everything* including telemetry rows the user can't see (tool calls, cost, internal cards, ipc messages).
- Mixing them biases judgment ("I drove the conversation here, so it must be fine").

### 2.3 Why backend-only (no UI)

- The operator's behavior (auto-fire, continue cap, silence-nudge timer, mem0 pre/post, spawn dispatch) lives in the **converse tool** + **provider runtime**, not the React tree. UI is presentation.
- Driving via HTTP/SSE means: no Tauri, no Xvfb, no flake from animation timings, parallelizable, runnable in CI.
- UI-specific bugs (composer eats Enter, Generate Ideas button misroutes) are caught by the `/tests` page tools — different harness, different concern.

### 2.4 Variance & pass/fail semantics

The biggest practical risk isn't bugs — it's noise. Sim-user is LLM-driven; three runs of S01 will explore three different paths and produce three different transcripts. Without a variance strategy, a flaky pass/fail signal teaches the team to ignore failures.

**Per-scenario `runMatrix` instead of blanket N=3.** Scenarios declare their own repeat count and variance policy based on judge-dependence:

| Scenario class | Example | `runMatrix.repeat` | Rationale |
|---|---|---|---|
| Deterministic-assert-only | S07 passive-mode, S12 tool-error | 1 | Pass/fail is a hard boolean; repeating burns budget |
| Mixed asserts + judge | S01 status, S03 cap-count | 3 | Judge axes vary; majority-vote on `pass` |
| Judge-heavy / persona-driven | S02 multistep, S09 generate-ideas, S10 ask-choice | 5 | High behavioral variance; need a real distribution |
| Hostile / adversarial | S03, S04 (cap forcing) | 3 with stddev tracking | Force the cap *and* watch how it's forced |

**Variance itself is a finding.** When score stddev > 0.5 on any rubric axis across a `runMatrix`, the report records `inconsistent_behavior` as a first-class finding kind ("the operator handles this scenario inconsistently"). That's actionable signal — it points at non-determinism in operator behavior that prod users will eventually hit.

**UI labelling.** Single-run results show as `preview` in the `/tests` UI, not `pass`/`fail`. Only a matrix-completed run gets a `pass`/`fail` verdict, computed from majority-of-N + variance-policy. This avoids the "one run said it passed, ship it" failure mode.

**Cost trade-off.** N=3 default for judge-heavy scenarios is the dominant cost driver — see §9 for the rebuilt math.

---

## 3. Core abstractions

All under `apps/operator/lib/llm-testing/` (TS — keeps it in the operator app for now; can move to `libs/papercusp/llm-testing/` once a 2nd surface lands).

### 3.1 `ChatTarget`

```ts
export interface ChatTarget {
  /** Stable id used in reports + storage. */
  readonly id: string;
  /** Human label, e.g. "operator (sheets harness)". */
  readonly label: string;

  /** Open a fresh conversation. Returns a session handle the runner threads through turns. */
  openSession(opts: OpenSessionOpts): Promise<ChatSession>;
}

export interface ChatSession {
  readonly id: string;            // operator: uuid; architect: spawn id; etc.
  readonly target: ChatTarget;

  /** Send one user-side input, await one assistant turn. Streams events to the sink. */
  sendUserTurn(input: UserTurnInput, sink: TurnEventSink): Promise<TurnResult>;

  /** Trigger a non-user-message turn (continue, quiet_wait_resume, user_says_ready, etc.). */
  triggerTurn(trigger: TurnTrigger, sink: TurnEventSink): Promise<TurnResult>;

  /** Pull telemetry rows since the last call. */
  drainTelemetry(): Promise<TelemetryRow[]>;

  /** Idempotent close — flush mem0 post-turn, end session, etc. */
  close(): Promise<void>;
}

export type UserTurnInput =
  | { kind: 'text'; text: string }
  | { kind: 'choice'; cardId: string; optionId: string; freeText?: string }
  | { kind: 'voice_simulated'; transcript: string };  // posts as text but flagged modality:'voice'

export type TurnTrigger =
  | 'continue' | 'quiet_wait_resume' | 'user_says_ready'
  | 'user_welcomed' | 'open_canvas' | 'silence_nudge';

export interface TurnResult {
  assistantText: string;          // accumulated `delta` text
  toolCalls: ToolCallEvent[];     // SUT-emitted
  cards: CardEvent[];             // ctx.askUser / ctx.publishState envelopes
  controlTags: ControlTag[];      // <continue/>, <sleep/>, <spawn/>, etc.
  costUsd: number;
  latencyMs: number;
  finishReason: 'done' | 'error' | 'aborted' | 'budget' | 'cap';
  error?: string;
  rawSseTape: SseEvent[];         // full event tape for replay/judge
}
```

The contract is intentionally **transport-agnostic**. Operator's implementation parses SSE; architect's will parse a different stream; brain-debug's may go straight in-process via `dispatchProjectedToolStream`. The runner doesn't care.

### 3.2 `Persona` — composable traits + named blends

Personas are **composed from traits**, not enumerated as prose. Authoring a new persona = picking trait values, not writing a system prompt.

```ts
export interface PersonaTraits {
  verbosity: 'terse' | 'normal' | 'verbose';
  politeness: 'rude' | 'neutral' | 'polite';
  clarification: 'never_clarifies' | 'sometimes' | 'always';
  goalClarity: 'precise' | 'vague' | 'shifting';   // does the sim-user know what it wants?
  interrupts: boolean;                              // sends another message before SUT finishes
  modality: 'text' | 'voice';
  domain?: 'admin' | 'dev' | 'pm' | 'support';      // affects vocabulary, not behavior
}

export interface Persona {
  id: string;
  description: string;
  traits: PersonaTraits;
}
```

The sim-user LLM's system prompt is **composed at runtime** from the trait values via templated paragraphs ("You are terse — single sentences, no preamble." / "You change your mind mid-conversation."). No persona-specific prose files.

**Named blends** (aliases) for ergonomics — scenarios can reference `'brief-admin'` instead of inlining the traits object:

| Blend | Traits |
|---|---|
| `brief-admin` | terse · neutral · never_clarifies · precise · text · admin |
| `patient-admin` | normal · polite · sometimes · precise · text · admin |
| `adversarial` | verbose · rude · always · shifting · text · dev |
| `voice-user` | normal · neutral · sometimes · vague · voice · admin |
| `hostile` | terse · rude · never_clarifies · vague · interrupts · text |
| `pedantic-dev` | verbose · neutral · always · precise · text · dev |

Library lives at `apps/operator/lib/llm-testing/personas/`:
- `traits.ts` — trait types + prompt-composition logic
- `blends.ts` — the named aliases above
- Scenarios accept `persona: Persona | PersonaTraits` (a blend name resolves to traits; a raw traits object is used inline).

Dimensions × levels = 4 × 3 × 3 × 3 × 2 × 2 = 432 combinations. Six blends are starting points; new scenarios pick whatever axes matter.

### 3.3 `Scenario`

A scenario is a contract: persona + goal + assertions + judge rubric.

```ts
export interface Scenario {
  id: string;                     // 'op-active-multistep-issues'
  version: number;                // bump when behavior contract changes
  target: string;                 // ChatTarget.id this is written for
  description: string;
  persona: Persona | PersonaTraits; // named blend OR explicit traits — see §3.2
  goal: GoalSpec;                 // what counts as success for the sim-user
  setup?: ScenarioSetup;          // seed data (features, issues, mem0 history, etc.)
  triggers?: ScenarioTrigger[];   // injected mid-run (e.g. silence_nudge after 30s of no SUT activity)
  asserts: DeterministicAssert[]; // see §5
  rubric: JudgeRubric;            // see §6
  caps: { maxTurns: number; maxWallSecs: number; maxCostUsd: number };

  // ── Round-2 additions ──
  runMatrix?: {                   // see §2.4 — per-scenario variance handling
    repeat: number;               // N runs per invocation (default 1; recommend 3 for judge-heavy)
    variancePolicy?: 'flag-if-stddev>0.5' | 'flag-if-disagreement' | 'none';
  };
  realWorkspace?: boolean;        // default false (isolated /tmp/llm-testing-runs/<runId>); see §4.5
  transport?: 'in-process' | 'http-sse'; // default 'in-process'; see §10.4
  fixtures?: { sseTapePath?: string }; // if set, replay instead of live-call SUT — see §9 replay verbs
}

export type GoalSpec =
  | { kind: 'user_satisfied'; declaredBy: 'sim_user' }
  | { kind: 'tool_fired'; toolName: string }
  | { kind: 'card_emitted'; cardKind: string }
  | { kind: 'state_reached'; predicate: string };
```

Scenarios live at `apps/operator/lib/llm-testing/scenarios/<target>/<id>.ts` so the operator's scenarios sit together but other targets can drop in alongside.

### 3.4 `Runner`

```ts
export async function runScenario(scenario: Scenario, opts: RunOpts): Promise<RunResult>;
```

Loop:

1. `target.openSession()` → `session`
2. `simUser = createSimUser(scenario.persona, scenario.goal)`
3. While not done:
   a. `simUser.nextAction(history)` → text / choice / give_up / declare_success
   b. `session.sendUserTurn(input, sink)` → `TurnResult`
   c. evaluate any matched `triggers` (e.g. inject `silence_nudge` if SUT was idle 30s)
   d. evaluate `asserts.onTurn` over `TurnResult` + telemetry; record violations
   e. check goal / caps
4. After loop: gather full transcript + telemetry + assert violations → judge
5. Persist `RunResult` to PG (§7)

`RunOpts` carries `dryRun` (skip LLM calls, replay from `fixtures.sseTapePath`), `judgeOnly` (re-evaluate stored transcripts), `parallel` (number of scenarios in flight; defaults to 1 because operator-converse single-flights per session).

### 3.5 `SimUser`

Backed by an LLM call per turn. Prompt = persona system block + goal + last N assistant messages + cards-on-screen + last user-side action + a strict output schema:

```json
{
  "thought": "string (private)",
  "action": {
    "kind": "text|choice|give_up|declare_success",
    "text"?: "string",
    "cardId"?: "string",
    "optionId"?: "string",
    "reason"?: "string"   // for give_up / declare_success
  }
}
```

Strict JSON output, 1 retry on schema fail, hard fail on second. Records every `thought` for the judge — judge can flag "sim-user got confused here, that's actually a SUT clarity bug."

### 3.6 `Judge`

One LLM call (or a few — see §6.4 multi-pass) at the end. Receives:

- Full transcript (user + assistant + cards + tool_calls + control tags)
- Per-turn telemetry (cost, latency, tools dispatched, mem0 read/write, IPC dispatch path)
- Deterministic-assert violations
- Scenario rubric

Returns structured findings:

```json
{
  "summary": "one-paragraph headline",
  "scores": { "<axis>": 0..5 },
  "findings": [
    { "severity": "info|warn|error", "axis": "string",
      "evidence_turn_idx": 3, "claim": "...", "suggestion": "..." }
  ],
  "agrees_with_deterministic_asserts": true,
  "novel_failures": [...]   // things the deterministic layer missed
}
```

`novel_failures` is the most valuable output — drives new deterministic asserts over time.

---

## 4. Operator `ChatTarget` — concrete shape

`apps/operator/lib/llm-testing/targets/operator.ts`

### 4.1 Session

- One operator session = one `conversationId` (uuid). Created via the same path the UI uses (`getOrCreateConversation` or equivalent under-the-hood call) so mem0 / cards / spawn dispatch behave normally.
- Optional `harnessSlug` — most operator behavior is harness-scoped; default to `sheets` (already loaded with realistic features/issues).

### 4.2 Sending a turn

POST `http://127.0.0.1:3070/api/agent-mcp/operator-converse` (or `:3055` dev) with:

```json
{
  "messages": [...transcript so far...],
  "trigger": "user_message",
  "modality": "text",
  "mayAskActive": true,
  "uiClientId": "llm-testing/<runId>"
}
```

Parse SSE: `delta` → `assistantText`; `tool_call` → `toolCalls`; `done` → `costUsd`, finish; `error` → finish('error').

For the planned **typed-events** envelope (`ctx.emit` from the bespoke-card arc), also handle `card`, `state`, `partial` — each gets folded into `TurnResult.cards` / current state snapshot.

### 4.3 Triggering non-user-message turns

Same endpoint, different `trigger`:

| Sim move | `trigger` | Notes |
|---|---|---|
| user typed text | `user_message` | normal path |
| sim picks "Ready" card option | `user_says_ready` | matches the V8 silence-nudge card |
| sim says "ok continue" / opens a panel | `open_canvas` / `quiet_wait_resume` | per current operator triggers |
| **runner** auto-fires after terminal `?` | `continue` | proves V8 auto-fire |
| **runner** simulates 30s silence | `silence_nudge` | calls `/api/operator/conversations/[id]/silence-nudge` directly, then captures the resulting card as a `cards` event in the next user turn |

### 4.4 Telemetry pull

After every turn, query `harness_shared.tool_invocations` filtered by `metadata_json @> '{"uiClientId":"llm-testing/<runId>"}'` (already JSONB per docs-retrieval Phase 2). Also pull from any operator-specific tables we add for V8 (`continue_chains`, `auto_fire_attempts` if those land — TBD; otherwise infer from `tool_invocations` rows for `operator:converse`).

### 4.5 Isolation

**Default: isolated per-run workspace.** Reversed from the original draft — mem0 cross-talk between test runs and real dev work is a real debugging cost we'd hit within a week, and tool-mocks + real state combine into confusing failure modes ("mock says PG unavailable but real status would have succeeded").

- Dedicated `runId` (uuid). Threaded through `uiClientId` so every PG row is filterable.
- **Default ON:** `workspaceRoot=/tmp/llm-testing-runs/<runId>` — fresh per-workspace PG via `getHarnessAdminUrl()`. mem0 writes, harness state, conversation rows all isolated.
- **Opt-in real-state:** scenarios that *need* shared state (e.g. **B17 mem0 recall** — only meaningful against a workspace with prior memory) declare `realWorkspace: true`. These become rare and deliberate, not the default.
- Cleanup: `close()` drops the isolated PG schema entirely. Real-workspace runs delete by `uiClientId` filter.

Scenarios in §10.2 marked `realWorkspace: true`: **none in initial 12** — the mem0 behavior tested in S01 uses a per-run seeded memory rather than the live dev workspace's memory.

---

## 5. Deterministic asserts

These are the cheap, hard checks that don't need a judge. Each scenario declares a list; runner evaluates them turn-by-turn (`onTurn`) and at end-of-run (`onFinish`).

### 5.1 Built-in assert kinds

| Kind | Spec | Source of truth |
|---|---|---|
| `tool_called` | `{ name, minTimes?, maxTimes?, withArgsMatching? }` | `TurnResult.toolCalls` + `tool_invocations` |
| `tool_not_called` | `{ name }` | same |
| `text_contains` / `text_excludes` | `{ pattern, turnIdx? }` | `assistantText` |
| `card_emitted` | `{ kind, optionsInclude? }` | `TurnResult.cards` |
| `control_tag_present` | `{ tag: 'continue'|'sleep'|'spawn', maxCount? }` | `TurnResult.controlTags` |
| `auto_fire_happened` | `{ trigger: 'continue'|'user_says_ready' }` | runner-side ledger of trigger types |
| `auto_fire_did_not_happen` | `{}` | same |
| `continue_chain_within_cap` | `{ maxTurns, maxSecs }` | runner-side ledger |
| `latency_under` | `{ p50?: ms, p95?: ms }` | per-turn `latencyMs` |
| `cost_under` | `{ usd }` | sum of `TurnResult.costUsd` |
| `mem0_wrote` / `mem0_read` | `{ matching? }` | telemetry rows for `mem0:*` |
| `spawn_dispatched` | `{ role, feature? }` | `tool_invocations` for `harness:spawn` |
| `finish_reason_is` | `{ expected }` | `TurnResult.finishReason` |

### 5.2 Why these and not "anything goes"

- Every assert maps to a documented operator behavior. New behavior → new assert kind; we catalogue them in `apps/operator/lib/llm-testing/asserts/index.ts` rather than letting scenarios author free-form predicates. Keeps reports comparable across runs.
- Free-form predicates exist (`{ kind: 'custom'; name: string; eval: (run) => Violation[] }`) but are an escape hatch — when a custom assert fires repeatedly across scenarios, it's a signal to promote it to a built-in.

### 5.3 Telemetry contract this depends on

Things we already have:

- `harness_shared.tool_invocations` (tool name, args, result, cost, latency, JSONB metadata)
- SSE event types `delta` / `tool_call` / `done` / `error` (route.ts header above)

Things that **must land in Phase 0** (promoted from "follow-up" after review):

- **`harness_shared.operator_continue_chains` table** — S03 and S04 (2 of 12 scenarios) cover B3/B4, which are V8 signature behaviors. Reconstructing chain count from `trigger='continue'` invocation rows is brittle: a single missed row breaks the deterministic assert. Migration 073 adds the table; provider writes a row per turn in a chain; runner queries directly. Schema in §7.1.
- **Universal `uiClientId` threading** — every projected tool's `ctx.metadata` must include `uiClientId`. See §5.4.

Things V8 / bespoke-card add that we *use* when present:

- `ctx.emit('card', …)` typed events — when present, lets us assert on cards directly. Until then we infer cards by inspecting the conversation messages table for `role:assistant_card` rows.

### 5.4 Telemetry-tagging audit (Phase 0 CI gate)

The framework's `tool_called` / `tool_not_called` / `mem0_*` / `spawn_dispatched` asserts all hinge on `tool_invocations.metadata_json @> '{"uiClientId":"llm-testing/<runId>"}'`. That works only if **every** projected tool consistently threads `uiClientId` into `ctx.metadata`. With ~96 built-in tools plus plugin tools, even one missing thread silently breaks scenario isolation.

Phase 0 ships a CI test at `apps/operator/lib/llm-testing/__tests__/telemetry-tagging-audit.test.ts` that:

1. Enumerates every tool via `endpoint:list-tools` (or in-process equivalent).
2. Invokes each tool with a probe `ctx.metadata = { uiClientId: 'audit-probe' }` and minimal valid args (uses a per-tool stub registry for required inputs).
3. Asserts the resulting `tool_invocations` row has `metadata_json->>'uiClientId' = 'audit-probe'`.
4. Fails the build listing every tool that dropped the tag.

Once green, the test stays in CI forever — any new tool author must thread the metadata or break the build. This is the framework's foundation; without it deterministic isolation is a lie.


---

## 6. Judge rubric

### 6.1 Axes (operator chat — others define their own)

| Axis | What it scores | 0 = bad | 5 = ideal |
|---|---|---|---|
| `helpfulness` | Did the user reach their goal? | goal not addressed | goal achieved efficiently |
| `groundedness` | Are claims backed by tool calls / context? | hallucinated state | every factual claim cites a tool result or context message |
| `terminationFit` | Does the SUT stop / continue at the right moments? | stops mid-task / loops past goal | terminates exactly when the goal is met or asks for input only when needed |
| `cardUsage` | Are cards used vs. free text correctly? | text dump where a card was right (e.g. multi-choice) | cards on choice/state moments, prose on prose moments |
| `tone` | Persona-appropriate, no apologetic spirals, no lecturing | grovelling / preachy | crisp, matches persona expectations |
| `tools` | Right tool, right args, no fabricated tool names | hallucinated tool / wrong args | minimal correct tool set |
| `speakability` | (modality=voice scenarios only) **scope: the text the operator emits, not the voice transport.** Speakable, ≤2 sentences per turn unless user asked for detail. A real voice-transport test (ElevenLabs / OpenAI Realtime) is a future `VoiceTarget` — see §11. | wall of text in voice mode | short, conversational |

Rubric definitions live at `apps/operator/lib/llm-testing/rubrics/operator.ts` so they're versioned — every report records the rubric `version` so historical scores stay comparable.

### 6.2 Judge prompt skeleton

```
You are evaluating a transcript from <SUT description>.

Scenario goal: <goal>
Persona driving the user: <persona>
Rubric (axes + 0–5 anchors): <rubric JSON>

Transcript (annotated with telemetry per turn): <transcript>
Deterministic-assert violations already detected: <violations>

Output strict JSON matching this schema: <schema>

Rules:
- Cite turn indices for every finding.
- If you agree with a deterministic violation, restate it with a turn-cite; if you disagree, explain.
- 'novel_failures' are problems NOT in the deterministic violations list.
- 'suggestion' on each finding must be a concrete change ('shorten the assistant turn at idx 2 to a single question' beats 'be more concise').
- Do not propose code changes — only behavioral / prompt-level changes.
```

### 6.3 Avoiding self-grading bias

- Judge model **must differ** from SUT model when feasible. Default mapping: SUT=Sonnet → Judge=Opus; SUT=Opus → Judge=Sonnet+second-opinion-Opus. Mappings live in `apps/operator/lib/llm-testing/judges/registry.ts`, overridable per scenario.
- Judge prompt deliberately strips role-play framing — receives transcript as data, not as conversation.

### 6.4 Multi-pass judging (optional)

For scenarios where the rubric is ambiguous, runner can invoke judge twice with different temperatures and flag axes where the two disagree by >1 point. Cost: 2× judge cost. Off by default; on for scenarios marked `rubric.criticality: 'high'`.

### 6.5 What the judge is *not* allowed to do

- Mark a deterministic violation as a false positive without justifying it. Report includes `judge_overruled_assert: true` flag the admin sees.
- Score below 3 on any axis without a `findings[]` entry citing turns.
- Recommend implementation changes (e.g. "rewrite handleConverse to..."). Findings stay at the behavioral / prompt layer; implementation is the human's call.
- **Invent `novel_failures` when the run looks fine.** The judge prompt includes a *score-5 anchor*: "If every axis would score ≥4 and you have no specific turn to cite, return `novel_failures: []` and `notes: 'nominal'`." Without this anchor, judge LLMs over-produce minor critiques to feel useful.

### 6.6 Novel-failure promotion loop

`novel_failures` accumulates qualitative findings the judge surfaces that don't match an existing deterministic assert. Without an operational loop these become a write-only pile. The loop:

1. **Recording**: every `novel_failure` carries a `shape` — `sha256(axis + summary_normalized)` — so similar failures across runs get the same fingerprint.
2. **Aggregation**: `pnpm llm-test promote-candidates` (CLI subcommand, on-demand or monthly cron) groups `novel_failures` by `shape`, lists fingerprints seen in ≥3 distinct scenarios over the last 14 days.
3. **Promotion**: admin reads the candidate list, picks ones worth lifting into a built-in assert, runs `pnpm llm-test promote --shape <hash>`. CLI scaffolds an `apps/operator/lib/llm-testing/asserts/<name>.ts` stub the admin fills in, and writes a row to `llm_test_findings.promoted_from` linking the new assert back to the originating findings.
4. **Audit trail**: `llm_test_findings.shape` + `promoted_to_assert_id` columns let the UI show "this finding became built-in assert X on date Y" — keeps promotion lineage visible.

No service, no daemon. One CLI verb + a quarterly admin pass. Avoids the "monitoring system that nobody monitors" trap.


---

## 7. Storage (PG)

Migration **073** under `apps/operator/db/migrations/073_llm_testing.sql` (072 is the latest committed).

### 7.1 Tables (schema: `harness_shared`)

```sql
create table harness_shared.llm_test_runs (
  id              uuid primary key default gen_random_uuid(),
  scenario_id     text not null,
  scenario_version int not null,                 -- bumps when scenario contract changes
  scenario_target text not null,                 -- ChatTarget.id
  scenario_hash   text not null,                 -- sha256 of scenario file at run time
  identity_hash   text not null,                 -- sha256(scenario, persona, rubric_version, sut_model, judge_model)
                                                 -- runs with same identity_hash are directly comparable
  matrix_group_id uuid,                          -- groups the N runs of a runMatrix (§2.4); null if N=1
  matrix_index    int,                           -- 0..N-1 within a matrix_group_id
  rubric_version  text not null,
  sut_model       text not null,
  judge_model     text not null,
  persona_id      text not null,
  persona_traits_json jsonb not null,            -- resolved traits at run time (named blends expanded)
  status          text not null,                 -- 'running'|'passed'|'failed'|'errored'|'aborted'|'preview'
  workspace_mode  text not null,                 -- 'isolated' | 'real'
  transport_mode  text not null,                 -- 'in-process' | 'http-sse'
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  cost_usd        numeric(10,6) not null default 0,
  cap_breaches    text[] not null default '{}',  -- 'turns'|'wallclock'|'cost'
  -- denormalised summary for cheap list queries
  scores_json     jsonb,                         -- { axis: 0..5 }
  findings_count  jsonb not null default '{}'::jsonb,  -- { error: 2, warn: 5, info: 1 }
  -- full payload (large)
  transcript_raw_zstd bytea,                     -- zstd-compressed JSONL of SSE events; decode on read
  transcript_norm_json jsonb not null default '{}'::jsonb,  -- normalised TurnResult[] for diff/search
  telemetry_json  jsonb not null default '{}'::jsonb,
  asserts_json    jsonb not null default '{}'::jsonb,  -- { definitions, violations }
  judge_json      jsonb,                                -- raw judge response
  metadata_json   jsonb not null default '{}'::jsonb
);
create index on harness_shared.llm_test_runs (scenario_target, scenario_id, started_at desc);
create index on harness_shared.llm_test_runs (identity_hash, started_at desc);  -- trend lines
create index on harness_shared.llm_test_runs (matrix_group_id) where matrix_group_id is not null;
create index on harness_shared.llm_test_runs (status, started_at desc);

-- Matrix-aggregate view: one row per matrix_group_id with mean/stddev/majority verdict.
create view harness_shared.llm_test_matrix_results as
  select matrix_group_id,
         scenario_id, scenario_version, identity_hash,
         count(*) as n_runs,
         mode() within group (order by status) as majority_status,
         jsonb_object_agg(axis, stddev_score) as stddev_by_axis
  from (
    select r.matrix_group_id, r.scenario_id, r.scenario_version, r.identity_hash, r.status,
           k.key as axis,
           stddev_pop((k.value)::numeric) over (partition by r.matrix_group_id, k.key) as stddev_score
    from harness_shared.llm_test_runs r,
         lateral jsonb_each_text(r.scores_json) k
    where r.matrix_group_id is not null
  ) s
  group by matrix_group_id, scenario_id, scenario_version, identity_hash;

create table harness_shared.llm_test_findings (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references harness_shared.llm_test_runs(id) on delete cascade,
  source        text not null,                 -- 'assert' | 'judge' | 'variance'
  severity      text not null,                 -- 'error' | 'warn' | 'info'
  axis          text,                          -- nullable for assert-source
  assert_kind   text,                          -- nullable for judge-source
  shape         text,                          -- sha256(axis + summary_normalized) for promotion grouping (§6.6)
  evidence_turn_idx int,
  claim         text not null,
  suggestion    text,
  copy_prompt   text,                          -- pre-formatted "send this to a fixer agent" string
  promoted_to_assert_id text,                  -- non-null once a built-in assert is generated from this shape
  promoted_from text[] not null default '{}',  -- array of finding ids this assert was promoted from (set on the promoted assert's first appearance)
  acknowledged  boolean not null default false,
  acknowledged_by text,
  acknowledged_at timestamptz
);
create index on harness_shared.llm_test_findings (run_id, severity);
create index on harness_shared.llm_test_findings (shape, severity) where shape is not null;
create index on harness_shared.llm_test_findings (acknowledged, severity);

-- Continue-chain ledger (was a "follow-up" in §13.5 of the v1 plan; promoted to Phase 0 after review).
-- The operator provider writes one row per turn that's part of a <continue/> chain; the runner queries
-- by run_id (matched via uiClientId metadata) for deterministic B3/B4 asserts.
create table harness_shared.operator_continue_chains (
  id              bigserial primary key,
  conversation_id uuid not null,
  ui_client_id    text not null,               -- matches metadata_json->>'uiClientId' on tool_invocations
  chain_id        uuid not null,               -- one chain = continuous run of <continue/> turns
  turn_idx        int not null,                -- 0-indexed within chain
  trigger         text not null,               -- 'continue' | 'auto_fire_terminal' | 'reset'
  started_at      timestamptz not null default now(),
  elapsed_secs_in_chain numeric(10,3) not null,
  was_capped      boolean not null default false,
  cap_reason      text                         -- 'max_turns' | 'max_secs' | null
);
create index on harness_shared.operator_continue_chains (chain_id, turn_idx);
create index on harness_shared.operator_continue_chains (ui_client_id, started_at desc);

create table harness_shared.llm_test_fixtures (
  id            uuid primary key default gen_random_uuid(),
  scenario_id   text not null,
  label         text not null,                 -- e.g. 'baseline-2026-05-14'
  sse_tape_json jsonb not null,                -- recorded SSE events keyed by turn
  user_inputs_json jsonb not null,             -- recorded sim-user actions
  recorded_at   timestamptz not null default now(),
  recorded_from_run_id uuid references harness_shared.llm_test_runs(id) on delete set null,
  unique (scenario_id, label)
);
```

### 7.2 Why JSONB for transcript instead of relational rows

- Transcripts are append-only and always read whole (judge needs everything).
- One row per run = O(1) read for the report view.
- Findings are queried independently → their own table.
- Avoids a write per turn in the hot loop (each scenario can be 30+ turns).

### 7.3 Retention & storage cost

- **Default keep last 90 days of runs.** `findings` with `acknowledged=false` and `severity='error'` are kept indefinitely (admin still has to look at them).
- **Fixtures are forever** — they're the contract.
- **`transcript_raw_zstd`**: a typical 30-turn run with hundreds of `delta` events + full tool args & results compresses ~20× under zstd (3 MB raw → ~150 KB compressed). Without compression, 90 days × nightly × 12 scenarios × N=3 matrix ≈ ~3 GB; compressed ≈ ~150 MB. Cheap to add now, painful to add after we have data.
- `transcript_norm_json` stays uncompressed for diff/search/UI rendering — it's denormalised, the raw tape is the source of truth.
- Decompression is a single PG function `harness_shared.llm_test_transcript_raw(run_id)` returning `text` — pgcrypto-style helper; the UI uses it on the run-detail page only.


---

## 8. UI — `/tests` "LLM" subtab

Sits next to the existing planned tabs (Chaos / AI Explore / Live metrics / Routes / Packaged build). Route: `/tests?tab=llm`.

### 8.1 Sections

```
LLM testing
├─ Targets        ← list of registered ChatTargets, link to scenarios
├─ Scenarios      ← per-target scenario library, run / dry-run / replay buttons
├─ Runs           ← table of llm_test_runs, filter by target/scenario/status
└─ Findings       ← unacknowledged findings across all runs, severity-sorted
```

### 8.2 Run-detail view

Single page per `runs/[id]`:

- Header: scenario, target, persona, models, status, scores, total cost
- Transcript pane: chronological turn list. Each turn shows
  - sim-user thought (collapsible)
  - sim-user action
  - SUT assistant text
  - tool calls (expandable JSON)
  - cards (rendered + JSON toggle)
  - control tags
  - per-turn telemetry strip (latency, cost, tools-fired count)
- Right rail: deterministic violations (red/yellow chips), judge findings (one card each, with `axis`, `severity`, evidence-turn-link, suggestion, **`Copy as agent prompt`** button)
- Footer: re-run buttons (live / replay / judge-only / different judge model)

### 8.3 The "copy as agent prompt" button

Generates a self-contained markdown block:

```
The operator chat in scenario `op-active-multistep-issues` exhibits the
following issue:

**Finding:** <claim>
**Severity:** <severity>
**Evidence:** turn <idx> of run <run_id> — <quoted snippet>
**Suggestion:** <suggestion>

Please investigate. Run the scenario locally with:
  npm run llm-test -- --scenario op-active-multistep-issues
…full transcript attached below…
```

Admin pastes that into a fresh agent session. Matches the "nothing auto-implemented" rule.

### 8.4 nuqs state

- `?tab=llm` — outer tab
- `?subtab=targets|scenarios|runs|findings` — inner section
- `?target=<id>` — filter
- `?status=...` — filter
- `?run=<uuid>` — opens run-detail in a side panel without navigating

(per global nuqs-default rule)


---

## 9. Cost & runtime model

Per scenario, **honest envelope** (Sonnet SUT via dispatcher; Sonnet judge default with Opus opt-in; 2026 prices: Sonnet ~$3/M in + $15/M out, Opus ~$15/M in + $75/M out, Haiku ~$0.80/M in + $4/M out). Math accounts for cumulative-context growth — sim-user and SUT both re-read the transcript each turn.

**Single run, 10-turn conversation, judge-once:**

| Component | Per-turn input | Per-turn output | Turns | Tokens total | $ at Sonnet/Sonnet | $ at Sonnet/Opus |
|---|---|---|---|---|---|---|
| Sim-user (Haiku) | 1.5k turn 1 → ~12k turn 10 (sees full transcript) | ~150 out | 10 | ~70k in / 1.5k out | $0.06 | $0.06 |
| SUT (Sonnet) | 4k turn 1 → ~20k turn 10 | ~500 out | 10 | ~120k in / 5k out | $0.43 | $0.43 |
| Judge (1 pass) | 30k in (full transcript + rubric + assert results) | 1k out | 1 | 30k in / 1k out | $0.10 | $0.53 |
| Telemetry / replay | — | — | — | — | $0 | $0 |
| **Total per run** | | | | | **$0.59** | **$1.02** |

**With `runMatrix.repeat: 3` and multi-pass judging on `criticality: high`:**

| Mode | Per-scenario cost |
|---|---|
| N=1, judge once, Sonnet judge | $0.59 |
| N=3, judge once each, Sonnet judge | $1.77 |
| N=3, judge twice each, Sonnet judge (high criticality) | $2.36 |
| N=3, judge once each, Opus judge | $3.06 |

**Full 12-scenario operator suite** — mix of `repeat` per §2.4 (3× S07/S12 at N=1, 7× scenarios at N=3, 2× high-criticality scenarios at N=3 with multi-pass):
≈ $18–30 per full pass.

For a nightly cron that's ~$650–900/month. Cheap enough to run, expensive enough that "run all from the UI" needs a confirm dialog.

### 9.1 Replay (no SUT, no sim-user)

One verb, two flavours — replaces the earlier `--dry-run` / `--judge-only`:

- `pnpm llm-test replay --fixture <id>` — re-runs only the **judge** against a stored fixture's transcript. Verifies the rubric still holds. ~$0.10 per scenario at Sonnet, ~$0.50 at Opus.
- `pnpm llm-test replay --re-evaluate <run-id>` — same idea, but against a historical *run* rather than a frozen fixture. Useful after a rubric edit.

### 9.2 CLI knobs

- `--scenario <id>` — run one.
- `--target operator` — run one target's full set.
- `--seed <n>` — deterministic temperature/seed (sim-user temp 0.3, judge temp 0).
- `--no-matrix` — force N=1 even if scenario declares `runMatrix.repeat > 1`. For interactive iteration; full report needs matrix.
- `--parallel <n>` — run distinct scenarios in parallel. **Bounded by SUT single-flight**: see §9.3.

### 9.3 Parallelism caveats

The converse route accepts one in-flight generation per `conversationId`. Distinct `runId` ⇒ distinct `conversationId` ⇒ safe in parallel **provided the route handler doesn't share per-process state machine that single-flights regardless of session**. Phase 0 includes a smoke test that spins up 4 parallel runs against `chat_target='operator'` and asserts independent telemetry / no cross-talk in `tool_invocations`. If the smoke test fails, `--parallel` defaults to 1 until the route is fixed.

Wallclock per scenario: ~30–90s on `in-process` transport, ~60–120s on `http-sse`. Suite of 12 sequential at N=3: ~30–60 min. With `--parallel 4` (assuming the smoke test passes): ~10–15 min.


---

## 10. Initial operator suite — coverage matrix

This section is the answer to "make sure the framework can hit all code paths." It enumerates operator behaviors and pairs each with at least one scenario. Scenarios live at `apps/operator/lib/llm-testing/scenarios/operator/*.ts`; one file per scenario, exporting a `Scenario` object.

### 10.1 Behavior catalog (what the operator can do)

Sourced by reading `OperatorConversationProvider`, the operator system prompt, and the converse route — not from memory.

| # | Behavior | Code surface |
|---|---|---|
| B1 | Plain reply, terminal `?` → auto-fire `user_says_ready` (V8) | provider `runGeneration` post-turn |
| B2 | Plain reply, terminal `.` → no auto-fire | same |
| B3 | `<continue/>` chain, count cap (default 5) | provider continue-chain ledger |
| B4 | `<continue/>` chain, time cap (default 300s) | same |
| B5 | `<continue/>` chain reset on user input | `sendUserMessage` / `onVoiceUserTurn` |
| B6 | `<sleep/>` honored mid-chain | provider sleep handler |
| B7 | `<spawn role="…" feature="…"/>` dispatched | converse route → `harness:spawn` |
| B8 | Passive mode silences auto-fire + continue | pref `proactiveTicksEnabled=false` |
| B9 | Silence-nudge after 30s `awaiting_reply` → Ready card | `/api/operator/conversations/[id]/silence-nudge` |
| B10 | "Generate Ideas" trigger (button / `Cmd+Shift+I`) | `operator.generateIdeas` shortcut |
| B11 | `chat:ask_choice` card emission + answer | `ctx.askUser({ presentation: 'radio' })` |
| B12 | Bespoke card via `ctx.askUser` + `ctx.publishState` | bespoke-card arc |
| B13 | `voiceAnswerable: true` cards answerable by voice | voice-aware-cards |
| B14 | `docs:*` tool usage when asked about Papercup | docs-retrieval Phase 1 |
| B15 | `search:fulltext` / `search:semantic` on recall | search tools |
| B16 | `harness:status` / `features:get` / `issues:list` | harness tools |
| B17 | `mem0:recall` at session start (if mem0 enabled) | provider boot |
| B18 | `mem0:write` at turn end (significant turns only) | provider close-of-turn |
| B19 | `messages:feature_send` to other agents | feature-message tool |
| B20 | Role-gated tool denied (operator can't call worker-only verbs) | endpoint-system gating |
| B21 | Tool error surfaces as `tool_call` with `error` payload, brain recovers | converse loop |
| B22 | Mid-stream client disconnect → server cleans up, next turn starts fresh | route abort handler |
| B23 | Modality switch text → voice in same session | `modality` field |
| B24 | Quiet-wait resume after canvas open | `open_canvas` / `quiet_wait_resume` |
| B25 | Budget exceeded → graceful refusal, not crash | budget gate |
| B26 | Plugin tool invocation routed correctly | plugin runtime |
| B27 | Hallucinated tool name → not called, brain self-corrects | judge-driven |
| B28 | Premature termination ("Checking…" with no continue) | judge-driven (V8 F1) |
| B29 | Tone holds under hostile user input | judge-driven |
| B30 | Doesn't repeat itself across continue chain | judge-driven |

### 10.2 Scenario → behavior map

12 scenarios cover B1–B26 deterministically; B27–B30 are judge-only (any scenario can hit them).

| Scenario | Persona | Goal | Covers | Asserts (selected) |
|---|---|---|---|---|
| `S01-status-quick` | Brief admin | "what's the status of sheets" | B1, B14, B16, B17, B18, B28 (judge) | `tool_called: harness:status`, `auto_fire_happened: user_says_ready`, `latency_under: p95=8000` |
| `S02-multistep-investigation` | Patient admin | "list open issues by severity and tell me which to fix first" | B3, B5, B15, B16, B28 (judge) | `tool_called: issues:list`, `continue_chain_within_cap: 5/300`, `control_tag_present: continue` |
| `S03-continue-cap-count` | Adversarial (asks for "exhaustive enumeration of every feature") | force the cap | B3, B4 | `continue_chain_within_cap`, `finish_reason_is: cap_reached` |
| `S04-continue-cap-time` | Same | force the time cap with slow tool mocks | B4 | same |
| `S05-sleep-tag` | Admin asks for low-priority background work | B6 | `control_tag_present: sleep`, `auto_fire_did_not_happen` |
| `S06-spawn-worker` | Admin asks operator to dispatch worker to fix issue | B7, B19 | `spawn_dispatched: role=worker`, `tool_called: messages:feature_send` |
| `S07-passive-mode` | Admin in passive | sets pref, asks question | B8 | `auto_fire_did_not_happen`, `control_tag_present: continue, maxCount=0` |
| `S08-silence-nudge-ready` | Admin goes idle 30s mid-conversation | runner triggers silence-nudge | B9, B13 | `card_emitted: kind=ready, voiceAnswerable=true`, follow-up `trigger=user_says_ready` resumes |
| `S09-generate-ideas` | Admin clicks Generate Ideas after long pause | runner fires `generate_ideas` trigger | B10 | `tool_called: docs:* or search:*` (something productive), `text_excludes: "I don't know"` |
| `S10-ask-choice` | Ambiguous question that should produce a choice card | B11, B12 | `card_emitted: kind=choice, optionsInclude=[…]` |
| `S11-voice-card-answer` | Voice modality, gets a choice card, answers by voice | B13, B23 | `card_emitted: voiceAnswerable=true`, sim-user follow-up turn with `modality=voice` resolves it |
| `S12-tool-error-recovery` | Admin asks for harness status, runner injects `harness:status` failure via tool-mock | B21, B22 | `tool_called: harness:status (failure)`, next assistant turn does NOT loop on the same call |

Each scenario file is ~50–120 lines. The runner orchestrates; scenarios are declarative.

### 10.3 What's deferred (not in initial suite)

- **B20** (role-gated denial): operator role can't easily trip this from a sim conversation; covered by route-level unit tests already.
- **B24** (canvas-open quiet-wait): requires UI state — defer to UI-test framework on `/tests`.
- **B25** (budget gate): non-deterministic without budget-injection helper; flagged as a runner follow-up.
- **B26** (plugin tools): wait until plugin lifecycle is stable; one targeted scenario lands when ready.

### 10.4 Tool-mock layer — in-process `ToolDispatchOverride`

Reviewer pushback rejected the original "middleware keyed on `uiClientId` prefix" design — it would leave a permanent test-only branch in the prod converse pipeline that subtly drifts from real behavior. Replaced with two cleaner shapes:

**Default: in-process call with `ToolDispatchOverride`.**

The endpoint system already says "the function is the source of truth, transports are projections" (`/docs/endpoint-system/overview`). The operator `ChatTarget` calls the converse *handler* directly with a per-run dispatcher override, bypassing the HTTP route entirely:

```ts
interface ToolDispatchOverride {
  override(name: string, args: unknown): Promise<ToolResult | typeof PASS_THROUGH>;
}

// In apps/operator/lib/llm-testing/targets/operator.ts:
const dispatcher = makeOperatorDispatcher({
  override: (name, args) => {
    if (name === 'harness:status') return Promise.resolve({ error: 'PG unavailable' });
    if (name === 'features:list') return slowResult({ delayMs: 60_000, value: [...] });
    return PASS_THROUGH;  // fall through to real dispatcher
  }
});
await runConverseHandler({ ...input, dispatcher });
```

`ToolDispatchOverride` is part of the production dispatcher interface — always present, but only populated for test runs. No conditional in the route handler.

**Opt-in: `transport: 'http-sse'`.**

A small tier of scenarios *needs* the real transport edge because the behavior under test only exists there:

| Behavior | Why http-sse is required |
|---|---|
| B21 tool error mid-stream | Tests the route's SSE `error` framing |
| B22 mid-stream client disconnect | Tests the route's abort handler |
| (future) rate-limit / CORS / auth | Transport-level |

These scenarios declare `transport: 'http-sse'` and the operator `ChatTarget` switches to the HTTP POST path. The `ToolDispatchOverride` *still works* — it's injected via a request header (`X-Tool-Dispatch-Override-Id: <runId>`) and the converse handler reads it from the request context. The handler conditional becomes "is there an override?" rather than "does the uiClientId start with `llm-testing/`?" — narrower contract, no test-specific strings in prod code paths.

Of the initial 12 scenarios: **S12** (tool-error recovery) declares `transport: 'http-sse'`. S04 (continue-cap-time) could go either way; default `in-process` is fine since the cap logic lives in the provider/handler, not the transport.

Without overrides at all, the framework runs against real tools — most scenarios should. Overrides exist for failure paths and slow-tool paths.

---

## 11. Future targets (not built now, but the abstraction must support them)

Each gets its own `ChatTarget` implementation; scenarios reuse `Persona` / `Judge` / `Assert` infra unchanged.

| Target | Transport | Distinct behaviors to test |
|---|---|---|
| **architect** | converse route w/ `role=architect` | chunk decomposition quality, refusal-to-scope when context missing, plan-doc structure |
| **scoper** | spawn-driven, sub-process | feature → chunks splitting, dependency detection, scope discipline |
| **worker** | spawn-driven | tool-use breadth, plan adherence, commit-discipline (judge reads diff) |
| **validator** | spawn-driven | catches seeded regressions, doesn't rubber-stamp |
| **reviewer** | spawn-driven | catches scope creep, demands tests when missing |
| **brain-debug** | dev-only chat at `/dev/brain-debug` | raw-prompt visibility, no card layer |
| **oracle** | read-only Q&A | citation accuracy, refusal to speculate beyond docs |
| **voice** | ElevenLabs Conv AI / OpenAI Realtime | actual voice transport — turn-taking, barge-in, transcription accuracy, TTS latency. Distinct from the `speakability` axis of §6.1 which only scores the text the operator emits. |

Order of adoption: operator (now) → brain-debug (cheapest, same transport) → architect → worker → others. **Voice last**, and only after the transport stabilizes. Each target's `ChatTarget` is ~150–300 LoC + a behavior catalog like §10.1.

---

## 12. Phasing

### Phase 0 — schema + plumbing + telemetry foundation (1 day, was 0.5)

Phase 0 now carries more weight after review — it's the foundation everything else depends on.

- **Migration 073**: `llm_test_runs`, `llm_test_findings`, `llm_test_fixtures`, **`operator_continue_chains`** (promoted from follow-up per §5.3), plus the `llm_test_matrix_results` view per §7.1.
- **Telemetry-tagging audit test** (§5.4): `__tests__/telemetry-tagging-audit.test.ts` enumerates every projected tool and asserts `uiClientId` flows to `metadata_json`. Wired into CI as a gate.
- **Continue-chain ledger writes**: operator provider/handler emits one `operator_continue_chains` row per turn in a continue chain — this unblocks deterministic B3/B4 asserts in Phase 2.
- **`apps/operator/lib/llm-testing/` package skeleton**: `types.ts`, `runner.ts`, `judge.ts`, `targets/`, `scenarios/`, `personas/` (`traits.ts` + `blends.ts` per §3.2), `asserts/`, `__tests__/`.
- **`ToolDispatchOverride` interface** added to the production dispatcher (§10.4) — no test-mode branching, just an always-present optional override.
- **CLI entry** `apps/operator/bin/llm-test.ts` (`pnpm llm-test …` — supports `--scenario`, `--target`, `--no-matrix`, `--parallel`, `replay --fixture`, `replay --re-evaluate`, `promote-candidates`, `promote --shape`).
- **`/tmp/v8-e2e-recordings/` migration**: copied into `apps/operator/lib/llm-testing/fixtures/operator/` as version-controlled fixtures (per §13.7 of v1).
- **Parallelism smoke test** (§9.3): asserts 4 parallel runs don't share per-process state.

### Phase 1 — operator target + 3 scenarios + framework self-validation gate (1 day)

- `targets/operator.ts` with all 5 sub-features (§4.1–4.5).
- Scenarios S01, S02, S08 — happy path, multistep, silence-nudge.
- Judge with operator rubric (§6.1).
- **Framework self-validation gate (binding)**: Phase 1 is complete only when both of these hold:
  - **S02 fails against current operator code** (catches the V8 F1 bug — "brain narrated intent without `<continue/>`") with a `terminationFit` finding referencing the offending turn.
  - **S02 passes against a hand-patched operator** that emits `<continue/>` after "Checking…" narration, verifying the failure was real and the fix would clear it.
- This concrete pre/post gate replaces the softer "if S02 catches it, the framework works" — turns the framework's self-validation into a binary signal.

### Phase 2 — remaining 9 scenarios + `ToolDispatchOverride` payloads (1 day)

- S03–S07, S09–S12 per §10.2.
- `ToolDispatchOverride` payloads per scenario (§10.4).
- S12 declares `transport: 'http-sse'`; rest stay `in-process`.
- All matrix-eligible scenarios opt into `runMatrix: { repeat: 3 }` (§2.4).

### Phase 3 — `/tests` "LLM" subtab (1 day)

- Per §8 — targets / scenarios / runs / findings sections.
- Read-only views first; "run scenario" button second.
- Findings copy-as-prompt.

### Phase 4 — second target (0.5 day)

- `targets/brain-debug.ts` to prove the abstraction. ~3 scenarios.
- If the abstraction creaks here, refactor *before* adding more targets.

### Phase 5 — nightly run + alerts (0.5 day)

- Systemd timer (matches existing `/Backup` cadence) → `pnpm llm-test --target operator --all`.
- Alert via existing escalation surface when new findings appear or pass-rate drops.

Total: **~4 dev-days** for ship-ready operator coverage (was 3.5; Phase 0 grew by 0.5 to cover telemetry audit, continue-chain ledger, and the `ToolDispatchOverride` interface). +0.5 per additional target.

---

## 13. Open questions — resolved by Round-2 review

All resolved. Decisions baked into the relevant sections; recorded here for trail.

1. **Workspace isolation default** → **isolated** per-run (§4.5). `realWorkspace: true` opt-in for B17 mem0 scenarios.
2. **Judge model** → **Sonnet default** with `criticality: 'high'` scenarios upgrading to Opus on multi-pass (§6.4, §9 cost math).
3. **Sim-user model** → **Haiku** with composed-from-traits persona prompts (§3.2, §9).
4. **Transcript format** → **both** — `transcript_raw_zstd` (compressed verbatim) + `transcript_norm_json` (denormalised for diff/search) per §7.1, §7.3.
5. **Continue-chain ledger** → **blocks** Phase 0 (§5.3, §7.1 `operator_continue_chains`, §12 Phase 0).
6. **Scenario versioning** → `Scenario.version` field; `llm_test_runs.scenario_version` column; UI groups by `(scenario_id, scenario_version)`. Plus `identity_hash` for finer-grained trend comparability (§7.1).
7. **`/tmp/v8-e2e-recordings/` migration** → done in **Phase 0** (§12 Phase 0).

---

## Appendix: file layout

```
apps/operator/lib/llm-testing/
├── types.ts                  # ChatTarget, Scenario, Persona, Judge, Assert
├── runner.ts                 # orchestrator
├── judge.ts                  # judge prompt + rubric evaluation
├── dispatch-override.ts      # ToolDispatchOverride wiring (§10.4)
├── targets/
│   ├── index.ts
│   ├── operator.ts           # Phase 1
│   └── brain-debug.ts        # Phase 4
├── personas/
│   ├── traits.ts             # PersonaTraits type + prompt composition
│   └── blends.ts             # named blends: brief-admin, patient-admin, …
├── asserts/
│   ├── index.ts
│   ├── tool.ts
│   ├── text.ts
│   ├── card.ts
│   ├── control-tag.ts
│   ├── auto-fire.ts
│   ├── continue-chain.ts     # uses operator_continue_chains table
│   └── latency.ts
├── scenarios/
│   └── operator/
│       ├── S01-status-quick.ts
│       ├── S02-multistep-investigation.ts
│       └── … (12 total)
├── rubrics/
│   └── operator.ts           # axes incl. speakability (was voiceFit)
├── fixtures/
│   └── operator/             # version-controlled SSE tapes, migrated from /tmp/v8-e2e-recordings/
├── __tests__/
│   ├── telemetry-tagging-audit.test.ts  # §5.4 CI gate
│   └── parallelism-smoke.test.ts        # §9.3
└── promotion/
    ├── candidates.ts          # `llm-test promote-candidates` (§6.6)
    └── promote.ts             # `llm-test promote --shape <hash>`

apps/operator/bin/llm-test.ts # CLI entry
apps/operator/app/tests/llm/  # /tests "LLM" subtab UI
db/migrations/073_llm_testing.sql
```
