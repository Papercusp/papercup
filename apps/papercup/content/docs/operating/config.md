---
title: Configuration reference
description: Every field in .harness/config.json.
---

```json
{
  "models": {
    "planner": "opus",
    "worker": "sonnet",
    "validator": "opus",
    "orchestrator": "haiku",
    "crosscheck": "opus"
  },
  "promptOverrides": {
    "<role>": "inline string OR ./relative-path.md OR /absolute/path.md"
  },
  "timeouts": { "<role>": 600 },
  "snapshotRetention": 50,
  "logRetention": 500,
  "branchIsolation": {
    "enabled": false,
    "baseBranch": "main",
    "onPass": "merge",
    "useWorktrees": false
  },
  "autoScreenshot": { "enabled": false, "url": "..." },
  "parallelWorkers": {
    "max": 1,
    "mode": "lane"
  },
  "archiveOnDone": false,
  "planReviewer": { "enabled": true },
  "debugger": { "enabled": true, "threshold": 3 },
  "crosscheck": { "enabled": false },
  "uiQa": { "enabled": false, "url": "..." },
  "wipCheckpoint": { "enabled": false, "intervalSeconds": 300 },
  "product": {
    "enabled": false,
    "mode": "propose",
    "triggerOnNearDone": true,
    "triggerOnDone": false,
    "nearDoneThreshold": 0.8,
    "replanOnAccept": false
  },
  "checkpoints": {
    "enabled": false,
    "types": [
      { "name": "architecture-locked", "description": "...", "triggerOn": "post-planner" }
    ]
  },
  "smokeTest": {
    "enabled": false,
    "onDone": true,
    "onFeaturePass": false,
    "urls": [
      { "url": "http://localhost:5173/", "expectStatus": 200 }
    ],
    "startupCmd": null,
    "startupWaitSeconds": 30
  }
}
```

## Field-by-field

### `models.<role>`
Per-role model override. Values: `opus`, `sonnet`, `haiku`. Skipped if `$CLAUDE` already contains `--model`.

### `promptOverrides.<role>`
Appended to the role's standard prompt as a "Droid specialization" section. Supports inline strings or `./` / `/` paths.

### `timeouts.<role>`
Per-role timeout in seconds. Uses GNU `timeout`. Agent gets SIGTERM (rc=124) after the duration; main loop continues.

### `snapshotRetention`, `logRetention`
Pruning thresholds.

### `branchIsolation`
- `enabled`: per-feature branches off `baseBranch`.
- `onPass`: `merge`, `pr`, or `keep`.
- `useWorktrees`: each lane gets its own filesystem dir (Composio-inspired).

### `parallelWorkers`
- `max`: concurrent workers. `>1` requires `branchIsolation.enabled`.
- `workersPerFeature`: integer (default `1`). When `>1`, dispatches that many workers on the same feature in sibling worktrees; after they commit, the synthesizer merges/polishes their candidates into one shipping branch. Requires `branchIsolation.useWorktrees: true`.
- `adaptive`: `{tiers, labels, rubric}`. When set, the orchestrator LLM picks N per feature from `tiers` based on the rubric. Overrides `workersPerFeature` when present.
- `synthesizeSingle`: boolean (default `true`). Run the synthesizer even on single-worker dispatches as a code-review pass. Set `false` to skip.

### `planReviewer.enabled`
Plan-reviewer fires after planner. Reject → harness exits 7.

### `debugger`
- `enabled`: debugger fires when `attempts >= threshold` for any failing feature.
- `threshold`: default 3.

### `crosscheck.enabled`
Different-model re-validation after validator passes. Configure `models.crosscheck` to set the alternate model.

### `uiQa`
- `enabled`: ui-qa role fires for features with `VAL-UI-*` claims.
- `url`: target for verdict.

### `wipCheckpoint`
Background WIP commits during long worker runs. Requires `branchIsolation`.

### `proposals` (formerly `product`)

Controls scoper MODE=proposal — the autonomous scope-expansion pass that reads
SPEC.md's north-star, compares it to shipped features, and writes
`.harness/proposals/*.md`. Pre-2026-04-25 this lived in a separate `product` role
(prompt at `prompts/_archived/product.md`); the role was consolidated into the
scoper. The legacy `product.*` keys are honored as fallbacks by run.sh, but new
configs should use `proposals.*`.

- `enabled` (legacy `product.enabled`): scoper proposal pass can fire.
- `mode` (legacy `product.mode`): `"propose"` writes proposal files; `"auto-apply"` lets the reviewer append accepted bullets directly to SPEC.md.
- `nearDoneEnabled` (legacy `product.triggerOnNearDone`): fires once when `passed/total >= nearDoneThreshold` (default 0.8).
- `afterDone` (legacy `product.triggerOnDone`): fires before exiting on DONE (lets a mission self-extend).
- `replanOnAccept`: re-plan after a proposal is accepted (same key in both namespaces).

### `checkpoints`
- `enabled`: orchestrator may emit `CHECKPOINT <name>` and run.sh may auto-fire types with `triggerOn: post-planner`.
- `types`: array of `{ name, description, triggerOn? }`.

### `smokeTest`
- `enabled`: turn on the gate.
- `onDone`: smoke test gates DONE. On failure: reopens last-passed feature, re-enters loop.
- `onFeaturePass`: smoke test gates every feature pass. On failure: reverts to failing.
- `urls`: array of `{ url, expectStatus, expectText? }`.
- `startupCmd`: optional command to start service if first URL isn't responding.
- `startupWaitSeconds`: wait timeout for startup.
