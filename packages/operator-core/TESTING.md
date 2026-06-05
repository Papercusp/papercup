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
`harness_shared.memory_*` or the real `~/.claude` store. **The schema name is
fixed, so two live bench runs must not overlap.**

## After editing memory code

`npx vitest run lib/memory` here; if you changed the seam or engine in
`libs/generic/memory`, run that package's suite too.
