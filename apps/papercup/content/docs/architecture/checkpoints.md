---
title: Named checkpoints
description: Hermes-inspired human-gated pauses for pre-agreed milestones.
---

Checkpoints are explicit "pause for a human" milestones the orchestrator (or run.sh) can fire at agreed points. Different from escalations: an escalation says "I'm stuck"; a checkpoint says "we've reached a known milestone, please approve."

## Lifecycle

```
1. config.json declares checkpoints.types[]
2. Orchestrator emits CHECKPOINT <name>     ← OR run.sh auto-fires on triggerOn
3. run.sh writes .harness/checkpoint-<name>.md
4. run.sh exit 8 (paused, no further iterations)
5. Operator clicks "Grant" in UI
6. API writes .harness/checkpoint-<name>.md.granted
7. Operator re-runs harness; startup-check consumes both files; loop resumes
```

## Trigger types

| `triggerOn` | When it fires | Configured? |
|---|---|---|
| `post-planner` | After planner + plan-reviewer both pass | Auto-fired by run.sh |
| `pre-done` | Before `DONE` is emitted | Orchestrator decides |
| `feature-claim:db` | First feature with a DB-modifying claim | Orchestrator decides |
| (none) | Custom — orchestrator emits at its discretion | Orchestrator decides |

## Sentinel files

```
.harness/checkpoint-<name>.md         ← pending (writes block run.sh startup)
.harness/checkpoint-<name>.md.granted ← granted (consumed at next startup)
.harness/.checkpoint-<name>.fired     ← already fired this mission (don't re-fire)
```

## API

| Endpoint | Effect |
|---|---|
| `GET /api/harness/:slug/checkpoints` | List all (pending + granted) |
| `POST /api/harness/:slug/checkpoint/:name/request` | Manually create a checkpoint (operator-initiated pause) |
| `POST /api/harness/:slug/checkpoint/:name/grant` | Create the `.granted` sentinel |

## Hooks

`on-checkpoint-fired.sh` runs whenever a checkpoint is created (auto or orchestrator). Env: `CHECKPOINT_NAME`, `TRIGGER`, `PROJECT_DIR`, `STATE_DIR`.

## Why a separate verb

Originally we had only `ESCALATE`. We split them because:

- Escalations carry shame ("the system got stuck"); checkpoints carry intent ("we hit the gate").
- Hooks fire differently — `on-escalate` should send a louder signal than `on-checkpoint-fired`.
- The UI banner styling diverges: escalation is red/urgent; checkpoints are amber/awaiting.

Mixing them confused operators in early prototypes.
