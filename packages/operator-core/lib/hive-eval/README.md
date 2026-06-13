# hive-eval — the Hive-run-evaluation battery (HE-03)

Plan: `hive-run-evaluation-2026-06-13` (HE-03 = P-020/P-021/P-022, D-009). A **sibling
slice of the apiary IQ-battery** (D-006): it runs the WHOLE Hive (Queen + bees) on a seeded
scenario in a throwaway hive and records the run. It builds nothing parallel — it reuses the
apiary/gym machinery and the `@papercusp/eval-battery` engine.

## What HE-03 ships (judge-free)

| File | Item | What |
|------|------|------|
| `scenario.ts` | P-020 | `HiveScenario` type · `computeParallelismStructure` (the computable ideal wall-clock + ideal bee-count from the work-item DAG, D-004) · `validateScenario`. |
| `scenarios.ts` + `fixtures/seed-app/` | P-020 | 4 seeded scenarios (serial / wide-parallel / deep-dependency / diamond), each with a known-good acceptance gate, a latent planted defect, and a computable optimum, over the real `seed-app` fixture. |
| `run-identity.ts` | P-022 | deterministic, collision-free throwaway-hive slug + run id per `(instance × scenario × repeat × seed)`. |
| `run-harness.ts` | P-021 | `runHiveScenarioOnce` (boot → seed → drive → collect → teardown, with teardown-on-failure) + the `@papercusp/eval-battery` `Subject` adapter (`hiveScenarioSubject`) + deterministic fake ports. |
| `battery.ts` | P-022 | `runHiveScenarioBattery` — scenarios × N repeats, recorded so each scenario's result is a **distribution** (reuses `gym/variance.ts`). |
| `store.ts` / `store-pg.ts` + migration `264` | P-021/P-022 | the run store, keyed `(instance, scenario, repeat)` — every repeat kept (unlike the beekeeper's `UNIQUE(instance, case_id)`). |

**The phase boundary (D-009):** this slice is JUDGE-FREE. It records raw runs + the
distribution. **HE-04/05** read `hive_eval_runs.observations` to compute outcome / efficiency /
speed metrics; **HE-06** layers the LLM judge / composite / un-gameable gate over the recorded
runs (each carries a `distilledTrace` a judge reads); **HE-07** schedules the cadence + trend.

## Wiring the LIVE ports (HE-04/HE-07 — owner-budget-gated, P-051)

The harness's I/O is the `HiveRunPorts` seam (`run-harness.ts`); the unit tests use
`makeFakeHivePorts`. A live whole-Hive run is real LLM spend (gated on owner P-051), so it is
NOT executed yet. When arming it, implement `HiveRunPorts` against these verified seams (the
HE-01 reuse map + the explore done for D-009):

- **`bootHive`** → `createHiveHarness({ slug: identity.hiveSlug, workspaceId, … })`
  (`lib/agent-tools/hive/_create.ts`) over a substrate clone of the scenario's `sandbox`
  (`SEED_APP_DIR`) at a pinned commit, materialized with the gym hermetic isolation
  (`gym/clone.ts` `cloneSubstrate` + `gym/runner-ports.ts` `registerThrowawayHarness`). Reuse
  `gymRunIdentity`'s hyphen-free-slug discipline (already done in `run-identity.ts`).
- **`seedScenario`** → insert each `scenario.workItems[]` (respecting `dependsOn`) into the
  hive via `work_items:create` / `harness_features_consolidated` (the planted defect is already
  in the cloned repo).
- **`driveToCompletion`** → `hive:start` then drive the Queen autonomously; detect completion
  by polling `surveyHive(...)` until `frontier.length === 0 && plans.length === 0` and no
  `hive_placements` in flight (`lib/hive/survey.ts`, `lib/hive/placement-watchdog.ts`), bounded
  by `timeoutMs` → `terminalState 'drained' | 'timeout'`.
- **`collectRunData`** → read the run's spawn/work-item/cost rows for the distilled trace +
  `costUsd`; the raw work-item/spawn refs are what HE-04's fabrication-detection consumes.
- **`teardown`** → drop the throwaway `harness_<slug>` schema + remove the clone (`gym`
  `teardownHarness`).

`createPgHiveEvalStore(sql)` is the live store (migration 264). The battery is otherwise
unchanged: `runHiveScenarioBattery({ instance, scenarios: HIVE_EVAL_SCENARIOS, repeats, seed,
budgetUsdCap, beeCap }, { store, ports })`.

## Tests

`scenario.test.ts` · `run-harness.test.ts` · `battery.test.ts` (Vitest, 29 tests) + the
`store-pg.integration.test.ts` (migration round-trip). Registered as the `run-eval` section of
the `hive` test domain (sibling of `apiary`). The `seed-app` fixture's own `node --test` suite
is the scenario's regression floor, not an operator test.
