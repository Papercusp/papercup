---
title: Why fresh contexts per role
description: Drift-resistance over efficiency. Plus, prompt cache makes it free.
---

Every role invocation is a fresh `claude` subprocess with no shared in-memory state. The role re-reads SPEC, contract, features, and its own identity file every time.

## The case for shared context (what we don't do)

A long-running agent that maintains a conversation across iterations has theoretical advantages:

- It remembers what it just tried.
- It can reuse intermediate computation.
- It doesn't re-read the same files.

In practice, every long-running agent we've measured drifts. Hour-1 instructions lose weight against hour-3 code. The agent starts agreeing with its own bad decisions because they're already in its context.

## The case for fresh contexts (what we do)

- **No drift.** Every invocation reads the canonical state from disk.
- **Reproducibility.** Same files in → same output (modulo model nondeterminism).
- **Debug-ability.** A failed invocation can be replayed with the exact prompt it saw.
- **Per-role specialisation.** Each role can have a tightly-scoped prompt without dragging in irrelevant history.

## The cost question

A naive read of "fresh context" is "you pay full prompt tokens every iteration." Anthropic's prompt cache changes the math: when the per-role prompt prefix is stable, only the runtime context (~1KB) is fresh-billed.

In our live missions we measured **99.94% cache hit rate** (180M cache_read vs 106K fresh input over a 5-iteration mission). The cost of "fresh" was effectively zero.

The trick is making the per-role prompt prefix stable:

```
<role.md, never changes mid-mission>
+ <identity/role.md, append-only and slow-changing>
+ <memory/summary.md, stable for ~5 iterations between curator runs>
+ <runtime context, the only fresh-billed bit>
```

If we mutated identity or summary every iteration, we'd lose the cache. The curator only writes when it has something durable to add.

## Tradeoffs we accept

- **No conversational repair.** A role can't say "you didn't understand, try again." It produces output, exits, and the next iteration starts clean. We replace this with the orchestrator's decision verbs (`NEXT_WORKER` is "try again with fresh eyes").
- **More tokens per turn.** Even cached, we pay cache-read fees. Cheaper than fresh-input but not zero.
- **Disk I/O.** Every role reads dozens of files at startup. Negligible compared to LLM latency.

## Inspiration

Pattern is most explicit in [GSD (Get Shit Done)](https://github.com/lex-c/gsd) which uses per-phase orchestrators that explicitly hand off to fresh orchestrators rather than continue. We do the same per-role, every iteration.
