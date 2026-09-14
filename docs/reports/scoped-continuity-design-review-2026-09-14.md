# Scoped continuity: design, implementation, and next steps

## Verdict

**The description is substantially accurate as a statement of the intended hierarchy.** It closely matches the owner statement preserved in `effort-scoped-continuity-2026-09-02#D-007`: write at the most specific applicable effort level; a plan's history includes its own and related work-item history; a goal's history includes its own, related plans, and related work-items.

Three qualifications are essential:

1. **Durable lessons and current carry notes are not the same storage mechanism.** The durable effort history uses append-only posts at the level where the insight belongs. A checkpoint is a current continuity record with a bounded journal. Writing a lesson at a broader level does not copy or promote it from a child.
2. **The hierarchy defines eligible history, not unlimited inline delivery.** Broader reads summarize, select, cap, and disclose omissions. They do not concatenate every transcript.
3. **Leader and member reads differ.** Plan/goal rollups are broader-context reads. Ordinary work-item claims use the member-safe path, including relevant prior-attempt and ancestor material without receiving an unrestricted goal-wide descendant rollup.[^D1][^D2][^D3]

**Implementation verdict:** the inspected current source implements the core model, supported by focused unit tests and real-PostgreSQL consumer tests. However, the connected operator is serving an older version of the checked plan-history path. Therefore “implemented and tested in the current tree” is supported; “the full design is working on every deployed agent path” is not.

## 1. What the design actually says

### D-007: ownership and containment

The scope of the note follows the scope of the insight. A local implementation lesson belongs to the work-item; a cross-lane ruling belongs to the plan; a portfolio/goal-level conclusion belongs to the goal.

The relationships are already relational: work-item-to-plan, work-item-to-goal, and plan-to-goal. The design explicitly avoids another history store. This is direct support for PostgreSQL-first traversal.[^D1]

### D-008: broader scope means lower resolution

The design does not promise a larger prompt for a larger effort. It specifies a depth-dependent representation:

| Relationship to requested scope | Intended detail |
|---|---|
| Scope's own history | Bounded source text |
| One descendant level | Approach and outcome, with important extracted lessons |
| Two or more descendant levels | Root causes and false premises |

Fan-out must be bounded and omissions visible. The rule is to summarize and preserve recovery paths, not concatenate histories.[^D2]

### D-010: compression depends on what was captured

A later decision corrected an optimistic assumption in the original ladder. Fields such as root causes and false premises are derived from keyword-matched prose, not guaranteed structured facts.

The design therefore added write-time feedback from the same extractor used by the reader. It explicitly rejected mandatory new fields as the first fix. A selective model-based extraction pass was a possible later step if the feedback failed to improve capture.[^D3]

The historical percentages in that decision are September 2 measurements. They were not remeasured here and should not be presented as current rates.

## 2. Source-level implementation findings

### Scoped writing

`postLearnedAtLevel` defaults to the work-item. When a caller chooses plan or goal, it resolves the item's ancestors and writes to that level's thread. If the requested level does not exist, it falls back and reports `fellBack` rather than silently dropping the lesson.

The checkpoint tool invokes this durable write when `learned` text is supplied. The normal checkpoint remains separate; its success does not prove a durable lesson post also succeeded. The result distinguishes those operations.[^S1][^S2]

This means the system does not autonomously infer the correct scope for every sentence in a checkpoint. The caller chooses the lesson level; the machinery resolves and applies it.

### Journal and retention

Work-item checkpoint writing enables the existing journal. The checked journal writer bounds it by entry count, per-entry text, and total size. That is useful continuity protection, but not an unlimited archive of every historical checkpoint.[^S3]

A source omitted only from a brief can often be recovered. Content previously discarded by retention cannot be reconstructed merely because a raw-reference API exists.

### Compilation and compression

`prior-attempt-context.ts` collects current specifications, decisions, revision/evidence relationships, checkpoints, journal material, lifecycle, comments, completion and release provenance.

It then normalizes, orders, deduplicates, extracts fields, and applies a bounded representation. Retractions and canonical authority receive protection; residue has a separate representation. This is primarily deterministic compilation and field selection, not an LLM generating a fresh summary of every descendant on each read.[^S4]

At deeper levels, a record lacking the required extracted fields becomes an explicit `empty-at-depth` omission rather than an empty-looking history entry.

### Bounded history delivery

The inspected plan and goal history helpers request:

- A 6,000-byte serialized-brief budget through a parameter named `maxChars`; the budget's size function uses UTF-8 bytes.
- At most 16 rendered records.
- A descendant admission cap of 24.
- A 2,500 ms helper timeout.

These are values read from the writer/compiler, not measurements of actual latency or token cost. Additional surrounding response data can add overhead.[^S4]

The containment resolver distinguishes “descent not requested,” “children omitted by cap,” and “source unavailable.” The history wrapper carries recovery instructions and a status such as available, empty, or unknown.[^S5]

### Consumer wiring

Current source connects the history compiler to:

- Explicit/full plan reads.
- Plan-agent context bundles.
- Fleet leader briefs.
- Goal reads and goal-holder kickoff paths.
- Work-item prior-attempt reads, using the member-safe path.[^S6][^S7]

The plan getter deliberately refreshes descendant history outside the plan-body cache, because a child can change without the plan document changing.

This does not mean every narrow metadata read receives the rollup. Those exclusions are intentional context-budget controls.

## 3. Tests executed

The following current-tree tests passed during this review:

| Test group | Result | What it supports |
|---|---|---|
| Prior-attempt compiler, rollup, and plan-get cache tests | 58 passed | Compression, bounded behavior, recovery and cache-path mechanics |
| Real-PostgreSQL plan-history consumer suite | 5 passed | Stored lessons passing through actual plan/goal/leader consumers |

The PostgreSQL suite covers work-item corrections, plan and goal lesson capture, failed-read versus missing-history distinction, plan getter and launch delivery, leader brief delivery, goal-owned and descendant material, exclusion of unrelated items, and exact raw-note recovery.[^S8]

Commands:

```text
./node_modules/.bin/vitest run packages/operator-core/lib/prior-attempt-context.test.ts packages/operator-core/lib/prior-attempt-context.rollup.test.ts packages/operator-core/lib/agent-tools/plans/get.cache.test.ts --maxWorkers=1

# Working directory: packages/operator-core
../../node_modules/.bin/vitest run --config vitest.integration.config.ts lib/agent-tools/plans/plan-history-consumers.integration.test.ts --maxWorkers=1
```

These are meaningful checks of the named paths. They do not prove universal coverage of every agent launch route, every old record, or arbitrarily large histories.

## 4. A confirmed source/runtime difference

The connected operator was asked:

```text
plans:get {
  harness: "papercusp",
  slug: "effort-scoped-continuity-2026-09-02",
  heading: "History"
}
```

It returned a matching prose section—D-007, whose title contains “history”—and no `results[].history` field.

The current source special-cases `heading:"History"` and attaches the compiled history envelope. The current integration test exercises that behavior successfully.

The runtime-associated build reported by the platform was `e66be3c4ff`. Reading the two relevant files at that commit confirmed that its plan getter and prior-attempt module lack `readPlanHistoryContext`, which is present in the current tree. Its plan getter also lacks the current `historyOnly` branch.

This supports a **serving-generation gap on the tested path**, rather than a claim that the current implementation is missing. The observation is tracked as **EI-23210960729184724**. No restart, deployment, or code fix was performed as part of this review.

The implication for acceptance is important: a green helper test and a “shipped” plan status are not substitutes for testing the actual consumer on the generation agents are using.

## 5. Research insights that would improve this system

These are proposed improvements, not findings that every listed mechanism is absent.

### Priority 1: measure semantic survival at every depth

The current ladder preserves fields, but a field may not capture the complete lesson. Build paired fixtures in which the same history is read at work-item, plan, and goal level.

Test whether the reader retains:

- The correction that invalidates an earlier approach.
- The unresolved condition that prevents completion.
- The exact source of a claimed verification.
- A restriction on what action is permitted.
- A lesson whose wording does not contain the extractor's preferred keywords.

This applies the lesson from ACE and repeated-update evaluation: structural compression is not proof that meaning survived.[^R1][^R2]

### Priority 2: improve capture selectively, not by adding ceremony

The actual extractor still uses trigger patterns for root cause, retraction, and residue. D-010 already anticipated the problem.

First measure recent relevant notes and whether the write-time feedback helps. If important high-level lessons still become `empty-at-depth`, use a bounded semantic extraction fallback on those notes. Require source spans and preserve uncertainty; do not invent a root cause where none was established.

Reuse the existing extractor/capture interface and optional fields. Do not create another mandatory note-writing workflow.

### Priority 3: add task-relevant detail without weakening protected authority

Depth is a useful cost heuristic, but a deeply nested work-item may be exactly what the goal agent is investigating.

Retain the fixed baseline budget and protected corrections/residue. Allow an explicitly relevant child to receive more detail, or provide targeted source expansion, while shrinking less relevant ordinary detail. Keep access control, omission reporting, and member/leader boundaries unchanged.

This is selective resolution, not a larger concatenated history. Hierarchical retrieval and evidence-gap-driven escalation provide useful research models.[^R3]

### Priority 4: distinguish immutable recovery from current-object recovery

The current raw-ref resolver recompiles records and reports unresolved references when a source moves. That is honest, but it is not the same as an immutable snapshot.

For critical accepted conclusions and source quotes, reuse existing revision IDs/content hashes where available. Clearly distinguish “read this source as it is now” from “recover the exact evidence used in this brief.” Do not imply that an evicted checkpoint journal fragment remains recoverable forever.

### Priority 5: incremental refresh and delta delivery

The current plan getter correctly reads child history outside the plan-body cache. If that becomes costly, cache only against the actual source dependencies, not the plan revision alone.

Reuse the existing fingerprint and dependency machinery. Deliver a delta only if the consumer still has the base snapshot; otherwise send a fresh bounded snapshot. A correction must invalidate the relevant derived result even when no plan markdown changed.

Hindsight's scoped refresh and source-validity checks are useful references. They can be adopted as patterns over PostgreSQL without adopting a separate memory database.[^R4]

### Priority 6: test the consuming agent after repeated context boundaries

Add a small end-to-end evaluation: work-item work → plan review → goal decision → compaction → resumed action. Judge correct continuation, not only whether a source string appeared in the payload.

Include costs of extractions, refresh, retrieval, and repeated work. Masking old recoverable tool bodies may be a cheaper first intervention than summarizing every event.[^R5]

## 6. Draft plan for review

Canonical plan:

```text
plan://papercusp/postgresql-evidence-traversal-2026-09-14
```

Status was read back as **draft**. Seven items and their dependency chain were verified. It has not been activated or promoted into execution.

### Summary

**Goal:** answer a few real cross-record questions through one bounded evidence-bearing read using the PostgreSQL relationships and interfaces already present.

1. Select and freeze representative questions, answers, and the current lookup-cost baseline.
2. Map existing domain relationships and define the smallest read-interface extension and budgets.
3. Implement bounded joins/recursion where the query actually requires them.
4. Use existing hybrid search only when the starting record is unknown.
5. Return source revisions, evidence state, missing links, and raw-source recovery.
6. Verify correctness, scope isolation, stale/deleted sources, cycles, caps, recovery, and value against the baseline.
7. Demonstrate on current-build/staging and report remaining limitations before considering another backend.

**Explicit exclusions:** no graph database, AGE installation, universal edge store, unrestricted SQL tool, new authority system, or automatic execution based on historical claims.

**Important refinement:** this plan must reuse `containment-tree.ts`, `prior-attempt-context.ts`, existing typed-link readers, and evidence bindings where they fit. It must not rebuild the system reviewed above.

The plan's activation requires review approval and the chosen execution route. The required source-conversation activation audit must occur before activation; no such audit or implementation is claimed here.

## Evidence references

[^D1]: Canonical plan `effort-scoped-continuity-2026-09-02`, D-007, read in full through `plans:get` on September 14, 2026. Includes the preserved owner description and the leader/member distinction.
[^D2]: Same plan, D-008, read in full. Fixed-budget descendant compression and explicit fan-out disclosure.
[^D3]: Same plan, D-010, read in full. Corrects the claim that compression rungs are guaranteed structured data; defines write-time feedback and conditional extraction.

[^S1]: [Scoped durable lesson writing](../../packages/operator-core/lib/effort-thread.ts#L174).
[^S2]: [Checkpoint learned-text integration](../../packages/operator-core/lib/agent-tools/work_items/checkpoint.ts#L2590).
[^S3]: [Checkpoint journal enabled](../../packages/operator-core/lib/work-item-checkpoint.ts#L288) and [bounded journal writer](../../packages/operator-core/lib/carry-note.ts#L2384).
[^S4]: [History compiler and depth ladder](../../packages/operator-core/lib/prior-attempt-context.ts#L348), including the size function and plan/goal helper budgets later in the same file; [field extractor](../../packages/operator-core/lib/prior-attempt-rungs.ts#L1).
[^S5]: [Containment resolution contract](../../packages/operator-core/lib/containment-tree.ts#L1).
[^S6]: [Plan read delivery](../../packages/operator-core/lib/agent-tools/plans/get.ts#L1212), [plan launch bundle](../../packages/operator-core/lib/agent-tools/plans/context-bundle.ts#L1), and [leader consumer](../../packages/operator-core/lib/agent-tools/fleet/leader-brief.ts#L4587).
[^S7]: [Goal read consumer](../../packages/agent-mcp/src/tools/goals/get.ts#L168), [goal start history](../../packages/operator-core/lib/agent-tools/goals/start.ts#L820), and [automatic goal-holder history](../../packages/operator-core/lib/goals/goal-auto-start.ts#L322).
[^S8]: [Real-PostgreSQL history consumer suite](../../packages/operator-core/lib/agent-tools/plans/plan-history-consumers.integration.test.ts#L1), [compiler tests](../../packages/operator-core/lib/prior-attempt-context.test.ts), [rollup tests](../../packages/operator-core/lib/prior-attempt-context.rollup.test.ts), and [plan read cache tests](../../packages/operator-core/lib/agent-tools/plans/get.cache.test.ts).

[^R1]: Qizheng Zhang et al., *Agentic Context Engineering*, October 6, 2025. `https://arxiv.org/abs/2510.04618`
[^R2]: Hindsight, *Document evolution benchmark*, inspected revision. `https://raw.githubusercontent.com/vectorize-io/hindsight/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-dev/benchmarks/document_evolution/README.md`
[^R3]: *VikingRAG*, September 10, 2026. `https://arxiv.org/abs/2609.11390`
[^R4]: Hindsight, *Consolidator*, inspected revision. `https://raw.githubusercontent.com/vectorize-io/hindsight/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-api-slim/hindsight_api/engine/consolidation/consolidator.py`
[^R5]: Tobias Lindenbauer et al., *The Complexity Trap*, original research. `https://arxiv.org/html/2508.21433`
