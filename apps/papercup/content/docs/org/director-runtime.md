---
title: Director runtime
description: How directors actually run — autonomous loops, schedulers, prompt resolution, structured action execution.
---

Each of the 5 departments has a **director agent** that operates the department harness. Directors read live state, decide what to do, and emit structured ACTIONS that the backend executes.

:::note[Migration complete (2026-04-26, Layer 3-A)]

The harness-of-harnesses migration retired the bespoke `spawnClaude` pipeline. Department directors now run on the standard harness `run.sh` substrate.

- **Removed**: `POST /api/org/:dept/run-director`, `POST /api/org/:dept/run-loop`, `GET /api/org/:dept/run-director-stream`, `POST /api/org/:dept/stop-loop`, `POST /api/org/admin/stop-all`, `GET /api/org/active-runs`, `GET /api/org/schedulers`, `GET /api/org/all-director-stats`, `GET /api/org/health-snapshot`. The `runScheduledLoop` autoLoop scheduler is also gone.
- **New canonical path**: `POST /api/harness/org-<dept>/invoke?role=director` → `bash run.sh invoke director` → writes to `~/org-<slug>/.harness/logs/<unix-ts>-<role>.{out,jsonl,err}`

Each dept now has a full standard harness layout in `~/org-<slug>/.harness/`:
- `config.json` — declares `phase:'department'`, `harness_kind:'department'`, `dept:'<slug>'`, `roles.director.{inboxKinds,outboxKinds,allowedActions,mandate,model,cadence}`
- `mandate.md` — sourced from `departments.json`
- `validation-contract.md` — VAL- checklist
- `features.json` — initially empty; standard harness state shape
- `supervisor-notes.md` — auto-regenerated from message bus on every `appendMessage`

`run.sh` extensions:
- `harness_kind:'department'` skips the SPEC.md requirement (only coding harnesses need it).
- Per-department prompt resolution chain: `prompts/$HARNESS_PHASE/departments/<dept>/<role>.md → prompts/$HARNESS_PHASE/<role>.md → prompts/<role>.md`
- `NEXT_HARNESS <child-slug> [--role=...]` verb: cross-harness dispatch via API or shell fallback
- `NEXT_WORKER_CEO_MODE` verb: invoke worker with `MODE=ceo`
- `process_actions_block` helper: parses ` ```actions ``` ` JSON and POSTs each op to `/api/org/admin/execute-action`

After Layer 3 (gated on ≥5 director invocations across ≥3 depts proving parity), the `spawnClaude` pipeline + `org.post('/:dept/run-director')` etc. will be removed (~300-500 LOC). See `/tmp/PLAN.md`.

:::

This is the layer **above** the per-project coding harness. A director's job is coordination (sending Decisions, Priorities, BuildRequests, etc.); the actual code-writing happens inside specific projects, each running their own coding harness with the role graph documented elsewhere in these docs.

## Prompt resolution

Director prompts are resolved by inheritance:

```
base/<role>.md
+ department/<role>.md
+ department/departments/<dept>/<role>.md   (if exists)
+ ceo override                              (if business + worker + ceo mode)
+ live state                                (charter + notes + decision log + memory + inbox + outbox)
+ "your task right now"                     (closer asking for ACTIONS)
```

Roles: `orchestrator`, `worker`, `validator`, `documenter`, `summarizer`. The CEO is a worker variant for Business when handling `Directive` kind.

The resolved prompt is available via `GET /api/org/:dept/prompt?role=&mode=&context=1`.

### Memory injection (round 31)

Each prompt's live-state block includes a synthesized `## Recent decisions (your own memory, newest first)` section drawn from the dept's last 12 director-run records. Each line is `<ts> [<decisionKeyword>] → <first action> (final:<outcome>)`. This lets a director notice patterns like "I keep deferring this" or "last 3 NEXT_WORKER_CEO_MODE went to the same message."

Synthesis happens in `synthesizeRecentMemory(harnessSlug, limit)` and is also exposed at `GET /api/org/:dept/memory?limit=N` for the **Memory** tab in the Department Harness Dashboard (table view + collapsible "Raw text injected into prompt" inspector).

## The autonomous loop

`POST /api/org/:dept/run-loop` runs:

1. **Orchestrator** — reads inbox + state, outputs one decision keyword:
   - `DONE` — nothing left to do
   - `NEXT_WORKER <id>` — assign a worker to handle inbox message
   - `NEXT_WORKER_CEO_MODE <id>` — Business-only: assign CEO mode for a Directive
   - `NEXT_VALIDATOR <id>` — validator should crosscheck a recently emitted outbox message
   - `ESCALATE <id> <reason>` — exceeds authority
2. **Worker / CEO / Validator** — runs with the chosen message in context. Outputs reasoning + ACTIONS block.
3. **Backend executes** the ACTIONS sequentially. Charter validation runs server-side; a violating action errors out and aborts the iteration.
4. **Loop** back to step 1 with updated state. Stops on DONE / ESCALATE / max-iterations / cancellation / per-step error.

Every loop's full trace persists to `~/org-{dept}/.harness/director-runs/<ts>_loop.md`. Each worker's full output appends to `~/org-{dept}/.harness/worker-log.md`.

## Server-side scheduler

Each department has a `.harness/director-config.json` with `{autoLoop, autoIntervalSeconds}`. When `autoLoop: true`, the server registers a scheduled loop that fires every `autoIntervalSeconds` (30-3600).

- Schedulers are server-side, not browser-side. Closing every browser doesn't stop them.
- They survive Hot Module Reload via `globalThis.__papercupSchedulers`.
- Skip iterations when an active run is in flight (no overlap).
- Re-read config on each tick so toggle/interval changes take effect immediately.
- Scheduled run records use the `_scheduler.md` suffix (vs `_loop.md` for manual).

`GET /api/org/schedulers` lists all active server-side schedulers with `secondsRemaining` until next fire.

## In-flight control

- `GET /api/org/active-runs` — list current claude processes across all depts (pid, kind, elapsed)
- `POST /api/org/:dept/stop-loop` — SIGTERM the active claude process for that dept (then SIGKILL after 2s grace)
- `POST /api/org/admin/stop-all` — emergency stop: cancels all active runs + clears all schedulers + persists `autoLoop: false` to every dept

These controls live in each dept's **Director Agent** tab (in `/harness/org-{slug}`). The earlier per-tile cockpit on `/papercup/organization` and the standalone `/papercup/health` page were removed; their code is preserved at `libs/papercup-shared/src/_discarded/HarnessOpsCockpit.tsx`.

## Streaming director output

`GET /api/org/:dept/run-director-stream?role=&mode=` is an SSE endpoint that streams claude's stdout chunk-by-chunk:

- `event: start` — run kicked off
- `event: chunk` — partial stdout
- `event: stderr` — partial stderr
- `event: done` — process closed; final decision keyword

The Department Harness Dashboard's **Director Agent** tab uses this to stream output live into a terminal-style pane during a run.

## Director run records

Every claude invocation produces a `~/org-{dept}/.harness/director-runs/<ts>_<kind>.md` file with the prompt summary, decision keyword, and full stdout. Surfaced as a "Recent runs" disclosure in the Director Agent tab; click to expand any run inline.

`GET /api/org/:dept/director-stats` parses these records to compute KPIs: total runs, breakdown by outcome (DONE/NEXT_WORKER/cancelled/etc), breakdown by kind (orchestrator/loop/scheduler).

## Director config

Per-dept config at `~/org-{dept}/.harness/director-config.json`:

```json
{
  "autoLoop": false,
  "autoIntervalSeconds": 60
}
```

Editable via `PUT /api/org/:dept/director-config` (auto-emits an audit entry). The Department Harness Dashboard's **Director Agent** tab persists changes immediately. The server-side scheduler reschedules on every config write.
