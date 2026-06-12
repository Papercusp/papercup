# Spawn-env pins leak into vitest — tests that only fail when an agent runs them
URL: /internal/docs/agent-insights/spawn-env-leaks-into-vitest

Orchestrator-spawned agents carry per-spawn env pins (PAPERCUSP_WORKSPACE_ID, GIT_CONFIG_* mounting the fleet no-push hook). Vitest inherits them, so env-sensitive tests (workspace-fallback asserts, real-git pushes) fail under the green-checkpoint or any spawned runner while passing in every interactive shell. Fixed globally by the hermetic-env scrub in libs/test-config setup; diagnose by simulating the spawn env, not by re-running locally.

## Symptom

A small cluster of tests reds on the Tests tab at a steady cadence (every
green-checkpoint run), but **passes every time you re-run it locally** — solo
or batched. On 2026-06-11 the recurring set was:

* `workspace-context-middleware.test.ts`, `workspace-two-window-isolation.test.ts`,
  `papercusp-root.test.ts`, `workspace-map.test.ts` — asserts like
  `expected 'papercusp-workspace' to be 'ws-default'`: the test stubbed the
  global active workspace, but resolution returned the box's real workspace.
* `run-git-sync.test.ts` — every `git push` to its own `/tmp` origin blocked by
  "the fleet pre-push hook".

## Root cause

The runner was an **orchestrator-spawned agent** (the hourly green-checkpoint).
Spawns carry per-spawn env pins that vitest inherits:

* `PAPERCUSP_WORKSPACE_ID` — the process workspace pin, precedence step 2 in
  `workspace-registry.ts:activeWorkspaceId()`. Tests asserting the step-3
  global fallback get the pin instead.
* `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` — the spawn-env
  git-config injection (`gitConfigNoPushEnv` in orchestrator `invoke.ts`) that
  mounts `core.hooksPath` → the fleet no-push pre-push hook. git applies these
  env overrides in **every repo the test creates**, so real-git tests can't push
  to their own temp origins.
* `PAPERCUSP_INTEGRATION_ROOT` / `RELEASE_ROOT` / `CHECKPOINT_ROOT` /
  `INTEGRATION_BRANCH` / `RELEASE_REF` — the release-gate workspace-map config
  in gate/checkpoint runner envs. `resolveWorkspaceMapConfig` prefers them over
  sibling derivation, so `workspace-map.test.ts`'s derivation asserts got the
  runner's real paths (it stubbed only `INTEGRATION_ROOT`, and the runner's
  `RELEASE_ROOT` won).

An interactive shell has neither pin, which is why local re-runs are useless
for reproducing this class.

## Fix (landed)

`libs/test-config/src/setup-hermetic-env.ts` — prepended to every
`defineVitestConfig` setup (both console-noise branches) — deletes
`PAPERCUSP_WORKSPACE_ID` and the `GIT_CONFIG_*` injection block per worker, so
tests behave identically under any runner. Tests that need a pin set it
themselves. Keep the scrub list to proven leak classes; broad env wipes hide
real bugs.

## How to diagnose the next one

If a test fails only under a spawned runner, don't chase the code — diff the
envs. Reproduce by simulating the spawn env locally:

```bash
PAPERCUSP_WORKSPACE_ID=papercusp-workspace \
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp/some-hooks \
  npx vitest run <file>
```

If that reproduces, add the offending variable to the hermetic scrub (with a
comment naming the incident) rather than patching the individual test.
