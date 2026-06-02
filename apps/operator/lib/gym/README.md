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
