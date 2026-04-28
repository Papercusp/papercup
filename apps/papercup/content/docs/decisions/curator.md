---
title: Why a curator role
description: Without compaction, raw observations grow unboundedly.
---

The curator is one of the harness's load-bearing roles. It's the only role allowed to *delete* memory. Without it, `raw.md` grows linearly with iterations and no other role would have the bandwidth to read it.

## What the curator does (in order)

1. **Process pending issues** (`pending-issues.jsonl` → `issues.json`). Validators emit findings in JSONL; curator dedupes by code-pointer + title, increments attempt counters on duplicates, auto-closes stale issues.
2. **Promote raw observations.** Workers/validators/etc append to `raw.md` as they go. Curator promotes recurring patterns to `MEMORY.md` (if mission-specific) or `identity/<role>.md` (if generalisable across missions).
3. **Update summary.md.** Bounded at 40 lines. Re-derived from MEMORY.md every run. This is what every role sees auto-injected.
4. **Truncate raw.md.** Keep last 10 entries as recent-history ballast.
5. **Maintain identity files.** `~/autonomous-harness/identity/<role>.md` per role. Append-only. Compaction trigger: file exceeds 60 lines.

## Why "compaction" is a separate role

Other frameworks bundle memory maintenance into every agent. The result is:

- Workers spend tokens deciding what's worth remembering.
- Different workers disagree on what's important.
- Mid-mission deletes (because two workers thought the same lesson was wrong) cause memory churn.

Splitting compaction into a dedicated role gives:

- One place to review the "what should we remember" prompt.
- Atomic mutations (curator runs, all roles see the new memory next iteration).
- Auditable history — `raw.md` is the working set, `MEMORY.md` is what the curator distilled.

## When the curator fires

- On terminal events: `DONE` and `ESCALATE`. Always.
- On manual trigger via UI.
- (Optional) After every N iterations — not currently auto-fired, but easy to add.

## The "TRICK:" promotion path

Workers can flag observations they think are durable:

```
[2026-04-24T10:05:00Z] worker F-023 TRICK: psql -f drizzle/*.sql applies migrations in filename order; do NOT use npm run prisma:migrate
```

Curator sees this and:

1. Counts how many distinct workers (by feature id) have flagged something with the same `TRICK:` lemma.
2. If ≥ 2: promote to `identity/worker.md` under "Patterns I've learned".
3. If just 1 but it references codebase-specific paths: promote to this mission's `MEMORY.md` Lessons.

The worker doesn't decide where the observation belongs. They just flag. Curator decides.

## Why this design wins

- **Single point of truth** for what "memory" looks like.
- **No coordination** between roles for memory writes; everyone appends to `raw.md`, curator handles the rest.
- **Bounded growth.** 40-line summary, 200-line MEMORY, 60-line identity-per-role. The system can't accidentally ingest more than it can re-read.
