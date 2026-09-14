# Revised GitNexus and alternatives assessment

Assessment date: September 13, 2026, America/New_York.
Fresh probes and upstream reads: September 14, 2026, approximately 01:24–01:30 UTC.
Work item: WI-10001260. Author: su-8ee55568-a37b-4b6b-84f3-e02e11c10d86.

## Decision

**Keep GitNexus as Papercusp's graph/topology engine, alongside the existing
official-language-server adapter and exact-text search. Harden and selectively
use this stack; do not replace it or expand dependence on it indiscriminately.**

GitNexus has demonstrated useful relationships on actual Papercusp investigations.
No alternative has demonstrated a better complete task outcome on this workspace.
The observed failures justify reliability work and a bounded comparison, not a
confident migration recommendation. Existing integration is a practical advantage,
not a reason to retain the engine if a challenger subsequently wins.

Retain **Codebase-Memory as the first contingency comparator**, consistent with
the earlier assessment. Treat **colbymchenry/codegraph as an additional candidate,
not the newly established winner or automatic first replacement**. Neither has
been run against Papercusp in this assessment. Serena remains rejected under the
existing owner decision. [E1, E2, E3, U1–U5]

This completes the requested revised decision assessment using available evidence.
It does **not** complete the retrieval fix, a controlled alternative-engine
benchmark, or the retrieval plan's post-fix remeasurement. Avi's latest request
brings this assessment forward; it does not make those unfinished steps pass.
Licensing is excluded as requested.

## 1. The prior decisions, reconciled

The governing plan is
`code-intelligence-routing-lsp-gitnexus-2026-08-20`.

| Record | Governing choice | Consequence here |
| --- | --- | --- |
| D-001, August 21 | GitNexus for graph topology; official LSP for compiler-resolved symbols; text search for literals; ast-grep for syntax; packers after retrieval | These are complementary tools, not interchangeable competitors. |
| D-002, August 21 | Avi explicitly dropped Serena in favor of pinned official servers behind a thin Papercusp adapter | Do not reintroduce Serena as though this decision never happened. |
| D-048 | Records the implemented backends and rejected alternatives, including a subsequent re-rejection of Serena | Extend the existing adapter rather than adding another general-purpose agent bridge. |
| D-058, August 23 | The curated graph plane is `graph:query`, separate from the raw `gitnexus.query` plugin | Keep a replaceable backend behind the existing Papercusp interface; do not create another tool family. |

The earlier August 20 comparison recommended GitNexus because of its
architecture-oriented relationships and existing Papercusp integration; it kept
Codebase-Memory as a contingency. It did not establish an empirical victory
over the alternatives. Source: Codex session
`01a01fbc-6171-7d02-b205-8a3faeb65a8f`, turn 6.
The Serena decision is separately recorded in D-002, not inferred from that
earlier recommendation. [E1, E2]

**Corrections to my subsequent advice:**

- Suggesting Serena again was wrong and remains withdrawn.
- Promoting the separate CodeGraph project to first replacement candidate was
  not supported by a Papercusp head-to-head comparison; I withdraw that ranking.
- CodeGraph, CodeGraphContext, and Codebase-Memory are three distinct projects.
- Old claims that no guidance overrides or batched graph entry point exist are
  not a sound basis for new architecture work. `TOOL_OVERRIDES` exists, the bridge
  consumes it, and this assessment successfully called `tools.graph.query` inside
  `code:run`. Some override text still points toward the deliberately refused raw
  query. The remaining problem is guidance correctness, not a missing override
  mechanism. [E4]
- The old claim that GitNexus incremental indexing is only a roadmap feature is
  no longer valid. Current upstream documentation describes watch-mode incremental
  refresh. Our installed pin and our forced-full-rebuild policy must be assessed
  separately from those upstream capabilities. [E4, U1]

## 2. What the empirical audit established

The completed September 12 report, WI-10001115, examined a purposive sample of
nine other agents' command sequences, including paired tool-call/result evidence
for three investigations. It was not a random fleet sample. [E3]

Supported uses:

1. **Navigate between connected functions.** A scheduler investigation repeatedly
   searched for declarations and read overlapping file ranges. GitNexus identified
   connected helpers and the `getNextForBee -> getNextWorkItem` edge.
2. **Retrieve context for an already identified helper.** The evidence-fingerprint
   investigation supported a bounded function-context lookup and the chain
   `listSpecEvidence -> measureRepoFilesEvidenceAtRoot -> fingerprintRepoFileSet`.
3. **Find affected consumers.** GitNexus surfaced design acceptance as another
   consumer of the shared measurement helper, which was corroborated in source.

The audit did not prove shorter completed tasks, reduced token expenditure,
better final patches, or fewer defects. It did not prove that the original agent
missed a consumer elsewhere in its session. Missing symbols, ambiguous symbols,
stale data, route-lookup failure, and a graph crash were explicit negative evidence.
Those limits survive this reassessment. [E3]

## 3. Fresh checks in this assessment

These are bounded live checks, not a controlled speed benchmark. GitNexus ran via
the connected operator; LSP was explicitly rooted at the canonical staging tree.
The vendor package readback was GitNexus **1.6.9**. Staging HEAD sampled during the
checks was `1656f7bb7fee6b11c46f418ab5132da9352c52e2`; this shared tree can advance.

| Check | Observed result | What it establishes |
| --- | --- | --- |
| `graph:query callers(measureRepoFilesEvidenceAtRoot)` | Returned `measureDesignAcceptance`, `measureRepoFilesEvidence`, and `listSpecEvidence`, plus a separately labeled file-level test edge | Useful cross-file consumer discovery still works. A file edge is not an additional resolved caller. |
| `lsp:query references` at `spec-evidence-store.ts:98`, column 25 | Returned the declaration and two uses in that file, but not the design-acceptance consumer; health was `degraded`, error was null | The present LSP answer is not an adequate exhaustive substitute for this graph lookup. It does not establish that language servers inherently cannot find that consumer. |
| Current-source corroboration | `design-compare/acceptance.ts:122` calls the helper; an exact text search finds it | The cross-file consumer is real. Text search remains a useful independent check, although matching text alone does not resolve symbol identity. |
| `graph:query symbol(claimNextIssueWorkItem)` | Empty sites, with an explicit stale-index warning | An empty graph answer cannot establish absence in the repository. |
| Same-index-revision control | `git show 29d3423...:packages/operator-core/lib/work-items.ts` contains that declaration at line 7918 | The missing symbol existed in the exact indexed revision; “it was added afterward” cannot explain this particular miss. The indexing/resolution cause remains uninvestigated here. |
| `graph:query callees(getNextForBee)`, limit 20 | Returned `getNextWorkItem` among connected helpers; the current source contains that call | The scheduler-navigation positive control still works. |
| Batched access | Both scheduler probes also ran through `code:run` using `tools.graph.query` | The curated graph plane is reachable from the supported batched tool interface. |

The graph responses identified index revision
`29d342360971f0297b0b9f36816a878a935e78b7`, indexed at
`2026-09-13T10:49:40.083Z`, and marked it stale/degraded.
This is a newer index than the September 12 audit used; do not copy the old
revision into a current-status claim. Selected edges were checked against source;
the rest of the graph was not certified.

The freshness writer in `gitnexus-facade.ts:476–495` derives its reported
staleness from `list_repos`' indexed revision and commits-behind metadata.
That is not a completeness test of the symbol index. Even a healthy/fresh label
would not by itself prove that an absent symbol is absent from source. [E4]

No crash was reproduced in these fresh checks. That is not a retraction of the
historical SIGSEGV or proof that its underlying failure mode is fixed.

## 4. Alternatives: relevant, but not demonstrated replacements

The following capability descriptions are **upstream documentation claims**,
checked against commit-pinned primary READMEs. They are not Papercusp benchmark
results. No alternative was installed, no autonomous hooks were enabled, and no
second live index was created. [U1–U5]

| Candidate | Why it is relevant | Recommendation and qualification |
| --- | --- | --- |
| Existing LSP + `rg` | Already-integrated compiler navigation and current-text evidence | Keep as essential companions and the no-graph baseline. The measured degraded LSP response prevents declaring this combination an already-proven graph replacement. |
| GitNexus, including a tested upstream upgrade | Upstream documents graph context/impact and serialized watch-mode incremental refresh | Test whether an upstream pin resolves our actual missing-symbol and refresh/recovery failures before replacing the engine. Do not assume installing a newer version resolves them. [U1] |
| Codebase-Memory (`DeusData/codebase-memory-mcp`) | Documents persistent code relationships, impact/trace, background updates, SQLite storage, and semantic-resolution enhancements | First contingency comparator, not a migration decision. Its current MCP mode includes a per-account coordination daemon and automatic integrations; an isolated CLI mode is documented. Evaluate the graph engine without duplicating Papercusp's coordination and hooks. [U2] |
| CodeGraph (`colbymchenry/codegraph`) | Documents source-plus-path retrieval, a Rust parsing kernel, SQLite storage, and file-change auto-sync | A credible additional challenger for relevance, freshness and operational cost. Project-published savings and absolute freshness claims are not our evidence. My earlier preferred-replacement ranking was premature. [U3] |
| CodeGraphContext | Documents caller/callee relationships, file watching, optional SCIP ingestion, and several graph-store backends | Consider if compiler-index ingestion or backend flexibility becomes a concrete requirement. I do not recommend adding that configurable stack merely to repeat today's supported graph queries. [U4] |
| Sourcegraph / SCIP | The TypeScript indexer documents project/workspace indexing and index upload workflows | Revisit for a compiler-indexed, multi-repository requirement. It is not a demonstrated drop-in solution for this local agent-navigation task. [U5] |
| Serena | Overlaps the existing language-server adapter rather than directly replacing the graph plane | Remains out of the shortlist under D-002/D-048. No new evidence here overturns that ruling. [E1] |

One material qualification for Codebase-Memory: its current README's “Hybrid LSP”
section describes implemented semantic/type-resolution algorithms inspired by
language servers. Do not equate that label with running Papercusp's official
TypeScript compiler server or assume identical reference precision. [U2]

Likewise, GitNexus's upstream incremental feature is not proof that Papercusp can
safely turn off `--force`. Our routine currently passes `--force --embeddings 0`.
The runbook ties this policy to previously measured incremental-write failures.
Changing it needs a reproduction of that failure and a passing replacement path,
not a README feature comparison. [E4, U1]

## 5. How I recommend using it in Papercusp

### Agent workflow: target the actual navigation question

Offer bounded graph assistance when an agent has a known symbol and asks:

- What calls this, and what does it call?
- What other consumers need checking before this shared helper changes?
- How does the entry point reach the persistence or verification function?

Prefer `graph:query` where its operation set fits. Use the existing plugin's
context/trace operations for uncovered read-only intents, with current-source
corroboration. Correct existing guidance rather than adding a second interface.
If repeated demand warrants a curated context/trace operation, extend the existing
plane rather than inventing a parallel graph system. This is proposed work, not
something installed by this assessment.

Do not make every grep, file read, test, or tool call trigger a graph request.
Literal/configuration searches, runtime diagnosis and transcript recovery answer
different questions. Supply graph context at relevant decision points, not on
every turn, and preserve freshness, ambiguity, coverage and failure information.

### BARs and rubrics: graph findings are evidence, not the outcome

Use the existing acceptance mechanism. The required outcome is that the change
preserves required behavior of affected consumers. The method may combine graph
edges, compiler references, source inspection and tests. Attach:

- the source and index revisions, relevant consumers and corroborating locations;
- which consumers/behaviors were checked and which remain unverified;
- tests or other evidence for those behaviors;
- unresolved dynamic/framework boundaries and the fallback used.

Neither a GitNexus invocation nor a zero-caller answer satisfies that outcome.
Keep mandatory unknown/failed outcomes blocking; do not manufacture a pass from
an unavailable graph. [E3, E5]

### Main greening: additive information only at first

Use corroborated graph dependencies to suggest **additional relevant tests**
through the existing selection mechanism. Do not remove baseline tests or make
unrelated promotions depend on the shared live GitNexus process. An unavailable
graph is not evidence of safety; ordinary required checks still apply.

Any eventual test-pruning optimization needs separate evidence that it preserves
the required coverage. This assessment does not authorize that change. [E3, E5]

## 6. What would justify keeping, upgrading, or replacing the engine

Use a bounded comparison, not another generic capabilities survey:

1. Freeze task inputs and expected evidence from the recorded scheduler,
   fingerprint, consumer and route cases. Add ambiguous/re-exported symbols,
   an uncommitted edit/delete, and a failed or concurrent refresh.
2. Compare existing LSP/text search, the installed GitNexus pin, a candidate
   upstream GitNexus pin, and Codebase-Memory. Add CodeGraph only if it addresses
   an unresolved gap rather than creating an open-ended tournament.
3. Require the known edges and truthful handling of missing, stale, ambiguous and
   failed results. Evaluate actual agents reaching correct conclusions, not
   tool-call counts or README benchmark numbers.
4. Measure relevant source consumed, task wall time, tokens, missed consumers,
   test coverage, warm/cold operation, update lag, recovery and total indexing
   resource cost. Use the same source snapshot and tasks, counterbalance order,
   and distinguish cold indexing from query cost.
5. Retain GitNexus if it meets the required correctness/reliability bar and a
   challenger adds no demonstrated net benefit. Upgrade if the candidate pin
   passes our failure fixtures. Replace only if a challenger meets those same
   bars and shows a material total-work advantage that warrants migration.

No numeric winner, speedup, savings percentage or completion ETA is justified by
the evidence collected so far. These are the decision-changing measurements still
needed, not a condition for giving the present recommendation.

## 7. Evidence and reproducibility

### Internal sources

- **E1:** live `plans:get` reads of D-001, D-002, D-048 and D-058 from
  `code-intelligence-routing-lsp-gitnexus-2026-08-20`.
- **E2:** original comparison, Codex session
  `01a01fbc-6171-7d02-b205-8a3faeb65a8f`, turn 6; prior recovery outputs in
  Codex session `01a09697-7bd2-78f1-9e1b-f8592b50a23c`, September 13,
  22:33–22:35 UTC. Later recommendations and their corrections are in that
  latter session, turns 34–39. `sessions:read` failed with `invalid escape
  string`; session search and the existing local transcript supplied recovery.
- **E3:** `docs/evidence/gitnexus-agent-log-audit-2026-09-12.md`, WI-10001115
  (live readback state `done`). Contains the sampling frame, exact historical
  native command references, paired results, replays and negative controls.
- **E4:** current source:
  `packages/operator-core/lib/agent-tools/gitnexus/query.ts`;
  `packages/operator-core/lib/code-intelligence/gitnexus-facade.ts`;
  `packages/operator-core/lib/agent-tools/lsp/query.ts`;
  `packages/operator-core/lib/code-intelligence/lsp-adapter.ts`;
  `libs/papercusp/plugins/gitnexus-bridge/index.ts:442–540,964`;
  `packages/operator-core/lib/harness/routines/gitnexus-reindex-action.ts:619–633`;
  `apps/operator-docs/src/content/docs/agent-insights/code-intelligence-backends-runbook.mdx`.
  The last file is a read-only projection of the canonical runbook.
- **E5:** earlier acceptance-system conversation, Codex session
  `01a06d69-ad68-7182-818f-1185f1b681f6`, turns 9–10, as recovered and cited
  in the prior audit discussion. Integration recommendations above are proposals,
  not claims that they were all previously ratified or implemented.
- **E6:** live calls and source controls listed in section 3, this assessment
  session. LSP reference query is at one-indexed line 98 and zero-indexed column
  25 of `packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts`,
  root `$WORKSPACE_ROOT`, limit 20.
- **E7:** `docs/evidence/retrieval-deadline-audit-2026-09-13.md` and
  `retrieval-soft-budget-hard-deadline-2026-09-13`: retrieval repair remains
  separate, unfinished work. Its missing decision retrieval does not excuse
  failing to follow an already supplied historical pointer.

### Primary upstream sources

Read-only HTTP fetches returned 200. GitHub commit lookups were followed by
fetching each README at its immutable commit; the hashes matched the initial
README reads. Web search returned no usable output, so direct primary-source
fetches, not search snippets, support the upstream comparisons.

| Ref | Repository and README commit | README SHA-256 |
| --- | --- | --- |
| U1 | `abhigyanpatwari/GitNexus` at `c4ecf398de637cf779ab2238e69958cfd5d601ce` | `a99bbe9372afa941b5466a1bbd883828bb0d04595028947f073688e60975d5ae` |
| U2 | `DeusData/codebase-memory-mcp` at `339b3f4097aa6ede22fc382ab7fd320d93c498b8` | `17eed3516a3170db5c4b3d6b446084fb1e4d20e5e35c198880643fc646dba7e4` |
| U3 | `colbymchenry/codegraph` at `3ed73bc127323e63153bf6ec8354afa82ce36aaf` | `9f97774722a9ef989f6e218c36311893ca90f903b8127ecce8f29f93d7b58460` |
| U4 | `CodeGraphContext/CodeGraphContext` at `2ef71b05a2ad1c5fd644c3ba52d77b502adaf1cf` | `2f74d4696f4f5bea6fb07697640fdd41e2e205959eac6d7d279cb9e509713de0` |
| U5 | `sourcegraph/scip-typescript` at `e22988d9a80a5cfaa5ad3afbfbc99bab511fd24a` | `979996597051d89c92c7ceae8a7447d3d45fa0486a2b28dd0da84da89ead56d8` |

Resolve a source with
`https://raw.githubusercontent.com/<repository>/<commit>/README.md`.
Upstream feature claims remain documentary evidence, not local execution proof.

## Bottom line

**Use the graph where the audit proved it useful; keep compiler and source checks;
fix the observed reliability and guidance gaps; test an upgrade before committing
to replacement. Codebase-Memory is the contingency to test, not a second permanent
stack. Build Papercusp's integration and verification method, not a new analysis
engine.**
