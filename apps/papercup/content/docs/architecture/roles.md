---
title: Roles
description: Every role in a Papercusp coding harness — what each does, when it fires, what it reads, what it writes, and how the autonomous loop hands off between them.
---

A Papercusp coding harness runs as a fixed-point loop over a small cast of specialised roles. Every role is invoked in a **fresh context** — no in-memory state survives across invocations — and produces exactly one kind of artifact. That discipline is what keeps the substrate auditable: every change in the system can be traced back to a specific role's invocation.

This page covers the full role surface, the reads/writes contract for each, the autonomous-loop hot path, and the rules + anti-patterns that keep roles from creeping into each other's territory.

## At a glance

The single-harness coding loop has **13 roles** organised into three concerns:

![Roles in a Papercusp coding harness, grouped by responsibility](/architecture/roles-map.svg)

- **Core dispatch** — the four roles that drive the autonomous loop forward. The orchestrator is the brain; scoper plans the work, worker implements it, validator verifies it.
- **Quality gates** — five roles invoked on demand. Architect resolves spec ambiguity; reviewer gates plans + scope proposals; debugger investigates stuck features; crosscheck catches validator bias; ui-qa exercises real browsers.
- **Lifecycle / curation** — four roles that synthesise what was built. Documenter writes per-feature human docs; curator writes durable lessons; project_manager curates per-project operating context; summarizer (department-only today) writes recent-activity narrative.

The full role count is higher when you include phase variants and the org topology — see "Phase-specific roles" and "Org topology roles" below.

---

## Role catalogue

### Core dispatch

The four roles that compose the autonomous loop. If any of these is missing, the harness can't function.

| Role | When it fires | Reads | Writes |
|---|---|---|---|
| **orchestrator** | Every iteration of the main loop | `validation-contract.md`, `harness_features` (PG), `issues.json`, `issues.md`, `supervisor-notes.md`, `pending_events` | Nothing directly — emits one decision verb (`DONE`, `NEXT_WORKER`, `NEXT_VALIDATOR`, `NEXT_ARCHITECT`, `NEXT_PROJECT_MANAGER`, `CONVERTED`, `CHECKPOINT`, `ESCALATE`) which the dispatcher acts on |
| **scoper** | Mission start (`MODE=initial`); whenever scope expansion is run (`MODE=proposal`); after an accepted proposal merges into SPEC.md (`MODE=replan`) | `SPEC.md`, `validation-contract.md`, `harness_features` | `validation-contract.md`, `harness_features` rows, `.harness/proposals/*.md` (in proposal mode) |
| **worker** | When the orchestrator emits `NEXT_WORKER F-XXX` | `SPEC.md`, contract, `harness_features`, `AGENTS.md` / `CLAUDE.md`, `knowledge.md`, `.harness/notes/<F>.md`, **project spec** (auto-injected when feature has `project_id`) | Code + tests in the worker's git worktree, atomic commit, `harness_features.status = 'validating'`, `worker-log.md` |
| **validator** | When the orchestrator emits `NEXT_VALIDATOR F-XXX` | Claims, code, tests, worker-log.md | `harness_features.status = 'passed' | 'failing'`, `issues.md`, `pending-issues.jsonl` |

### Quality gates

Invoked on demand, never every iteration. Each one targets a specific failure mode or hand-off boundary.

| Role | When it fires | Reads | Writes |
|---|---|---|---|
| **architect** | When orchestrator emits `NEXT_ARCHITECT F-XXX` for a **spec-suspect** failure (validator quotes the claim back as ambiguous; worker attempts produce divergent plausible implementations) | `SPEC.md`, `AGENTS.md`, contract, `issues.md` | A SPEC patch as a `proposal:contract` block (auto-applicable if HIGH confidence) OR `pending-reviews/<id>.json` (defer to human) |
| **reviewer** | After scoper(initial) writes its plan (`MODE=plan`); after a scope proposal is produced (`MODE=proposal`) | The artifact under review + `SPEC.md`, `AGENTS.md`, contract | `plan-review.md` with `VERDICT: accept | accept-with-notes | reject` (plan mode) or accept/reject the proposal (proposal mode) |
| **debugger** | Substrate hook: pre-worker, when `attempts ≥ debugger.threshold` (default 3) AND no debug note exists yet for this attempt | Failure logs, contract, recent diffs | `.harness/debug/<F>.md` — first-divergence + ranked hypotheses + recommendation. The next worker reads this file. |
| **crosscheck** | Optional gate: after the primary validator says `passed`, with a **different model** | Claims, code, validator's evidence | `issues.md` (CROSSCHECK block); reverts `passed → failing` if disagree |
| **ui-qa** | When validator passes a feature whose claims include `VAL-UI-*` | UI assertions, app via `verdict` headless browser | `issues.md` (UI QA block); `UIQA_PASS` / `UIQA_FAIL` line |

### Lifecycle / curation

Synthesise what's been built into different artifacts for different audiences. They write but don't decide; they curate.

| Role | When it fires | Reads | Writes |
|---|---|---|---|
| **documenter** | After a feature transitions to `passed` | git diff, claims, `harness_features` | `docs/features/F-<id>.md` — the human-facing per-feature doc |
| **curator** | At terminal events (DONE / ESCALATE) or every N iterations | `memory/raw.md`, `MEMORY.md`, `pending-issues.jsonl`, `issues.json`, contract | `MEMORY.md`, `memory/summary.md`, merged `issues.json`. Closes stale issues; promotes raw observations to durable lessons. |
| **project_manager** | When one or more features in a project transition to `passed` (orchestrator emits `NEXT_PROJECT_MANAGER PROJ-X`; coalesces all queued `pm_due` events for that project into one batch). Also via `POST /api/harness/<slug>/projects/<id>/regenerate-spec`. | Recently-passed features for the project, current `projects.spec`, recent `project_spec_revisions`, optional `MEMORY.md` for cross-project lessons | `projects.spec` (the new curated body) + a `project_spec_revisions` audit row recording include/exclude decisions per feature with reasoning. **Cannot** modify `SPEC.md`, `validation-contract.md`, or feature rows — strict curator boundary. |
| **summarizer** | *Department harnesses only today.* Per iteration, compresses recent dept activity. Not invoked in single-harness coding installs. | `supervisor-notes.md` (dept inbox), outbox, `decision-log.md` | Activity summary in markdown |

### Phase-specific roles

When a harness install declares `phase=testing` or `phase=production`, the resolver picks up an additional role set.

| Role | Phase | Job |
|---|---|---|
| **tester** | `testing` | Generate one black-box test per `VAL-###` claim. Picks the right framework (Playwright / pytest / Vitest) per claim shape. |
| **test-writer** | `testing` | Add edge-case + adversarial tests beyond the contract baseline (boundary values, concurrency, bad input, auth/authz edges, persistence edges). |
| **security-reviewer** | `testing` | Run Semgrep + pip-audit + npm audit; surface findings as structured issues. Does NOT fix bugs. |
| **monitor** | `production` | Health-ping the running prod app, tail logs for errors, drift-check the running worktree's HEAD against the recorded production sha. |

### Org topology roles

When a harness runs as part of an `org` install (a parent harness coordinating multiple department children, e.g. `papercup-org`), three additional parent-side roles + a department-side role set come into play.

**Parent harness roles:**

| Role | Job | Output |
|---|---|---|
| **director** | Strategic scoping at the org level | `ACTIONS` block (`spinup_project`, `scaffold_harness`, `send_message`) |
| **coordinator** | Decides which child harness to dispatch next | `NEXT_HARNESS <slug> --role=<role>` |
| **auditor** | Periodic VAL- contract audit on org-level state | PASS / FAIL per check |

**Department harness roles** (one set per department):

| Role | Job |
|---|---|
| **dept orchestrator** | Inbox triage, picks next message to handle. Department-specific overrides (`business/orchestrator.md`, `rd/orchestrator.md`, etc.) layer on top of `department/orchestrator.md`. |
| **dept worker** | Handles one inbox message; emits a structured `ACTIONS` block. The `business/ceo.md` variant handles `Directive` messages from the user; the `business/worker.md` variant handles everything else. |
| **dept validator** | Charter compliance check on emitted outbox messages. |
| **dept documenter** | Maintains the dept's `decision-log.md` + `director-notes.md`. |
| **dept summarizer** | Compresses recent dept activity. |

---

## How a feature flows through the roles

The autonomous loop has one happy path (worker → validator → done) and several branches for stuck features, scope evolution, and post-pass curation.

![Feature lifecycle in a Papercusp coding harness — from SPEC.md through every dispatched role and back to DONE](/architecture/workflow-flow.svg)

### Mission start

1. **`scoper` (`MODE=initial`)** reads `SPEC.md` and produces `validation-contract.md` (a numbered checklist of black-box behavioural assertions) plus a `harness_features` queue (one feature per natural unit of work, with `claims` referencing assertion ids).
2. **`reviewer` (`MODE=plan`)** reads the scoper's output and emits a `VERDICT:` line. `accept` and `accept-with-notes` proceed to the main loop; `reject` escalates to the human before any worker runs.

### Main loop — every iteration

The orchestrator runs in a fresh context every loop tick. It reads everything (queue, issues, supervisor-notes, pending_events), then emits exactly one verb. The dispatcher handles each verb:

- **`NEXT_WORKER F-XXX`** — the substrate first checks `attempts`. If `attempts ≥ debugger.threshold` AND no debug note exists yet, it invokes the `debugger` first to write a hypothesis brief; then the worker runs and reads that brief. After the worker commits, the next iteration's orchestrator emits `NEXT_VALIDATOR`.
- **`NEXT_VALIDATOR F-XXX`** — validator runs adversarially against the claims. Sets `harness_features.status` to `passed` or `failing`. On `passed`, the post-pass chain runs: optional **crosscheck** (different-model re-validation), optional **ui-qa** (browser-based verification for UI features), then **documenter** writes the per-feature doc. If the feature has a `project_id`, this also enqueues a `pm_due` event the orchestrator picks up later.
- **`NEXT_ARCHITECT F-XXX`** — emitted for **spec-suspect** failures (the validator's complaint is about ambiguity in the claim, not an implementation bug). The architect either writes a SPEC patch as a proposal block (auto-applicable if HIGH confidence) or writes a `pending-reviews/<id>.json` for a human to answer. Code-suspect failures don't trigger the architect — they get a debugger-then-worker pass on the next iteration.
- **`NEXT_PROJECT_MANAGER PROJ-X`** — emitted when one or more features in PROJ-X have transitioned to `passed` since the project's last spec revision. PM coalesces all queued `pm_due` events for that project into one batch invocation. It produces a three-section output (`PROJECT_MANAGER_DECISIONS` / `_SPEC` / `_SUMMARY`) recording which features it included or excluded with reasoning. The dispatcher persists the new spec to `projects.spec` and inserts a row into `project_spec_revisions`.
- **`CONVERTED <N>`** — the orchestrator promotes `<N>` open critical/major issues from `issues.json` into new `F-FIX-NNN` features in the queue (with corresponding `VAL-FIX-NNN` stub assertions). Self-promotion of discovered work.
- **`CHECKPOINT <name>`** — pause the mission; wait for human grant via the UI before resuming. Used for named pre-agreed milestones (e.g. `db-schema-approved`, `pre-ship`).
- **`DONE`** / **`ESCALATE`** — terminal verbs (see below).

### Spec evolution path

Separate from the feature loop, scope itself can grow:

1. The user (or a routine) runs `scoper` in `MODE=proposal` — it produces ranked scope-expansion proposals in `.harness/proposals/`.
2. **`reviewer` (`MODE=proposal`)** reviews each proposal against intent and emits accept/reject.
3. On `accept`, the proposal merges into `SPEC.md`, then **`scoper` (`MODE=replan`)** updates the validation contract and adds new feature rows without disturbing existing ones.

Architect-emitted patches go through the same review pipeline.

### Terminal events

- **`DONE`** — every feature is `passed` and no recent unvalidated touch. Curator runs to distil the mission's accumulated `raw.md` observations into durable `MEMORY.md` lessons + a 40-line `summary.md` that gets injected into every future role.
- **`ESCALATE <reason>`** — a feature is stuck (≥5 attempts, architect already consulted) or budget exhausted. Curator runs the same way; the `summary.md` carries the escalation reason for the next mission to learn from.

---

## Spec-suspect vs code-suspect — when does the orchestrator pick architect vs let debugger fire?

This is the trickiest call the orchestrator makes. The criteria, made explicit in `prompts/orchestrator.md`:

**Spec-suspect** (orchestrator emits `NEXT_ARCHITECT`):
- Validator's complaints quote the claim back as ambiguous: *"how do we know `quickly` means…"*, *"the contract doesn't say what should happen when…"*
- Multiple worker attempts produce DIFFERENT plausible implementations and the validator rejects each on different grounds — the workers can't converge because the target itself is fuzzy.
- The claim references a value or threshold that hasn't been pinned down.

**Code-suspect** (orchestrator emits `NEXT_WORKER`, substrate fires the debugger pre-worker):
- Validator points at a specific `file:line` and a concrete expected/actual divergence.
- Successive worker attempts produce DIFFERENT errors (progress, not stalling) — they're chipping away at a real bug.
- Tests pass locally but the validator's independent reproduction fails — an environment / setup issue the debugger can pin down.

When unclear: **prefer architect once first**, then if architect can't resolve, fall back to next_worker repeatedly until escalation threshold (`attempts ≥ 5`).

---

## Project context — how the project_manager intersects the worker

The `project_manager` role is a recent addition. The mechanism:

1. When a worker's feature has `project_id` set and transitions to `passed`, the substrate inserts a `pm_due` event into `pending_events`.
2. On a subsequent iteration, the orchestrator emits `NEXT_PROJECT_MANAGER PROJ-X` for the project with the most-overdue pending events.
3. PM consumes ALL pending pm_due events for that project in one batch (debounced — multiple completions don't fire multiple PM runs). It reads the recently-passed features, the project's current spec, and recent revisions; produces an updated spec body.
4. The substrate persists `projects.spec` + a `project_spec_revisions` row recording every include/exclude decision with reasoning.
5. **The next time** a worker / validator / scoper runs on a feature in PROJ-X, the project's spec is auto-injected as a `## Project context — PROJ-X (curated by Project Manager)` section in the assembled prompt.

This makes PM the only role that writes a per-project artifact that other roles consume as input. The constraint that keeps it safe: **PM cannot modify SPEC.md, validation-contract.md, or feature rows**. It curates context only. Decisions remain with the architect, scoper, validator, and worker.

---

## Role design rules

These apply to every role in every install, regardless of phase or topology.

1. **Fresh context.** No role keeps in-memory state across invocations. Everything load-bearing lives on disk or in Postgres.
2. **One job.** Every role's prompt explicitly tells it what its single output is. Multi-purpose roles drift over time and become impossible to reason about.
3. **Boil the lake.** Specialists stay in lane (gstack-inspired). If they see a problem outside scope, they flag it as an issue rather than fixing it.
4. **Identity bias.** Every role reads its `<harnessDir>/identity/<role>.md` file at startup so it inherits past wisdom from prior missions (Agent-Swarm-inspired).
5. **Evidence required.** Validators must quote test output to claim pass (claudecode-orchestrator-inspired).
6. **TDD iron law.** Behavioural assertions need a test that failed before the change (Superpowers-inspired).
7. **Curator vs decider.** Curation roles (curator, project_manager, documenter, summarizer) cannot modify the queue, the contract, or feature rows. They synthesise; deciders decide.
8. **Single writer per artifact.** Only the worker writes code. Only the architect writes SPEC patches. Only the project_manager writes `projects.spec`. Only the curator writes `MEMORY.md`. This makes every artifact's authorship unambiguous.

## Anti-patterns we avoid

- **A `supervisor` that runs every loop iteration.** Supervisor wakes on cron or escalation only — running it inline turns it into yet another orchestrator and double-counts decisions.
- **"Helper" roles that do bits of everyone else's job.** Each role owns a single output file or set of mutations.
- **Roles that mutate `validation-contract.md`.** Only the architect can, and only as a proposal block that goes through the reviewer.
- **Roles that commit code.** Only the worker writes code; the substrate's run.sh handles atomic commits.
- **Curator + project_manager confused.** Curator writes harness-wide lessons (`MEMORY.md`); project_manager writes per-project context (`projects.spec`). Different scope, different artifact, different cadence.
- **Architect writing project specs.** Architect amends harness-level SPEC.md when stuck; it does NOT touch `projects.spec`. Crossing that boundary creates two writers for the same kind of artifact and the project_manager's audit trail loses meaning.
- **Crosscheck folded into validator.** They share verification logic but the model-bias check requires a *separate* invocation with a *different* model. Folding them in means losing the bias check.
