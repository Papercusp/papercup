---
title: Smoke test gates
description: claudecode-orchestrator-inspired service-startup verification before merge.
---

The harness can gate `DONE` and individual feature passes on a service-level smoke test that actually starts the application and curls real URLs.

## Why bother

Validators verify code-level claims. They don't always start a server and hit the actual endpoints. A feature can claim pass when:

- The unit test passes,
- The endpoint contract is documented,
- The migration applied cleanly,

but the deployed service still 500s because of an unrelated config drift, missing env var, or service-startup race.

A smoke gate catches this class of failure *before* declaring DONE.

## Configuration

```json
"smokeTest": {
  "enabled": true,
  "onDone": true,
  "onFeaturePass": false,
  "urls": [
    { "url": "http://localhost:5173/", "expectStatus": 200 },
    { "url": "http://localhost:5173/api/health", "expectStatus": 200, "expectText": "ok" }
  ],
  "startupCmd": "npm run dev",
  "startupWaitSeconds": 30
}
```

## What runs

`bin/service-smoke-test.sh`:

1. Reads `.harness/config.json`.
2. If service isn't already responding on the first URL, runs `startupCmd` in background. Waits up to `startupWaitSeconds` for it to come up.
3. For each URL: curl it, check status, optionally check body for `expectText`.
4. On all-pass: writes `.harness/smoke-pass.md`, deletes any prior `smoke-failure.md`, exits 0.
5. On any-fail: writes `.harness/smoke-failure.md`, reopens the most-recently-passed feature as `failing` with a note pointing at the smoke result, exits 1.

## DONE gate

If `onDone: true`, the harness runs the smoke test before exiting on `DONE`. A failure re-enters the loop with the reopened feature.

## Per-feature gate

If `onFeaturePass: true`, the smoke test runs after every validator pass. Failure reverts the feature to `failing` *before* the documenter runs (so we don't generate docs for a broken state).

## API surface

| Endpoint | Effect |
|---|---|
| `GET /api/harness/:slug/smoke-test` | Latest pass/fail + per-URL result table |
| `POST /api/harness/:slug/smoke-test/run` | Trigger a run on demand |

## Hooks

- `on-smoke-pass.sh` — env: `TRIGGER` (`onDone` or `onFeaturePass`), `FEATURE_ID` (when applicable)
- `on-smoke-fail.sh` — same env

## "Quality through truth"

The smoke gate is one of three claudecode-orchestrator-inspired patterns we adopted. The other two are the validator's [evidence rule](/docs/architecture/roles) (every claim must quote source output) and explicit verification of service-startup behaviour rather than relying on test output.
