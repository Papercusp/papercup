---
title: LLM testing framework — decisions log
slug: llm-testing-DECISIONS
status: shipped
created: 2026-05-14
updated: 2026-06-01
owner: pandawamble@gmail.com
---

## Now

**State:** **Started:** 2026-05-14 **Maintainer:** the agent currently shipping the framework, plus whoever's after. **Scope:** narrow log of *why* we picked a path when more than one was viable. Read together with the plan doc (`llm-testing-framework-2026-05-14.md`) and the handoff doc (`llm-testing-handoff-2026-05-14.md`).

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


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

## D-009 — Skip enforced workspace isolation; live state is the SUT

**Date:** 2026-05-14

**Choice:** `Scenario.realWorkspace` stays as metadata only. `OperatorTarget`,
`OracleTarget`, and `ArchitectTarget` all hit the live operator dev
server with the live PG state. No per-run `getHarnessAdminUrl()`
override, no schema-drop on close.

**Plan §4.5 said:** "Default: isolated per-run workspace.
`workspaceRoot=/tmp/llm-testing-runs/<runId>` — fresh per-workspace
PG via `getHarnessAdminUrl()`. Cleanup: `close()` drops the isolated
PG schema entirely."

**Considered:**
- Implement the plan literally: spawn an embedded-pg per run, scaffold
  the harness_shared schema, run the operator dev server against it,
  drop the schema on close. Days of engineering for marginal gain.
- Hybrid: keep live PG but use a synthetic userId per run so mem0 reads/
  writes don't cross-talk. Mem0 doesn't currently key on `uiClientId`,
  so this needs a Mem0 contract change first.
- Document the gap and move on. ← chosen.

**Why skip:**
- `uiClientId='llm-testing/<runId>'` already filters telemetry per run
  (`tool_invocations.metadata_json @> '{"uiClientId": ...}'`).
- The framework is finding REAL operator bugs against live state —
  that's the value proposition, not synthetic-state correctness.
- Isolated runs against a stub PG would miss exactly the integration
  bugs we want to catch.

**Follow-up:** if mem0 cross-talk becomes a real debugging cost, the
right move is a per-run synthetic user id, not a per-run PG. Track via
issue rather than re-litigating §4.5 today.

---

## D-010 — Use findings UI as the alert surface, not `harness_escalations`

**Date:** 2026-05-14

**Choice:** Phase 5 nightly cron does NOT write to
`harness_shared.harness_escalations`. The "alert" path is the existing
`/admin/testing` → LLM → Findings sub-tab, which lists every
`acknowledged=false` finding across all runs, severity-sorted.

**Plan §12 Phase 5 said:** "Alert via existing escalation surface
when new findings appear or pass-rate drops."

**Considered:**
- Insert one `harness_escalations` row per nightly run with a summary.
  But `harness_escalations` is keyed `(harness_slug, phase)` — single
  upsert-able row per harness-phase pair. LLM test runs aren't harness-
  scoped (they target the operator/oracle/architect, not a harness).
  Forcing them in would muddy the slug-keyed semantics.
- Add a new `system_escalations` table. Premature; we have a working
  surface.
- Use the findings UI as the alert surface. ← chosen.

**Why findings UI:** every unacknowledged severity=error finding is
already on the screen with a copy-as-prompt button. That's the
actionable surface. Cron + journald carry the per-run-summary trail.

---

## D-011 — In-process transport stays a TODO, HTTP-SSE is the default

**Date:** 2026-05-14

**Choice:** `OperatorTarget.send()` throws on `transport: 'in-process'`.
Every scenario actually runs through HTTP-SSE against `/api/agent-mcp/
operator-converse`. The `transport` field on `Scenario` is accepted
but only HTTP-SSE works today.

**Plan §10.4 said:** "Default: in-process call with
`ToolDispatchOverride`. The operator `ChatTarget` calls the converse
handler directly with a per-run dispatcher override, bypassing the
HTTP route entirely."

**Considered:**
- Implement the in-process path: factor out the converse tool's
  side-effects (budget gate, session-user resolution, mem0 dual-scope,
  chain-ledger writes) so they're callable without the Hono route.
  ~1–2 days; touches the operator's hottest code path.
- Move to in-process for new targets but leave operator on HTTP-SSE.
  Inconsistent.
- Keep HTTP-SSE and document. ← chosen.

**Why HTTP-SSE for now:**
- The plan's stated benefit of in-process is speed (no HTTP overhead)
  and richer ctx control. The actual operator-converse hot path is
  ~30–90s/turn dominated by Anthropic-side generation; HTTP overhead
  is single-digit ms.
- `ToolDispatchOverride` still works via the shared
  `apps/operator/lib/projected-tool-deps.ts` `overrideTool` —
  S12b's deterministic injection path is exercised over HTTP-SSE
  exactly the same way it would be over in-process.
- All real bugs the framework has surfaced are in the operator's
  HTTP-served behavior. In-process would test a route we don't ship.

**Follow-up:** revisit when adding a target whose handler doesn't
have an HTTP route (a pure tool wrapper). Then the in-process
abstraction earns its keep.

---

## D-012 — Telemetry-tagging audit stays static + synthetic-dynamic

**Date:** 2026-05-14

**Choice:** The §5.4 telemetry-tagging audit is:
(a) static-source check of `apps/operator/app/api/agent-mcp/operator-
converse/route.ts` confirming `ctxBase.uiClientId = body.uiClientId`,
(b) static catalog grep guarding against future `ctx.metadata({
uiClientId: ... })` overrides in handlers, and
(c) dynamic concurrency walk via `parallelism-smoke.test.ts` that
dispatches synthetic tools and asserts per-call uiClientId fidelity.
It is NOT the plan's "enumerate every tool via `endpoint:list-tools`,
invoke each with probe args, assert metadata_json carries the tag."

**Plan §5.4 said:** "Enumerates every tool via endpoint:list-tools.
Invokes each tool with a probe ctx.metadata and minimal valid args
(uses a per-tool stub registry for required inputs). Asserts the
resulting tool_invocations row has metadata_json->>'uiClientId'."

**Considered:**
- Stand up the per-tool stub registry the plan calls for. With ~96
  built-in tools + plugin tools, each requiring real args (workspace
  ids, harness slugs, capability tokens, etc.), this is 1–2 days of
  fixture-building plus brittle maintenance.
- Use a no-args probe and accept that tools failing on arg validation
  short-circuit before recording metadata. That defeats the audit's
  purpose.
- Sample a curated set of tools instead of full enumeration. Still
  catches drift but spec-deviates.
- Keep current static + synthetic-dynamic split. ← chosen.

**Why current split is sufficient:**
- The dispatcher auto-fill is one code path in
  `packages/agent-mcp/src/dispatch-projected.ts`. If it works for one
  tool, it works for all (it's tool-agnostic). The 5 unit tests in
  `dispatch-projected.test.ts` + the parallelism-smoke's N=20 fan-out
  exercise the path with synthetic tools, which is precisely the
  invariant the plan wanted to guarantee.
- The only failure mode the static check can't catch is a handler
  that calls `ctx.metadata({ uiClientId: SOMETHING_ELSE })` — and our
  static grep guard fails the build on any such occurrence.

**Follow-up:** when adding tools that genuinely override metadata
(plausible future: a tool that wants to override workspace_id in its
own row), promote the static guard to a runtime audit with real PG
roundtrip. Today's catalog has zero such tools.

---

## D-013 — S08 silence-nudge: framework can't exercise it end-to-end

**Date:** 2026-05-14

**Choice:** Leave S08 (`op-S08-silence-nudge-ready`) declaring
`triggers: [{ on: 'silence', fire: 'silence_nudge', param: 30 }]` and
let it fire on turn 0 (per the runner's silence/at_secs simulator
approximation). Accept that it cannot exercise B9 (silence-nudge ready
card) end-to-end as written.

**Why it can't fire end-to-end:**
1. The operator-converse route's `ConverseRequestBody.trigger` enum
   is `'user_message' | 'quiet_wait_resume' | 'open_canvas' |
   'user_says_ready' | 'user_welcomed' | 'continue'`. It does NOT
   accept `'silence_nudge'`.
2. The actual production B9 path goes through a separate route
   `/api/operator/conversations/[id]/silence-nudge` (plan §10.1
   reference), not `operator-converse`. That route emits the ready
   card via a different surface.

**Considered:**
- Extend the converse route's `trigger` enum to accept `'silence_nudge'`.
  Touches the production hot path; the brain has no logic for that
  trigger today.
- Drive the silence-nudge route from `OperatorTarget` instead of /
  alongside the converse route. Real route surgery; out of scope.
- Drop S08 entirely. Loses behavioral coverage even imperfect signal
  has value.
- Document + leave. ← chosen.

**Follow-up:** if the operator team unifies silence-nudge into the
converse trigger path, S08 starts working without code changes.

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
