# Harness Gym — runner (`apps/operator/lib/gym/`)

The eval-driven optimizer for the harness itself. Plan:
`apps/operator/docs/plans/harness-gym-eval-optimizer-2026-06-02.md`.
This directory is the **measurement spine** (Phases 0–3). The proposer + autonomous
loop (Phases 4–5) are gated behind the **P-014 human milestone** and are not built
here yet.

## The minimal bootable unit (P-001)

A gym **run** = execute the real multi-agent pipeline (scoper→…→curator) on one
synthetic task with one prompt-variant overlay, then capture the result. Per
**D-018 (Option A)** the unit that boots is **one dedicated, long-lived
gym-operator instance**, reused across runs — *not* the live `:3070` fleet operator,
and *not* a fresh process per run.

```
┌──────────────────────────────── gym CONTROLLER (latest code) ─────────────────────────────┐
│  runGymPipeline (gym-runner.ts) · judge · proposer · loop driver                           │
│  — talks to the gym-operator over HTTP + reads the gym PG directly —                       │
└───────────────┬──────────────────────────────────────────────────────────────────────────┘
                │ HTTP (:39xx)  +  PG (papercusp_gym)  +  local git
                ▼
┌──────────── gym-OPERATOR (PINNED checkout @ harnessCommit) ───────────────────────────────┐
│  bin/hono-host.ts + DBOS orchestrator + dedicated gym PG database                          │
│  runs the REAL pipeline with the variant's promptOverrides                                 │
│  boot env: see boot-spec.ts → buildGymOperatorBootSpec()                                    │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

### What is pinned vs not (sharpens D-016)

D-016 pins the **harness-under-test** — the thing being *measured*. That is the
pipeline code + the role prompts, i.e. the **gym-operator's pinned checkout**. It is
**not** the gym's own measurement apparatus (runner orchestration, judge, proposer,
loop). Those live in the **controller** and stay on the latest code, so improving the
gym never forces a re-pin. The controller therefore talks to the gym-operator only
through its stable surfaces (HTTP API + the gym PG), never by sharing its process.

### Boot env (the dedicated gym-operator)

Built purely by `buildGymOperatorBootSpec()` (`boot-spec.ts`); the caller spawns it
as `npx tsx bin/hono-host.ts` from `<pinnedCheckout>/apps/operator` with
`{ ...process.env, ...spec.env }`:

| Env | Why |
| --- | --- |
| `DATABASE_URL` + `HARNESS_ADMIN_DATABASE_URL` = gym PG DSN | Both keys `getHarnessAdminUrl()` consults — neither the live DSN nor a live `embedded-pg.json` can leak in. |
| `PAPERCUSP_DBOS_ENABLE=1` | Boots the durable orchestrator (registers `featurePipeline`). |
| `PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES=none` (default) | Autoloop off — the runner starts each pipeline explicitly (deterministic, 1 feature/harness). |
| `PAPERCUSP_HONO_PORT` / `PAPERCUSP_BIND_HOST=127.0.0.1` | Dedicated port, loopback only. |
| `PAPERCUSP_WORKSPACE_ID` | Pinned for the instance lifetime. |
| `DBOS__APPVERSION=gym-<commit12>` | Isolates the gym DBOS app from the live one; stable workflow recovery. |
| `PAPERCUSP_IPC_ENABLE=0` | Not the Tauri/desktop context. |

### Per-run lifecycle (`runGymPipeline`, gym-runner.ts)

For each `(task × variant × cycle)`:

1. **identity** — `gymRunIdentity()` → a `gym-`prefixed, PG-schema-safe `harnessSlug`
   (→ its own `harness_<slug>` schema in the gym PG), a task-derived `F-GYM-*`
   feature id, and a clone dir name. Deterministic & collision-free.
2. **clone** — throwaway substrate clone at the pinned commit (`clone.ts`,
   `--local` for local sources); `git checkout --detach <commit>` (D-009).
3. **register** — register the clone as a throwaway harness (scaffolds its schema).
4. **overlay** — apply the variant's prompt overrides (`variant-overlay.ts` →
   `setPromptOverride`); baseline applies none (D-010/D-012/D-015).
5. **file feature** — file the synthetic feature (spec + intent) into the harness.
6. **start pipeline** — `ensureFeaturePipeline` / `POST /api/admin/dbos/pipeline/start`.
7. **poll to terminal** — `classifyGymRun()` over `(workflow status, feature status)`
   until terminal or `timeoutMs` (`pipeline-status.ts`). Outcome is **observability**
   (terminal_state), never a reward (D-011).

The runner does **not** tear down on success: the trace collector (P-002) reads the
clone (for `git diff <commit> HEAD`) and the harness schema (for the transcript)
*after* the run, then teardown drops the schema + removes the clone.

Isolation between concurrent runs (P-004) is by construction: distinct `harness_<slug>`
schemas + distinct clone dirs + distinct feature ids, all within the one gym PG /
gym-operator, bounded by the DBOS pipeline queue concurrency.

## Module map

| File | Role | Tested |
| --- | --- | --- |
| `run-identity.ts` | deterministic schema-safe run identity | `__tests__/run-identity.test.ts` |
| `clone.ts` | pinned-commit substrate clone command plans | `__tests__/clone.test.ts` |
| `variant-overlay.ts` | prompt-override overlay planning | `__tests__/variant-overlay.test.ts` |
| `pipeline-status.ts` | poll-to-terminal classifier | `__tests__/pipeline-status.test.ts` |
| `boot-spec.ts` | the minimal bootable unit (boot env) | `__tests__/boot-spec.test.ts` |
| `gym-runner.ts` | run orchestration (injected ports) | `__tests__/gym-runner.test.ts` |

Full integration (a real gym-operator + a real pipeline on a real A/B) is validated at
the **P-014** milestone, not in unit tests.

## Status & runbook (overnight build, 2026-06-02)

**Built + tested + committed:** every plan item's logic/cores (P-001..P-030 except the
human gates) — 194 unit tests + live-PG integration, green. Modules cover the spine
(runner/clone/identity/boot-spec/schema/collector/signals/cost/concurrency), task side
(task-generator/probe-generator/task-pools/real-anchor), judge (judge-scoring/judge/
distill/rejudge), and the full loop (proposer/changelog/gates/frontier/gate-engine/loop/
promotion/circuit-breaker/optin/variance/grader-opt). Plus `runner-ports.ts`
(createGymRunnerPorts) + `../harness-seed.ts` (shared w/ harness-test-coverage) +
`gym-db-init.ts` (provisionGymDatabase).

**SPINE validated end-to-end** by `smoke.ts` (zero LLM spend): provision dedicated gym
PG → boot headless gym-operator (DBOS launches on the gym DB) → register harness →
file feature (direct PG) → deterministic start (admin route + `~/.papercusp/superuser-token`
bearer) → pipeline runs to terminal SUCCESS → process-group teardown. Run it:
`cd apps/operator && npx tsx lib/gym/smoke.ts`.

### Open item 1 — worker invoke `harness_features` (the last mile to REAL work)

The fake-agent pipeline reaches terminal, but the WORKER invoke throws Postgres
`relation "harness_features" does not exist`, so no real diff/transcript is produced
(`runOutputRows: 0`, `workerCommitted: false`). Ruled out: hyphen in slug (fixed →
hyphen-free), missing view (the per-harness `harness_features` view IS created),
clone-dir basename (now == slug), `HARNESS_SLUG` env, DBOS-on-gym-DB (confirmed via the
boot log's "System Database URL").

**PINNED (2026-06-02, via the reliable dedicated-container smoke):** the gym-side setup
is CORRECT. `report.workerPgDiag` shows the worker's pg-bootstrap repeatedly logging
`PG bootstrap: connected (search_path=harness_<slug>,harness_shared,public); ctx.pg
active` — i.e. the right per-harness schema IS first on the search_path, ctx.pg is on,
the `harness_features` view exists there, and DBOS is on the gym DB. So it is NOT
slug / search_path / DB (the hyphen-free + clone-basename + dedicated-DB fixes resolved
those). The remaining cause is **deeper in the orchestrator state layer**: some code path
in `invoke.ts`/`state-pg.ts` resolves `harness_features` on a connection WITHOUT the
harness search_path (e.g. a `getOrgPg()`-style default client, or a view-body dependency
that fails in a fresh schema), throwing `relation "harness_features" does not exist`.

**Handoff (NOT done unattended — shared orchestrator code the live fleet depends on):**
trace which query/client in invoke()'s worker path throws (add a stack/log to the
`relation … does not exist` catch, or to `state-pg.ts`), confirm it's a non-`ctx.pg`
client, and point it at the harness-scoped client. The smoke is now RELIABLE
(`npx tsx lib/gym/smoke.ts`, dedicated pgvector container) so this is a ~2-minute
trace-and-rerun loop.

### Open item 2 — P-014 (human gate): the real A/B

Once the worker does real work: run a bounded A/B (≤2 variants × ≤3 tasks, 1 run each;
D-019 bounded spend) → measure judge-composite variance (`variance.ts` → ε/δ/min-n),
the cost estimate (`cost.ts`), and real-anchor correlation (`real-anchor.ts`). This is
the milestone gate before building/running the autonomous loop unattended.

### Open item 3 — P-024 dashboard (UI)

Deferred: the `read-api.ts` data layer (compareVariants/frontierView/cycleHistory/
variantLineage) is ready; the nuqs operator UI is a focused design-aware task (Tauri-only
operator UI can't be driven autonomously without focus-stealing; importance: low).
