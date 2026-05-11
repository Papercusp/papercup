---
title: What is Papercup?
description: A fully autonomous AI-driven company, with five director agents shipping product through their own coding harnesses.
---

Papercup is the operating system of an autonomous company. It has two layers:

- **Org layer**: five director agents — Business, R&D, Technology, Management, Marketing — coordinating via typed inbox/outbox messages. They route work, allocate budget, kick off projects, and surface market signals. They don't write code.
- **Coding harness**: each project (e.g. `sheets`, `restart`) runs its own bash-orchestrated agent loop with planner / worker / validator / etc. This is the layer that physically ships features. The harness predates the org layer and runs on its own.

The directors decide which projects exist and what they should do. The coding harnesses inside each project execute the actual coding work. You write directives; humans observe and intervene at named checkpoints when either layer asks for a decision.

These docs cover both. The **Org layer** section covers the director coordination layer. The **Architecture** + **Decisions** sections cover the coding harness internals.

## Concretely, what is "the harness"?

A bash loop (`run.sh`) that orchestrates a small fleet of role agents. Each iteration:

1. Asks the **orchestrator** what to do next (`NEXT_WORKER F-023`, `NEXT_VALIDATOR F-022`, `DONE`, `ESCALATE …`, `CHECKPOINT …`).
2. Invokes that role with a fresh context. The prompt is a stable per-role markdown file plus auto-injected memory layers (cross-mission identity + per-mission summary).
3. Captures stdout/stderr, parses the decision verb, mutates `.harness/features.json`, and snapshots state.
4. Loops.

12 prompt-driven roles ship in the box: planner, plan-reviewer, worker, validator, crosscheck, ui-qa, debugger, architect, curator, documenter, product, orchestrator. (A 13th, `supervisor`, is bash-only — no LLM prompt; it wakes on cron or on a non-zero exit chain.) None of them carry context between invocations beyond what's on disk.

## What makes Papercup different from "AI agents that code"

- **It runs unsupervised.** No human in the inner loop. Iterations have no upper bound except the cost cap (which is currently disabled).
- **It admits when it's stuck.** Named checkpoints (Hermes-inspired) and validator escalations halt the run; humans grant via UI.
- **It writes its own scope.** A `product` role periodically diffs the SPEC.md north-star against its current scope and proposes new features. Operators triage the proposals.
- **It learns.** The `curator` maintains a per-role identity file (`~/autonomous-harness/identity/<role>.md`) that survives across missions.
- **It writes against itself.** Optional `workersPerFeature > 1` spawns N workers on the same feature in sibling worktrees; a synthesizer reads all their diffs and merges/polishes them into one shipping branch before the validator certifies it.
