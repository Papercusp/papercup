# Testing — @papercusp/operator-core

**Run:** `npm test` (from this dir; `vitest run --passWithNoTests`) for unit
tests, `npm run test:integration` for `*.integration.test.ts` (needs Docker —
testcontainers Postgres; `npm run test:doctor` at the repo root verifies the
environment). Tests are colocated with their source under `lib/**`.

This package is large; the **canonical inventory** of what runs where is the
testing-domains registry (`lib/testing-domains-registry.ts`) — the `/admin/testing`
and `/adv` Tests tabs discover suites from its globs, and the repo-root
`npm run lint:tests` (run from `apps/operator`) fails if a canonical test
matches no glob. Don't hand-catalog suites here; register them.

## Memory bench (memory-backend-benchmark-2026-06-05)

The Papercusp-specific half of the memory-backend benchmark lives at
`lib/memory/bench/` (the generic engine + its tests live in
`libs/generic/memory` — see that package's TESTING.md):

| File | Covers |
|---|---|
| `corpus.test.ts` | The frozen real-corpus fixture (`fixtures/corpus.v1.json`) invariants + read-only snapshotting. |
| `gold-set.test.ts` | The frozen gold set (`fixtures/gold-set.v1.json`): key bindings against corpus.v1, class mix, verbatim-token/leak guards. |
| `run-bench.test.ts` | The live runner's pure parts (backend contexts, report assembly). |
| `index-cap.test.ts` | The file-index cap probe (P-010, D-004): the MEMORY.md projection simulation (durable protection, oldest-project eviction, soft/hard-cap behavior) **pinned byte-for-byte against the real `~/.claude/scripts/memory-compact.mjs`** (that pin auto-skips where the script doesn't exist). |

Live runs (not Vitest — they need PG + an embedder key and write artifacts to
`.papercusp/bench-reports/`):

```bash
npx tsx packages/operator-core/lib/memory/bench/bench-cli.ts [--scale 1000,10000]
npx tsx packages/operator-core/lib/memory/bench/index-cap-cli.ts   # pure FS, no PG
```

Isolation (D-009): the live bench uses the `bench_memory` PG schema
(created/dropped per run) and temp-dir claude-file stores — it never writes
`harness_shared.memory_*` or the real `~/.claude` store. **`bench-cli`'s schema
name is fixed, so two full bench runs must not overlap**; the session-extraction
probe and the dedup re-run below each use their own schema and can run alongside.

## Session-backed extraction (mem0-extraction-via-claude-session-2026-06-06)

mem0's fact extraction rides cascade rung #1 = the Claude session
(`claude-haiku-4-5` on `anthropic-direct`); the adapter lives at
`lib/memory/session-extraction-llm.ts`, the seam/cascade in
`libs/generic/memory` (see that package's TESTING.md).

| File | Covers |
|---|---|
| `session-extraction-llm.test.ts` | The `SessionExtractionLlm` adapter: strict-JSON parse + one repair-retry + throw-to-cascade (D-005), the 401 → cache-invalidate → re-read → retry-once → sticky-demote protocol (P-004/D-004), the factory's probe/env/dead-rung gating, usage-counter telemetry, and the loudness end-to-end (`mem0.add()` stores via the fallback WHILE warning loudly — P-006). |

Live runs (not Vitest — need a Claude session, PG, and an embedder key; both
**exit 2 = skip** without a usable session so a key-rung pass can't false-positive):

```bash
# P-007 round-trip probe: remember → Haiku-extracted → paraphrase-searchable,
# isolated schema `live_session_extraction`. Registered in /admin/testing
# (memory → Live).
npx tsx packages/operator-core/lib/memory/session-extraction-live.ts

# P-008 dedup re-run: the bench's near-dup tier under the session extractor,
# isolated schema `bench_dedup_haiku`; artifact → .papercusp/bench-reports/
# (2026-06-07 result: 4/6 merged vs 0/6 under the gpt-4o-mini fallback).
npx tsx packages/operator-core/lib/memory/bench/dedup-rerun-cli.ts
```

## After editing memory code

`npx vitest run lib/memory` here; if you changed the seam or engine in
`libs/generic/memory`, run that package's suite too.
