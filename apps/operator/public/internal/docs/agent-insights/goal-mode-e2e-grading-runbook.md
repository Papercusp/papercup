# Runbook: grading a GOAL-mode run against the goal-mode-e2e rubric
URL: /internal/docs/agent-insights/goal-mode-e2e-grading-runbook

Runbook for the goal-mode-e2e rubric's methodRef: how to establish the subject and run window, which store answers which question (the two-store trap that silently zeroes half the criteria), when unknown beats fail, and how to file the scorecard so the trend stays honest.

This is the long-form method behind the `goal-mode-e2e` rubric (`methodRef: goal-mode-e2e-grading-runbook`). The rubric itself carries a per-criterion `model` / `method` / `driftMarkers` / `replication` drill — **read those from `rubrics:get`, they are not duplicated here.** This runbook covers what a per-criterion field cannot: how to set up the grading pass, which of the traps below will silently produce a clean-looking wrong answer, and how to file so the trend means something.

## What this rubric grades

ONE RUN of ONE GOAL-mode agent, against the binding clauses of the GOAL contract (`packages/operator-core/lib/modes/registry.ts`, the `goal` entry in `MODES`).

It does **not** grade whether the goal succeeded. A goal can be well-managed and still fail on the merits, and an agent can reach a good outcome while breaking most of the contract. Grading the outcome instead of the conduct is the single most common way this rubric gets misused — and it is tempting precisely because the outcome is the thing everyone cares about.

## Step 0 — pin the SUBJECT and the RUN WINDOW before gathering anything

Every drill in the rubric is parameterised by `:subject` (the graded agent's coord ownerId, `su-<uuid>`) and `:run_start` / `:run_end`. Establish all three first and write them into the scorecard body, because **the observation schema has nowhere structured to record them** — `sourceHive` is where the observation came FROM and `targetHive` is which pot it is ABOUT; neither says which RUN of which AGENT this grades.

That gap is not cosmetic. Every scorecard filed against v1 of this rubric left `subjectRef` null, and three of the five were corrections of one another — so `rubrics:trend` reported `scorecardCount: 5` and per-criterion directions (`improving`, `worsening`) for what was **one run scored three times.** Until the schema carries a subject, the subject lives in your title and body, and a re-grade MUST be linked as a supersession (see *Filing*, below).

Find the subject's mode rows and window:

```sql
SELECT owner_id, mode, subject, set_by, owner_directed, set_at
FROM harness_shared.agent_modes
WHERE workspace_id = 'papercusp-workspace' AND owner_id = :subject
ORDER BY set_at;
```

A GOAL row with `subject IS NULL` is itself a finding (see `mode-and-subject-integrity`): `subject` is what downstream consumers join on, so an unset one does not fail loudly, it silently zeroes `work_items.goal_id` and the goal stop's session attribution.

## Step 1 — the two-store rule, and the zero that lies

**This is the trap that costs a whole criterion, and it fails toward a false PASS.**

Two different stores answer "what did this agent do", and they do not overlap:

| you want to know                                                                              | read                                                                            | scoped to                              |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| which **MCP tools** the agent called (`goals:create`, `fleet:launch-on-plan`, `plans:new`, …) | `harness_shared.tool_invocations` (`coord_owner_id`, `tool_name`, `invoked_at`) | `workspace_id = 'papercusp-workspace'` |
| which **native client tools** it used (`Edit`, `Write`, `Bash`, `Read`)                       | `harness_shared.session_turn_parts` (`owner`, `tool_name`, `part_kind`, `ts`)   | `workspace_id = 'default'` ⚠           |

Both halves bite:

1. **`tool_invocations` never records native tools.** Measured over 24h in `papercusp-workspace`: `capability:bash` 2031, `capability:read` 73, `capability:edit` 17 — and zero rows for `Edit` / `Write` / `Bash`. An agent that edits code the ordinary way leaves no row here at all.
2. **`session_turn_parts` is scoped `workspace_id='default'`, not `papercusp-workspace`.** Filtered to `papercusp-workspace` the ENTIRE TABLE returns zero rows. `dev:pg_query`'s tenant advisory will actively push you toward the wrong predicate here, because it is right about every other table.

The two compose into a trap that feels like corroboration: you query `tool_invocations`, get a clean zero, correctly reason "I should use the transcript store instead", query `session_turn_parts` with the habitual workspace predicate, and get a *second* clean zero. Two independent sources agreeing is normally strong evidence. Here it is the same mistake twice. (Filed as `EI-20103748074297088`.)

### Falsify every zero before you trust it

**Rule: no criterion may be rated on a zero until the same query has returned a large non-zero against a known-positive control.** For anything code-edit-shaped, the control is any active builder agent:

```sql
SELECT owner, count(*) FILTER (WHERE tool_name IN ('Edit','Write','MultiEdit')) AS code_edits
FROM harness_shared.session_turn_parts
WHERE workspace_id = 'default' AND ts > now() - interval '24 hours' AND owner IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC LIMIT 5;
```

Active builders measure in the hundreds per day (observed 245–541). **If a builder returns 0, your query is wrong — not the agent's behaviour.** Only once the control lights up is a zero for `:subject` meaningful, and for `never-implements` a genuine zero is the whole point of the criterion.

## Step 2 — `unknown` beats `fail`, and it beats `pass` too

The rating scale is inherited from `su-agent-behavior`: `exemplary | pass | partial | fail | severe | unknown`.

**Never score a platform gap as agent failure.** If a clause names a route the platform cannot express yet, the agent could not have complied, and a `fail` there is a lie about a person. Rate `unknown`, and **name the blocking work-item in the evidence** so the next grader can check whether the wall lifted instead of inheriting a bare instruction. Known walls as of v2:

* `standing-drain-fleet-per-goal` — the contract specifies a lane scoped by the positive goal leaf `{ field:'goal', op:'=' }`, but `goal` is not yet in claim-spec `ITEM_FIELDS` (**WI-37711**). Grade fleet existence, liveness and re-establishment; rate the lane shape `unknown`.
* `mode-and-subject-integrity` — the goal-provenance path has never stamped a row (0 of 4,692 `session_briefs`, 0 of 37,579 `work_items`), fully explained by live goal agents running via `agent_modes.subject` and having claimed no work-items. Rate the `goal_id` leg `unknown` until a goal agent actually claims work.

The symmetric error matters as much: **a criterion you did not actually check is `unknown`, not `pass`.** A pass asserts you looked.

This discipline has a shelf life by design. A defensive "rate this unknown" note is invisible once its wall lifts — nothing re-checks it, and it quietly decays from a safeguard into a permanent blind spot. v1 carried exactly such a note for two criteria whose tool had since shipped; v2 deleted it. **When you find a wall has lifted, delete the note in the same pass** rather than leaving it to protect against a problem that no longer exists.

## Step 3 — scope the pass with `notExercised`, don't invent ratings

The completeness gate demands a rating for EVERY criterion, which on a short or targeted run produces pressure to invent verdicts. Don't. Pass the untouched keys as `notExercised` — each expands server-side to `{ rating:'unknown', evidence:'idle: not exercised by this run.' }`, and `idle:`-prefixed unknowns are **excluded from the staleness calculation**, so a scoped drill does not poison the rubric's own health signal.

A short run should typically mark idle: `reallocates-on-evidence` (needs enough elapsed time for evidence to arrive and be acted on), `blender-kept-honest` (needs the Blender to have routed something), and `durability-across-cold-wake` (needs an actual cold wake). Marking these `fail` on a two-hour run grades the clock, not the agent.

## Step 4 — filing the scorecard

```
improvements:capture {
  lane: 'observation',
  title: '<rubricRef> scorecard — subject <su-id>, run <start>–<end>',
  observation: {
    rubricRef: 'goal-mode-e2e',
    ratings: { '<criterion-key>': { rating, evidence }, … },
    notExercised: ['<key>', …],
    linkTo: [{ targetId: '<prior scorecard EI->', rel: 'revises' }]   // corrections ONLY
  }
}
```

* **Evidence is mandatory on every rating** and the gate enforces it. Evidence means the query you ran and what it returned — not a restatement of the rating.
* **A correction is a supersession, not a new sample.** File it with `linkTo { rel: 'revises' }` pointing at the scorecard it replaces. Appending an unlinked correction is what turned one run into five samples and made `rubrics:trend`'s direction fields meaningless.
* **Do not grade a rubric you authored.** v1 was authored, filed against, and corrected by the same agent, so its entire trend is one author's read of one run. Author ≠ ratifier is already enforced for `rubrics:ratify`; extend the same discipline to grading, by convention.

## Step 5 — read the trend as what it is

`rubrics:trend { rubricRef: 'goal-mode-e2e' }` aggregates scorecards per criterion. Two readings to make deliberately:

* **`staleness.stale`** means criteria are persistently `unknown` on non-idle ratings — the criterion's MODEL may no longer match the system. This is a signal about the RUBRIC, not the agents. v1 went stale because `child-execution-proven` asserted `adv_sessions.role='cup'`, a mechanism retired behind a default-OFF flag; the criterion could never resolve, and five graders dutifully rated it `unknown` rather than questioning the instrument. **A criterion that is unknown on every run is an instrument defect until proven otherwise.**
* **`direction`** is only meaningful across INDEPENDENT runs of DIFFERENT subjects. Check `scorecardCount` against the number of distinct runs you can actually name before quoting a trend at anyone.

## Why `releaseGating` is false

Gating requires a unique machine instrument on every criterion. Three are honest judgment calls with no deterministic binding available — `reallocates-on-evidence`, `blender-kept-honest`, `right-container-for-the-work` — and inventing bindings for them to make the rubric look gate-ready would be the exact dishonesty the rubric grades agents for. The gating decision is revisited after two real graded runs (plan `goal-mode-rubric-v2-2026-08-10`, P-014), on evidence rather than on the v1 default.
