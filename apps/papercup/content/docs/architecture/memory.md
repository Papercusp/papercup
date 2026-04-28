---
title: Memory model
description: 5 layers, who maintains each, and why memory is on disk.
---

The harness has zero in-process state between invocations. Every role re-derives what it needs from disk.

## The 5 layers

### L0 — runtime context (per invocation)

Injected by `run.sh` into the prompt prefix:

```
## Runtime context
- FEATURE_ID=F-023
- Working directory: /home/.../sheets-clone
- State directory: /home/.../sheets-clone/.harness
- Run ID: 1777076234-worker-F-023
```

Lifetime: this single agent invocation.

### L1 — `raw.md` (this mission, append-only log)

Workers, validators, planners append one-liners as they discover patterns:

```
[2026-04-24T10:05:12Z] worker F-023 TRICK: psql -f drizzle/*.sql applies migrations in filename order
[2026-04-24T10:18:33Z] validator F-023 -: F-023 verified via curl + DB row inspection
```

Truncated to last 10 entries by the curator on each pass. The curator promotes recurring patterns up to higher layers.

### L2 — `summary.md` (this mission, compact)

40-line / ~800-token summary that gets auto-injected into every role's prompt. Curator-maintained. Sections:

```
## Lessons
## Decisions (current)
## Avoid
```

This is what every role sees as "Memory (curated from prior iterations of this run)" at the bottom of their prompt.

### L3 — `MEMORY.md` (this mission, full)

Long-form curated memory: the full Decisions / Context / History / Lessons store. Bounded at ~200 lines. Roles can read this if `summary.md` points them at a specific section.

### L4 — `identity/<role>.md` (cross-mission, append-only)

`~/autonomous-harness/identity/worker.md` survives across every mission. The curator promotes patterns here when:

- A `TRICK:` entry has been mentioned by ≥2 distinct workers, OR
- A failure mode has recurred across missions, OR
- A tool/command convention is repeatedly forgotten.

Each role's identity file is auto-injected into its prompt as **"Your identity (cross-mission memory for the X role)"**.

## Why disk-only

- Any role can be invoked from a fresh shell at any time and produce the same output.
- Snapshots can be taken at iteration boundaries without quiescing in-memory state.
- The curator can rewrite history (compact older entries) without coordinating with running roles.
- Debugging is post-hoc: every prompt that ever fired is reconstructable from the on-disk state at that time + the role file.

## Why a curator

Without a curator, `raw.md` would grow unboundedly and no role would have the bandwidth to read it. The curator is the only role allowed to *delete* memory entries; it does so by promoting (in summary.md), demoting (out of summary.md, into MEMORY.md), or graduating (mission → identity).

Reading [Why a curator role](/docs/decisions/curator) for the full design rationale.
