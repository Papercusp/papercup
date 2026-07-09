# Authoring an LLM-testing scenario

A scenario is one declarative TypeScript file under
`apps/operator/lib/llm-testing/scenarios/<target>/<id>.ts`. The runner
imports it, drives a sim-user / SUT / judge loop, asserts, and persists.

This guide is what you read **before** writing a new one. It assumes
the framework's already running — see
`apps/operator/docs/plans/llm-testing-phase1-status-2026-05-14.md` for
where the pieces live.

---

## 1. Decide the question your scenario answers

A good scenario is one specific question about chat behavior, phrased
so the answer is unambiguously yes/no per run. Bad framings:
- "Is the operator good at status questions?" (too broad)
- "Does the operator never hallucinate?" (untestable absolute)

Good framings:
- "When a user asks for sheets harness status, does the operator call
  `harness:status` at least once and avoid `<continue/>` chains?"
- "When a user types a vague request, does architect ask a clarifying
  question in turn 0 rather than proposing immediately?"

Write the question in the file's top-of-file comment before you write
the scenario object. If you can't write it crisply, the scenario isn't
ready.

---

## 2. Pick a target

`apps/operator/lib/llm-testing/targets/index.ts` lists what's registered:
- **`operator`** — the chat surface at `/api/agent-mcp/operator-converse`
- **`oracle`** — read-only assistant at `/api/oracle/chat`
- **`architect`** — harness-scoped, at `/api/agent-tools/architect/chat`

If the behavior you want to test lives in a different surface, add a
target first (see `targets/operator.ts` as the most fleshed-out example).

---

## 3. Pick a persona

`personas/blends.ts` has six named blends. Each is a `PersonaTraits`
combination (verbosity × politeness × clarification × goalClarity ×
interrupts × modality × domain):

| Blend          | Tone                                  |
|----------------|---------------------------------------|
| `BRIEF_ADMIN`  | terse / neutral / precise             |
| `PATIENT_ADMIN`| normal / polite / sometimes-clarifies |
| `ADVERSARIAL`  | verbose / rude / shifting goals       |
| `VOICE_USER`   | voice modality                        |
| `HOSTILE`      | terse / rude / interrupts             |
| `PEDANTIC_DEV` | verbose / always-clarifies            |

For one-off variants, inline a traits object directly:

```ts
persona: {
  id: 'vague-prompter',
  description: 'User asks intentionally ambiguous prompts.',
  traits: {
    verbosity: 'terse',
    politeness: 'neutral',
    clarification: 'never_clarifies',
    goalClarity: 'vague',
    interrupts: false,
    modality: 'text',
    domain: 'admin',
  },
},
```

The persona's traits compose into the sim-user system prompt at
runtime (see `personas/traits.ts`). Composing is append-only — adding
a new trait won't break existing scenarios.

---

## 4. Write the scenario file

```ts
// scenarios/operator/S99-example.ts
import { BRIEF_ADMIN } from '../../personas/blends';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario } from '../../types';

export const S99_EXAMPLE: Scenario = {
  id: 'op-S99-example',
  version: 1,
  target: 'operator',
  description: 'A one-paragraph description. The judge sees this.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 6, maxWallSecs: 90, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    { kind: 'tool_called', name: 'harness:status', minTimes: 1 },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default S99_EXAMPLE;
```

Register it in `scenarios/index.ts`:
```ts
import { S99_EXAMPLE } from './operator/S99-example';
export const SCENARIOS = [..., S99_EXAMPLE];
```

Update the registry test in `__tests__/runner-aggregate.test.ts` so
the registry assertion stays accurate.

### Field guide

- **`id`** — convention is `<target-prefix>-S<NN>-kebab-name` for
  operator, `O<NN>` for oracle, `A<NN>` for architect.
- **`version`** — bump when the behavior contract changes (not when
  you tweak the description). Combined with the persona traits and
  rubric version into the `identity_hash` for trend lines.
- **`description`** — fed verbatim into the judge prompt. Be concrete
  about what success looks like.
- **`goal`** — the sim-user's success criterion:
  - `'user_satisfied'` — sim decides when to stop (most common)
  - `'tool_fired'` — sim succeeds as soon as the SUT calls `toolName`
  - `'card_emitted'` — same for cards
  - `'state_reached'` — free-form predicate the sim self-evaluates
- **`caps`** — hard budgets. The runner stops when any cap is hit and
  records a `cap_breach`. Use generously — caps are safety nets, not
  the assertion mechanism.
- **`runMatrix.repeat`** — N=3 default for judge-heavy scenarios,
  N=5 for tone-sensitive ones, N=1 only for purely-deterministic checks.
- **`runMatrix.variancePolicy`** — `flag-if-stddev>0.5` is the default;
  `flag-if-disagreement` catches pass/fail flips across runs.
- **`realWorkspace`** — set `true` if the scenario depends on workspace
  state (harness contents, mem0 history, voice prefs). Defaults
  `false` (isolated per-run workspace).
- **`triggers`** — scripted triggers fired at specific turn indices:
  ```ts
  triggers: [{ on: 'after_turn', fire: 'user_says_ready', param: 0 }],
  ```
  Used when the FIRST turn is something other than a sim-user message
  (e.g. S09 generate-ideas, S08 silence-nudge follow-up).
- **`toolOverride`** — deterministic injection. See §6 below.

---

## 5. Pick deterministic asserts

Each scenario should have at least one deterministic assert — the
judge alone is too noisy to be the only signal. Available kinds (full
list in `types.ts → DeterministicAssert`):

| Kind | Use when |
|------|----------|
| `tool_called` / `tool_not_called` | A specific tool MUST or MUST-NOT fire |
| `text_contains` / `text_excludes` | A specific phrase must appear / be absent |
| `card_emitted` | A particular card kind must be emitted (with options / voiceAnswerable optional) |
| `control_tag_present` | `<continue/>` / `<sleep/>` / `<spawn/>` count |
| `auto_fire_happened` / `auto_fire_did_not_happen` | V8 ledger-derived |
| `continue_chain_within_cap` | Chain elapsed time / turn count |
| `latency_under` / `cost_under` / `finish_reason_is` | Budget guards |
| `mem0_wrote` / `mem0_read` / `spawn_dispatched` | PG telemetry |
| `custom` | One-off predicate with `name` + `eval(run)` |

A `custom` assert lets you write a one-off predicate without extending
the kind enum:
```ts
{
  kind: 'custom',
  name: 'first-turn-has-question',
  eval: (run) => {
    const t0 = run.turns[0];
    if (!t0 || !t0.assistantText.includes('?')) {
      return [{
        assertKind: 'custom:first-turn-has-question',
        severity: 'error',
        evidenceTurnIdx: 0,
        claim: 'Expected a clarifying question in turn 0.',
        suggestion: 'Architect should ask, not propose, on vague asks.',
      }];
    }
    return [];
  },
},
```

If you find yourself writing the same `custom` shape in 3+ scenarios,
promote it to a built-in kind (or run `pnpm llm-test
promote-candidates` once novel judge findings recur — see §8).

---

## 6. (Optional) Inject failures with `toolOverride`

When the natural path can't reliably trigger the behavior you want to
test, use a `toolOverride`:

```ts
import { makeStaticOverride } from '../../dispatch-override';

toolOverride: makeStaticOverride({
  'harness:status': { error: 'PG unavailable (synthetic)' },
  'mcp__agentmcp__harness:status': { error: 'PG unavailable (synthetic)' },
}),
```

The framework registers the override against `runId` before the
session opens. Every tool call the brain makes during the run with
that `uiClientId` consults the registry. Cover both the plain name
and the `mcp__agentmcp__<name>` form — the brain's MCP transport
sometimes prefixes.

Available helpers (`dispatch-override.ts`):
- `makeStaticOverride({ name: result-or-error })` — fixed responses
- `makeSlowOverride({ name: { delayMs, result } })` — adds latency
- `chainOverrides(a, b, c)` — first-match-wins composition

The dispatcher's `PASS_THROUGH` papercup lets the real handler run
when the override doesn't match. `makeStaticOverride` returns
PASS_THROUGH automatically for unmapped tools.

---

## 7. Use the right rubric

Each target has a default rubric:
- `rubrics/operator.ts` — 7 axes (helpfulness, groundedness, terminationFit,
  cardUsage, tone, tools, speakability)
- `rubrics/oracle.ts` — 7 axes (replaces cardUsage with citationAccuracy,
  adds speculation)
- `rubrics/architect.ts` — 6 axes (clarificationDepth, scopePrecision,
  structuralOutput specific to architect)

For most scenarios, use the target's default rubric. Override only if
the scenario tests a behavior the default rubric doesn't capture (e.g.
a critical scenario that warrants multi-pass judging — set the rubric's
`criticality: 'high'`).

---

## 8. Run it locally

```bash
export ANTHROPIC_API_KEY=sk-ant-…
cd papercusp-desktop && npm run dev   # in another terminal

cd apps/operator
pnpm llm-test --scenario op-S99-example --no-matrix
```

`--no-matrix` forces N=1 for fast iteration. Drop it for the real run.

The output prints per-run status + a one-line summary; the full result
also persists to `harness_shared.llm_test_runs` for the UI
(`/admin/testing?tab=llm&subtab=runs`) to render.

---

## 9. Iterate on findings

Look at the run row in the UI:
- **Asserts column** — your deterministic checks, errors in red
- **Judge column** — qualitative findings; each has a `copy as agent
  prompt` button that emits a markdown block you can paste into a
  fixer agent's session
- **Promotion column** in the cross-run findings view —
  `recurring 2×` / `candidate 3×` / `promoted` for shapes that have
  shown up across multiple scenarios

If a judge finding keeps surfacing across scenarios, run:
```bash
pnpm llm-test promote-candidates
pnpm llm-test promote --shape <hash>
```

The second command scaffolds `asserts/promoted-<short>.ts` you fill
in. The originating findings get marked `promoted_to_assert_id` so
the lineage is auditable.

---

## 10. Things to avoid

- **Don't write absolutist asserts.** `tool_called: 'X', minTimes: 5,
  maxTimes: 5` is brittle. The brain is non-deterministic; ranges
  work better than equalities.
- **Don't lean only on the judge.** Judge noise = test noise. Every
  scenario should have at least one deterministic assert pinning down
  the load-bearing behavior.
- **Don't author over an unstable feature.** If the operator behavior
  you're testing is in active flux, write the scenario *with the
  feature owner* and bump `version` whenever the contract changes.
- **Don't smuggle the assertion into the prompt.** "Make sure to call
  harness:status" in the persona prompt biases the test — the persona
  speaks as a USER would, not as a tester.
- **Don't N=1 a judge-heavy scenario.** With LLM variance, N=1
  pass/fail is noise. Either use N=3+ or rely entirely on
  deterministic asserts.

---

## 11. Quick reference — file structure for one scenario

```
apps/operator/lib/llm-testing/
├── scenarios/
│   └── <target>/
│       └── <ID>-name.ts        ← export default SCENARIO
├── scenarios/index.ts          ← register it
└── __tests__/runner-aggregate.test.ts  ← update the registry assertion
```

Run `pnpm llm-test --list` to confirm it shows up.
