---
title: Why prompt-cache-dominant
description: 99.94% cache hit rate is a design goal, not a coincidence.
---

The harness is designed so that Anthropic's prompt cache absorbs the cost of fresh-context-per-role. We treat the cache hit rate as a primary observability signal.

## What we observed

On a 5-iteration mission with 13 role invocations:

| Metric | Value |
|---|---|
| Cache read tokens | 180,049,624 |
| Fresh input tokens | 106,471 |
| **Cache hit rate** | **99.94%** |
| Output tokens | 24,533 |
| Total cost | ~$0.31 (vs ~$3.10 if everything was fresh-billed) |

This held across many iterations because the per-role prompt prefix is *stable*.

## How to keep cache hit rate near 100%

1. **Stable per-role prompt files.** Don't edit `prompts/worker.md` mid-mission. If you need to, accept one cache-miss iteration as the cost.
2. **Append-only identity files.** Curator appends to `identity/<role>.md`; never rewrites. Each append shifts the cache key by exactly one line.
3. **Bounded summary.md.** Cap at 40 lines. Stable for ~5 iterations between curator runs. Each curator pass is one cache-miss; the next 5 invocations are cache-hits.
4. **Runtime context at the end.** The fresh-billed bit (`FEATURE_ID=…`, working dir, etc) is appended *after* the cached prefix so it doesn't poison the cache.

## What breaks the cache

- Editing role prompts during a run.
- Reordering sections in `summary.md`.
- Adding hooks that mutate disk state mid-iteration in ways the prompts read.
- Rotating the model mid-mission (cache is keyed on model).

## Why this matters operationally

A non-cached harness would cost ~10× more. At our scale (~$135/mission with cache, ~$1350 without), the cache is the difference between viable and unviable.

It's also a quality signal: a sudden drop in cache hit rate means *something is rewriting state we expected to be stable*. We added cache-hit-rate display to the `/usage` UI panel for exactly this reason.

## Why other frameworks ignore this

Surveying 11+ alternatives, none of them publish cache hit rate as a metric. Most are structured to *prevent* high cache-hit rates: they mutate prompts mid-run (Hermes, Agentwise), they ship with prompt-rotation logic (LangChain), or they don't use Anthropic at all.

Our design is intentionally tuned to make prompt-cache hits the rule, not the exception. It's our biggest cost lever.
