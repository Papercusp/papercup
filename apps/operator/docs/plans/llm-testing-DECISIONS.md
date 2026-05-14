# LLM Testing Framework — Decisions Log

**Started:** 2026-05-14
**Maintainer:** the agent currently shipping the framework, plus whoever's after.
**Scope:** narrow log of *why* we picked a path when more than one was viable. Read together with the plan doc
(`llm-testing-framework-2026-05-14.md`) and the handoff doc
(`llm-testing-handoff-2026-05-14.md`).

This file is append-only in spirit — never delete a decision, supersede it with a follow-up entry.

---

## D-001 — Key supply via PG, not file or env-only

**Date:** 2026-05-14

**Choice:** `ANTHROPIC_API_KEY` is resolved by `llm-client.ts` in this order:
1. `process.env.ANTHROPIC_API_KEY` (if non-empty)
2. `readCredentials().anthropic_api_key` from `harness_shared.operator_credentials`
3. throw with an instructive message

**Considered:**
- env-only (handoff's original ask): forces every user to wire shell exports + remember to unset `ANTHROPIC_AUTH_TOKEN`.
- file (`~/.papercusp/anthropic-key`): fewer moving parts but parallel to the existing PG credentials store; mirror is exactly what `feedback_pg_canonical_no_mirrors` says not to do.

**Why PG:** `operator_credentials` already exists with an `anthropic_api_key` column. Reusing it removes a mirror, gives the UI strip at `/admin/testing` a single source of truth, and lets a one-time `INSERT` set up every future CLI invocation.

---

## D-002 — Scenario description threaded to sim-user

**Date:** 2026-05-14

**Choice:** `SimUserOpts.scenarioDescription` is set by the runner to `scenario.description`. The sim-user system
prompt includes a `## Scenario context` block that tells the sim to name concrete things (slugs, paths, ids).

**Considered:**
- Keep the plan's "elsewhere" phrasing and let the sim-user discover the goal from the persona's traits. This was what shipped originally; produced runs where the sim asked the operator about "workspace permissions" when S01 was supposed to be a `harness:status` query.

**Why thread:** the plan's "user_satisfied" goal kind explicitly said "the scenario description elsewhere tells you what that need is" — but no code populated elsewhere. The fix is one parameter; without it every scenario fails for a synthetic reason rather than the real one.

---

## D-003 — Zstd compression for transcript_raw, not deferred

**Date:** 2026-05-14

**Choice:** `storage.ts` uses Node 22+'s `zstdCompressSync` from `node:zlib` to write `transcript_raw_zstd`. A
matching `decompressTranscript()` helper is exported for the replay path.

**Considered:**
- Keep the "defer" comment and store raw bytes. Means the schema's `bytea` column is misleading and the column name lies.
- Reach for `@mongodb-js/zstd` or similar npm package. Adds a native-build dependency for something Node ships.

**Why native zlib:** Node 22 made zstd first-class in `node:zlib`. The repo is on Node 25. No reason to take a dep.

---

## D-004 — Claim ledger is opt-out, not opt-in

**Date:** 2026-05-14

**Choice:** `runOnce()` always attempts `tryClaim()` unless `PAPERCUSP_LLM_TEST_SKIP_CLAIM=1`. A
`claim_busy` failure is a soft-skip, not a hard-fail.

**Considered:**
- Opt-in via `--parallel >1` flag: simpler runtime path but means single-process runs against a shared CI dev DB
  could still collide silently.
- Hard-fail on claim_busy: too noisy for a dev who just wants to retry.

**Why default-on:** the cost of a soft skip is one log line. The cost of a missed claim is ~$0.10 of duplicate
Anthropic spend per scenario. Asymmetric.

---

## D-005 — Promotion lineage via Violation.originatingFindingIds + storage write

**Date:** 2026-05-14

**Choice:** When `promote.ts` scaffolds a custom-kind assert, it embeds the source judge-finding ids as a
`readonly string[]` const in the stub. The auto-registered evaluator merges those ids onto every violation it
returns; `storage.ts` writes them to `llm_test_findings.promoted_from`.

**Considered:**
- Track lineage purely in PG via an `assert_id → originating_findings` lookup table. Cleaner separation; one
  more table to migrate.
- Lookup at write-time by parsing the stub source. Brittle; readers don't expect storage.ts to read disk.

**Why the const-in-stub path:** the data is already named in the stub's TODO comment block — promoting it to a
real const is a one-line extra. Storage already iterates violations; pulling one optional field through is cheap.

---

## D-006 — `--parallel N` via Promise.all batches, not workers

**Date:** 2026-05-14

**Choice:** the CLI batches scenarios into `Promise.all` groups of size N. Each runner is async I/O-bound (SSE
streaming + LLM calls), so Node interleaves naturally without worker threads.

**Considered:**
- `worker_threads`: one process per scenario, perfect isolation. Heavy for an I/O-bound task; each worker re-
  imports the framework (~300ms+).
- `node --workers` style. Same overhead, more orchestration code.

**Why Promise.all:** N=4 against the dev `operator-converse` route is comfortable; pushing higher is the
operator's concurrency cap, not ours.

---

## D-007 — Strict axis mode emits meta findings, not silent defaults

**Date:** 2026-05-14

**Choice:** `parseJudgeResponse` emits a `severity=warn` meta finding when the judge omits a rubric axis (was
silently defaulting to 0) and a `severity=info` finding when the judge emits an axis not in the rubric.

**Considered:**
- Hard-fail on missing axis: would force a judge retry and inflate cost; the response was otherwise valid.
- Continue silently defaulting to 0: hides a judge-protocol regression behind a score that looks like a
  real-life "the SUT did nothing on this axis" zero.

**Why warn-not-fail:** the run still has useful signal even when the judge skips an axis; we just want to *know*
it happened so we don't grade a missing score as a 0.

---

## D-008 — Migration runner stays opt-out at the per-migration level

**Date:** 2026-05-14

**Choice:** the existing `@restart/embedded-postgres-server/src/migration-runner.js` is the single canonical
boot-time applier. When it stops on an error (per the audit-log ownership issue today), the fix is to backfill
`harness_shared.schema_migrations` so the runner skips known-applied migrations on the next boot.

**Considered:**
- Per-migration apply scripts (`apply-NNN.sh`) — already exists for 058/066. Useful as escape hatch but should
  not be the primary path for new migrations.
- Make the runner skip failures rather than halting. Too risky; one runner-side failure shouldn't lead to a
  partial schema.

**Why no new runner:** the existing one is correct and self-healing; the gap was data, not code.
