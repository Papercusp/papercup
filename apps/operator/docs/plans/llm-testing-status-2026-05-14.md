# LLM testing framework — Status (true)

**Last update:** 2026-05-14 (this file supersedes
`llm-testing-phase1-status-2026-05-14.md`, which was written
pre-runtime-verification and overclaims completion).

**Plan:** `apps/operator/docs/plans/llm-testing-framework-2026-05-14.md`
**Handoff that triggered this rebuild:** `apps/operator/docs/plans/llm-testing-handoff-2026-05-14.md`
**Decisions log:** `apps/operator/docs/plans/llm-testing-DECISIONS.md`

This doc is the honest ledger. Read it before trusting any other
status claim in the directory.

---

## What runs end-to-end against live SUT

- **Operator target** (`OperatorTarget`) — confirmed against
  `/api/agent-mcp/operator-converse` on :3055. Sim-user → SUT →
  judge full loop. Persists to `harness_shared.llm_test_runs` and
  `llm_test_findings`. Zstd transcript writer works; the
  `transcript_raw_zstd` column is now populated, not empty.
- **CLI**: `pnpm llm-test --scenario <id>` works. `--target <id>`,
  `--all`, `--no-matrix`, `--no-persist`, `--parallel N`, `--seed N`
  all wired. `export-fixture` writes paired `.sse` + `.telemetry.json`
  from a stored run.
- **Admin UI**: `/admin/testing` → LLM tab. Runs / Scenarios /
  Findings list views work. Top-of-tab key entry strip stores the
  Anthropic key in `harness_shared.operator_credentials`.
- **Claim ledger**: `harness_shared.llm_test_claims` (migration 074)
  + `lib/llm-testing/ledger.ts`. Parallel runners can't double-claim
  the same (scenario × identity × matrix_index) tuple. Set
  `PAPERCUSP_LLM_TEST_SKIP_CLAIM=1` to disable for unit tests.
- **Migration runner**: existing
  `@restart/embedded-postgres-server/src/migration-runner.js` now
  proceeds past 072 because `schema_migrations` is backfilled with
  001–074. Future migrations apply on boot without manual psql.

## What's tested (vitest, no live SUT)

51/51 tests pass:
- `identity.test.ts` — sha256 hash stability across persona/rubric.
- `fixture-loader.test.ts` — SSE parsing.
- `asserts.test.ts` — all 11 assert evaluators.
- `runner-aggregate.test.ts` — matrix aggregation + variance findings.
- `parallelism-smoke.test.ts` — dispatcher auto-fill is concurrency-safe.
- `telemetry-tagging-audit.test.ts` — static check that the route
  threads `uiClientId` into `ctxBase`, plus a static catalog scan
  guarding future `ctx.metadata({ uiClientId: ... })` regressions.

## What's verified live

- **S01 — `op-S01-status-quick`**: fully runs end-to-end. Verdict
  *fails* — but for a real reason: the operator brain narrates intent
  (`<say>Checking sheets now.</say>`) without invoking `harness:status`
  or emitting `<continue/>`. That's a SUT bug, not a framework bug.
  The plan's §12 claim "S01 should pass against current operator" is
  stale; the operator's behavior has drifted from when the plan was
  written.
- **Batch run in progress as of last commit**: `--target operator
  --no-matrix --parallel 2` is iterating all 13 operator scenarios.
  S01–S07 confirmed failing for the same family of reasons: no tool
  call, no `<continue/>`, narrated intent.

## What we have NOT yet verified live

- **Oracle target** (`OracleTarget`, 3 scenarios O1–O3): code on disk;
  endpoint `/api/oracle/chat` exists; no live run yet.
- **Architect target** (`ArchitectTarget`, 2 scenarios A1, A2): same
  state. `realWorkspace: true` so it'll need the `sheets` harness to
  be live (it is, per `harness_shared.projects`).
- **`--parallel N>1` against live SUT at sustained load**: works in
  unit tests; live behavior at N=4+ against operator-converse isn't
  characterized yet.
- **Replay against an exported fixture**: `exportFixtureFromRun` is
  on disk and end-to-end-shaped (decompresses transcript, writes
  paired files); a round-trip smoke (export → replayFixture → assert
  asserts evaluate) is pending.
- **Promotion lineage flowing through to UI**: the writer side is
  done (`originatingFindingIds` on Violation → `promoted_from` in
  PG). The Findings UI sub-tab already renders `promoted_from`
  badges; un-tested with real promoted asserts.

## Operator-side findings the framework has already produced

These are real SUT bugs. They've been emitted by the framework and
persist in `llm_test_findings` for any agent to query:

- **F-op-tool-1**: operator emits `<say>` messages narrating an
  intended tool call but never invokes the tool. Crosses every S01–S07
  run. Shapes (judge `axis=tools`) repeat enough to be promotion
  candidates.
- **F-op-cont-1**: operator either omits `<continue/>` entirely or
  emits one but produces no follow-up tool call on the auto-fired
  continue turn — same "narrate then quit" pattern.
- **F-op-fab-1**: when stuck, operator fabricates technical detail
  ("port 3070 isn't up", "no elapsed_secs_in_chain field") rather
  than refusing or retrying. Judge `axis=groundedness`.

These are noise from a *framework correctness* standpoint, but
exactly what the framework was built to surface.

## Honest backlog

| Item | State |
|---|---|
| Run all 17 remaining scenarios live and triage | In progress (operator batch) |
| ledger.ts + migration 074 | Done — committed `4512be7` + `80613bc1` |
| `--seed` / `--parallel` / `--all` CLI flags | Done — `7614e8d9` |
| Zstd compression in `storage.ts` | Done — `50d96617` |
| Replay format with telemetry snapshot | Done — `a433ddbd` (writer + sidecar reader) |
| Promotion lineage reverse | Done — `7614e8d9` (writer + storage) |
| Axis-weight strict mode | Done — `7614e8d9` (meta findings for missing/extraneous) |
| Dynamic telemetry-tagging audit | Done via parallelism-smoke + extended static guard |
| DECISIONS.md | Done — `5ecb0e50` |
| Wire 073 into permanent migration runner | Done — `schema_migrations` backfilled |
| `--parallel` worker-pool variant (vs Promise.all batches) | Deferred — see DECISIONS D-006 |

## Quick reference

```bash
# Single scenario
cd apps/operator
pnpm llm-test --scenario op-S01-status-quick --no-matrix

# Whole operator target sequentially
pnpm llm-test --target operator

# Everything, 2 at a time
pnpm llm-test --all --no-matrix --parallel 2

# Re-evaluate a stored run against the current rubric
pnpm llm-test replay --re-evaluate <run-uuid> --scenario op-S01-status-quick

# Export a run as a reusable fixture
pnpm llm-test export-fixture --run <run-uuid> --as v8-baseline/08-my-capture

# Promote a recurring novel-failure shape into a stubbed assert
pnpm llm-test promote-candidates
pnpm llm-test promote --shape <hash>
```

Env knobs:
- `ANTHROPIC_API_KEY` — takes precedence; falls back to
  `harness_shared.operator_credentials.anthropic_api_key` (saved via
  the UI strip at `/admin/testing` → LLM).
- `PAPERCUSP_LLM_TEST_SKIP_CLAIM=1` — disable claim ledger.
- `LLM_TEST_SUT_MODEL`, `LLM_TEST_JUDGE_MODEL`, `LLM_TEST_SIM_MODEL`
  — model overrides.
- `unset ANTHROPIC_AUTH_TOKEN` — required because the Anthropic SDK
  prefers it over `ANTHROPIC_API_KEY`. The CLI's `pnpm llm-test`
  wrapper does NOT unset it; do it in your shell.
