---
title: Why we built our own harness
description: 'A small bash supervisor that owns the loop, not the company.'
---

We surveyed 11+ existing Claude Code frameworks before writing our own. They cluster into two patterns — both unfit for what we needed — so we built a third. The full survey, the patterns we borrowed, the ones we rejected, and the ones we invented are in [Compared to other frameworks](/docs/compared/overview).

This page is the short version: what we needed, and the bet we made.

## What we needed

- A loop *we* own — `bash` + `claude`, no other runtime to stand up.
- Orchestration via files on disk so any role can read everything anytime.
- Per-role prompts as markdown, so improvements compound without code changes.
- Observability: cost-per-feature, decision-parse ghost rate, role-by-role timing.
- Branch isolation we can rip out and replace (no proprietary tracker integration).
- Eventually, an *outer* loop — directors that coordinate work *across* coding harnesses, not just one harness running in isolation.

## The bet

The cheapest, most maintainable autonomous coding rig is:

1. A small bash supervisor with no agent-runtime opinion (~1500 lines).
2. Stable per-role markdown prompts (so prompt cache hits dominate).
3. Everything on disk (so any role can re-derive state from scratch).
4. A curator role that distils noisy raw observations into durable memory.
5. Observability over autonomy — show every decision the orchestrator made.

If that bet is wrong we'll find out fast: the harness will rack up cost, drift, or get stuck. As of writing it ships features at $135/mission with a 99.94% cache-hit rate and 22/37 features green at iteration 5.
