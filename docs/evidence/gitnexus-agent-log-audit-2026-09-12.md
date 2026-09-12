# GitNexus opportunities from actual Papercusp agent logs

Date: 2026-09-12. Work item: WI-10001115. Analyst: su-8ee55568-a37b-4b6b-84f3-e02e11c10d86.

## Finding

GitNexus can replace some of the navigation between known functions, some broad file-range reads whose purpose is to obtain one known function, and some manual caller discovery. Live replays against symbols in the observed sessions returned useful results. It cannot currently replace the complete investigations: an existing function was absent from its index, a route lookup returned no match, and a subsequent route probe encountered an unavailable database. Literal searches, current source inspection, runtime diagnosis, evidence evaluation, and tests remain necessary.

This report concerns what agents actually did, not the earlier conversations that designed the platform. It does not claim measured token savings, faster task completion, a fleet-wide adoption percentage, or that an agent omitted a dependency merely because a selected excerpt did not mention it.

## Method and scope

The sampling frame was 2026-09-11 20:00 UTC through 2026-09-12 20:00 UTC. Candidate sessions were selected from native activity attributed to the Papercusp harness or canonical checkout. The analyst's owner was excluded. Selection favored sessions with repeated code searches and file reads, with several recent investigation sessions added. This is a purposive opportunity sample, not a random sample of fleet work. The illustrated episodes are from September 12.

Nine session command sequences were inspected; three were examined through adjacent recorded tool-call/result parts as well as surrounding conversation text. Additional candidate-directory rows and one session's opening context were screened but are not counted as detailed case evidence.

Sources and semantics were checked before interpreting the records:

- `harness_shared.agent_activity`: native hook activity. `activity-pg-store.ts` writes tool name, phase, summary, detail, session, owner, and cwd. This report selects `phase='post'`; pre/post records are not counted as separate operations. Commands were recovered from the structured detail, including the legacy JSON-string representation. A command may batch several shell operations.
- `harness_shared.session_turn_parts`: actual tool calls/results in transcript order. `search/session-ingest.ts` records Codex function/custom calls and their outputs, and avoids double-counting the duplicate agent-message event. `part_idx` is a transcript-part index, not a conversational turn index.
- `harness_shared.session_turns`: surrounding agent explanation and task context. These are not substituted for execution evidence.
- File-backed transcripts use workspace `default`; native activity is separately scoped to the Papercusp checkout/harness. The two scope conventions were kept distinct.
- Retained tool parts are capped at 2,000 characters by `transcript-text-caps.ts`; their truncation markers were respected. The report cites retained commands/results and makes no claim to have recovered omitted output. Some original execution envelopes also explicitly reported output truncation before transcript ingestion.
- Queries were bounded by exact sessions or the stated time window and reduced through `code:run`. No new product behavior, gate configuration, agent role, or indexing policy was installed.

### Session inventory

| Session (Codex) | Material inspected | Role in the analysis |
|---|---|---|
| `01a096a3-96ee-7c21-a1d7-236ab43412d2` | Command sequence, tool parts 20–27, assistant turns 2–4 | Scheduler claim/cancellation investigation; detailed positive and negative replay |
| `01a09709-0ca1-74d0-b511-adfa29a7ffa2` | Command sequence, tool parts 80–89, assistant turns 11–15 | Verification evidence provenance; detailed positive replay |
| `01a09686-86f4-7563-a80a-46af90d828f1` | Command sequence, tool parts 105–112, opening context | Blueprint publication and moderation; route replay and operational control |
| `01a096ab-2c79-70c1-ae27-e1e8313f03fa` | Command excerpts and opening context | PTY verification, evidence-schema lookup, transcript recovery |
| `01a096c5-6f98-7623-a4c2-74baae3a2aa0` | Command excerpts and opening context | Restoring terminals; source plus process/filesystem investigation |
| `01a0961e-ab11-71f2-bae6-9be0c8401857` | Command excerpts | Acceptance/gate evidence and transcript-recovery control |
| `01a0965c-09bc-74f2-be37-0d915737f62a` | Command excerpts | Scratch evidence, CLI schema, environment, and transcript controls |
| `01a09731-ea29-7221-8564-43fbcad3a9b2` | Command excerpts before frame end; task/conclusion text | `code:run` timeout investigation; conclusion after frame end labeled as context only |
| `01a09730-d101-7431-b6ab-5cb5a8fe4806` | One search in the bounded frame | Consult cascade search; insufficient sequence to claim a substitution |

## Case 1: follow the scheduler's claim path

Agent `su-13609e96-faeb-4bac-af07-346934678bf0`, session `01a096a3-96ee-7c21-a1d7-236ab43412d2`, 17:23–17:27 UTC. The agent was investigating EI-23070293747146376: whether the scheduler timeout merely races a still-running claim. Its recorded conclusion identified `Promise.race` and investigated postgres.js cancellation. This report does not independently certify that bug conclusion.

Observed native activity:

| Activity ID | UTC | Command or relevant portion |
|---|---|---|
| `5556946` | 17:23:15 | Broad `rg` for `scheduler:get_next`, `scheduler_get_next`, and `get_next` |
| `5557000`, `5557002` | 17:23:37 | Read `agent-tools/scheduler/get_next.ts` ranges 1–260 and 260–620 |
| `5557075`, `5557072` | 17:24:08 | Read the same file at 1080–1775 and 1775–2075 |
| `5557076`, `5557093` | 17:24:08–16 | Search for the `getNextForBee` declaration |
| `5557099`, `5557100` | 17:24:18 | Read overlapping ranges 1770–2025 and 1580–1770 |
| `5557139`, `5557141` | 17:24:40 | Read `scheduler/claim-spec-store.ts` ranges 260–680 and 680–1080 |
| `5557170`, `5557172` | 17:24:58 | Read `scheduler/get-next.ts` ranges 2730–3130 and 1–280 |
| `5557260`, `5557262`, `5557269` | 17:25:49–52 | Search for `getLongLivedAdminPool`, transaction-deadline helpers, and `claimNextIssueWorkItem` |

Paired transcript evidence: parts 20/21, 24/25, and 26/27 preserve batched reads and execution envelopes explicitly reporting truncated output. This establishes an actual wide-read/re-read pattern. It does not establish how much of the agent's reasoning time it consumed.

### Live replay

`graph:query {op:'callees', name:'getNextForBee', repo:'papercusp', limit:10}` returned named callees including `getNextWorkItem`, `getLongLivedAdminPool`, `readClaimConcurrency`, `auditClaimAttempt`, and `matchesWorkItemClaimSpec`. Its response explicitly marked a capped result and stale index. A second query, `gitnexus.trace` from `getNextForBee` in `scheduler/claim-spec-store.ts` to `getNextWorkItem` in `scheduler/get-next.ts`, returned their direct CALLS edge.

Source corroboration: `scheduler/claim-spec-store.ts` declares `getNextForBee` at line 548 and calls `getNextWorkItem` at line 687; `scheduler/get-next.ts` declares the callee at line 2777 in the inspected tree.

**Concrete substitution:** after the entry point is known, replace repeated function-location hunts with the bounded callee list, then read the relevant claim/timeout bodies. This does not replace reading the `Promise.race`, SQL transaction, `.cancel()` API, or regression tests. An ordinary known-definition jump is also an LSP job; GitNexus's extra value here is returning the connected helpers together.

**Negative control:** tracing onward to `claimNextIssueWorkItem` returned `not_found`. Exact `gitnexus.context` with its source file also returned not found. The function exists at current `work-items.ts:7911` and at line 7886 of the graph's own indexed commit `e60e76624bf82c89ce3fbadb9ad81af3e2d92888`. Thus this miss cannot be excused as a function added after indexing. The indexing/resolution cause was not diagnosed in this investigation. The full claim path cannot be delegated to GitNexus as an exhaustive authority.

## Case 2: understand how verification fingerprints are produced

Agent `su-97fccf61-e827-47ed-b670-751d6675a8a9`, session `01a09709-0ca1-74d0-b511-adfa29a7ffa2`, 19:36 UTC. Its surrounding conversation says it was rebuilding the current evidence tuple before completing P-003. Later turns distinguish the deployed evaluator from staging and describe actual evaluator/completion results; those runtime checks are not replaced by the code graph.

Observed sequence (transcript parts 80–89):

1. Search `evaluate-spec-test-adequacy` and the literal `sha256-file-set-v1` across packages/apps/libs; the execution result reports truncation.
2. Read `evaluate-spec-test-adequacy.ts` 1–220, `spec-evidence-store.ts` 1–180, and `spec-test-adequacy.ts` 650–780.
3. Search `currentProvenance` and `measureRepoFilesEvidence` (activity `5572983`, part 84).
4. Read `spec-evidence-store.ts` 860–985 (activity `5573004`, parts 86/87), followed by 985–1060 and another evaluator range (activity `5573028`, parts 88/89).

### Live replay

The first trace for `listSpecEvidence` was ambiguous between a production function and a test stub. Using the production UID from that response returned:

```text
listSpecEvidence
  -> measureRepoFilesEvidenceAtRoot
  -> fingerprintRepoFileSet
```

Exact arguments:

```json
{
  "from_uid": "Function:packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts:listSpecEvidence",
  "to_uid": "Function:packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts:fingerprintRepoFileSet",
  "repo": "papercusp",
  "maxDepth": 6
}
```

Source corroboration: `listSpecEvidence` calls the measurement helper at `spec-evidence-store.ts:921`; that helper calls `fingerprintRepoFileSet` at lines 104–105. A `gitnexus.context` lookup for `fingerprintRepoFileSet` with `file_path` and `include_content:true` returned the small hashing function's content and its caller. The payload included neighboring boundary text, so it should not be treated as a byte-exact source slice or used for editing.

**Concrete substitution:** use the trace to establish the measurement chain and symbol context to obtain the known helper, avoiding some range discovery and broad source pulls. Keep source inspection for the currentness-classification branches and keep the real evaluator calls. The initial search for the literal hash-prefix is still legitimately text search: the agent did not yet know which function owned that literal.

## Case 3: find a verification helper's other consumers

This is an additional replay around the same observed evidence investigation, not a claim that the original agent should have changed more files.

`graph:query {op:'callers', name:'measureRepoFilesEvidenceAtRoot', repo:'papercusp', limit:12}` returned the production callers `measureRepoFilesEvidence`, `listSpecEvidence`, and **`measureDesignAcceptance` in `design-compare/acceptance.ts`**. It also returned a test-file edge explicitly labeled as not a resolved call site.

Source corroboration: `design-compare/acceptance.ts:122` calls `measureRepoFilesEvidenceAtRoot` inside `measureDesignAcceptance`. This is a concrete connection between general spec evidence and design acceptance that a search constrained to the two files in the agent's quoted lookup would not show. The report does not claim that the entire original session missed it.

**Concrete improvement:** before changing this measurement helper, surface the design-acceptance consumer and its relevant tests. This provides an empirical candidate for a dependency-evidence step in the existing verification workflow. The returned names alone neither prove those consumers are tested nor prove there are no additional consumers.

## Case 4: route discovery does not yet qualify as a replacement

Agent `su-e0609a6c-f770-47a0-9d28-b065aed2f52d`, session `01a09686-86f4-7563-a80a-46af90d828f1`, 16:59–17:01 UTC.

The agent searched the concrete URL `/api/cupboard/publish-blueprint` across scripts/packages/apps (activity `5554142`; tool parts 107/108). The result explicitly reported truncation. It then read the publishing script and blueprint-distribution documentation (activity `5554153`; parts 109/110), made an actual publish request (parts 111/112), and searched moderation/approval behavior in source and docs (activities `5554336`, `5554354`, `5554376`, `5554385`). These were distinct source-understanding and operational steps.

`gitnexus.api_impact` with the URL and POST method returned no matching routes. Because the framework's source declares `/cupboard/publish-blueprint` without the `/api` prefix, a second probe used the exact handler file instead of treating the URL miss as conclusive. That probe failed with LadybugDB unavailable and a missing WAL file. The tool's suggestion that another process may be rebuilding the index was not independently established as the cause.

The handler source does exist: `packages/operator-core/lib/endpoint-route/routes/cupboard-publish-blueprint.ts`; the client constructs the URL at `scripts/publish-official-blueprints.mts:217`.

**Conclusion:** route-aware retrieval is a plausible future improvement, but this replay did not demonstrate it. Do not redirect this agent's route lookup to GitNexus yet. Narrow source-root searches or the existing endpoint registry remain appropriate, and graph lookup cannot replace the publication response or live moderation state.

## Negative controls: work the graph cannot replace

- **Transcript recovery:** sessions `01a096ab...`, `01a0961e...`, and `01a0965c...` searched session JSONL, wake spills, and scratch records. Examples: activities `5558059`, `5535782`, `5545479`. These are historical execution records, not repository call edges.
- **Terminal/process diagnosis:** session `01a096c5...` searched launcher code alongside systemd configuration, OOM policy, process records, and terminal logs. Activities `5560678`, `5560834`, and `5560950` show the mixed investigation. A code graph may orient the source branch; it cannot establish which process died or which configuration the live host loaded.
- **Live verification/closure:** session `01a09709...` needed authoritative evidence fingerprints, the correct staging evaluator, and completion-gate responses. Its turns 12–15 show that source understanding was followed by actual runtime checks. A graph cannot make those checks redundant.
- **Exact literals, configuration, and external dependencies:** the scheduler session inspected `node_modules/postgres` cancellation definitions; the evidence session searched a literal hash prefix; other sessions searched schemas and script configuration. Index coverage and compiler semantics differ. Do not turn these into compulsory graph calls.
- **Insufficient evidence:** the bounded frame contains just one consult-cascade search from `01a09730...`. No savings or substitution conclusion is drawn from it.

## What to adopt from these observations

1. **Known function -> connected functions:** offer `graph:query` callees/callers once a source symbol has been identified. The scheduler replay is a concrete fixture.
2. **Known function -> bounded source context:** offer `gitnexus.context` for read-only comprehension when the index is relevant and fresh enough; use source/LSP for exact current semantics and all edits. The hashing-helper replay is a concrete fixture.
3. **Shared helper change -> consumer evidence:** surface graph-discovered consumers into the existing work-item/rubric evidence process and verify important edges in source. The design-acceptance consumer is a concrete fixture.
4. **Keep explicit non-substitutions:** literal search, session recovery, live state, tests, and operational actions should not inflate a supposed GitNexus opportunity count.
5. **Validate selection, not tool-call quotas:** replay these cases through the intended coding roles. Require useful expected edges, missing/ambiguous/stale/error handling, and an appropriate fallback. The historical schema/capability failures and observed index omissions must remain visible.

The existing function body, trace, and caller results demonstrate useful retrieval. They do not demonstrate a faster completed agent task. A subsequent controlled task replay should compare correct conclusions, relevant source consumed, wall time, and test/consumer coverage, including indexing/query cost. No numeric savings estimate is justified by this audit alone.

## Current operational caveats

The successful graph responses in this audit still referred to index commit `e60e76624bf82c89ce3fbadb9ad81af3e2d92888`, indexed at 2026-09-12 09:35:16 UTC, and the curated facade marked it stale/degraded. Selected positive relationships were corroborated against current source. That corroboration does not certify the rest of the index.

Earlier in this conversation, a caller lookup for `pinModuleState` returned SIGSEGV (recorded as EI-23083910793884912). The later successful scheduler/proof queries establish partial functionality, not a retraction of the earlier failure. This audit also observed the route-file database failure and the existing-symbol miss. All are reasons to preserve fallbacks and avoid making the shared live graph a mandatory dependency of every green-checkpoint run.

## Re-reading the evidence

For conversational reasoning, use the full session IDs and turn indices above with `sessions:read` or `sessions:search`. The session reader returned `invalid escape string` during this investigation; bounded reads of the existing transcript tables provided recovery, with the defect captured as EI-23084905907473824.

For execution evidence, query exact `agent_activity.id` values or exact `(source_kind='codex', session_id, part_idx)` tuples in `session_turn_parts`. Tool part indices are not accepted as `session_turn` references. Preserve the distinction between a recorded command, its returned output, and a later agent explanation. Short-retention transcript parts and their truncation are limitations; the verbatim command excerpts and selected replay results above preserve the findings needed to reassess the recommendation.
