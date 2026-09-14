# Compaction, memory consolidation, and graph-free retrieval

## Executive assessment

The highest-value direction for Papercusp is not another memory database. It is a better-controlled lifecycle for evidence: capture it at the correct scope, preserve the source, retrieve what the current task needs, and compress only the material that need not remain verbatim.

Three recommendations follow:

1. **Compaction:** compare the existing rolling-summary approach with inexpensive masking of old tool bodies and source-linked observational memory. Keep commitments, authority, and verification references outside lossy summaries.
2. **Consolidation:** extend the existing scoped history and hygiene machinery with reviewable, evidence-backed updates. Do not let repeated summaries turn conjecture into established fact.
3. **Retrieval:** prioritize source-aware chunks, parent/section expansion, exact identifiers, candidate coverage, and reranking before adopting more elaborate retrieval models.

Mastra is the most useful implementation reference for observational memory. Hindsight is the strongest reference for evidence-backed consolidation and refreshed synthesized knowledge. LangMem provides smaller composable utilities. SimpleMem, ACE, and sleep-time compute offer research ideas worth controlled experiments. None has been demonstrated to outperform Papercusp on its own tasks.[^1][^2][^8][^9][^12][^13][^14][^15]

This report reflects primary sources checked September 14, 2026 and targeted source inspection. It distinguishes documented behavior, research results, and proposed design. No package was installed, private data uploaded, or production behavior changed.

## 1. Separate the problems

| Mechanism | Main purpose | What it does not establish |
|---|---|---|
| Observation masking | Remove bulky old tool output from active context | That the omitted evidence is no longer needed |
| Compaction | Summarize older context so a task can continue | That a summary preserves every fact or permission |
| Observational memory | Maintain a compact event/observation log across a growing interaction | That observations are verified durable knowledge |
| Consolidation | Deduplicate, reconcile, and organize persistent knowledge | That similar statements mean the same thing |
| Retrieval | Select relevant stored evidence for the current question | That selected evidence is complete or current |
| Prompt caching | Reuse model computation for matching prefixes | That cached context is accurate or useful |

The recommended boundary is strict: **the active prompt is a view of evidence and state, not the authoritative database.** A summary may explain a decision; it must not silently become the decision record.

Also distinguish two uses of “observation.” Mastra uses observations to compress interaction history. Hindsight uses observations for consolidated knowledge supported by source memories. These occupy different places in an architecture, even though the terminology overlaps.[^1][^8]

## 2. Observational memory and compaction

### 2.1 Start with observation masking as the control

Observation masking replaces older environment/tool responses with small placeholders while keeping enough interaction structure to continue. The original tool output can remain in the transcript or an external store.

The original *Complexity Trap* study compared masking and LLM summarization in SWE-agent on SWE-bench Verified across several model configurations. It found masking competitive with summarization on solve rate and substantially cheaper than retaining raw history. Its later revision also considered a hybrid. This is useful evidence for a baseline, not proof about every model, task, or current Papercusp agent.[^3]

For Papercusp, a proposed masked entry should retain:

- Which tool or operation ran.
- Whether it succeeded, failed, or had an uncertain outcome.
- The relevant object and source revision.
- An exact recovery reference for omitted content.
- Any unresolved condition that makes the result still important.

A placeholder must never erase the distinction between a proposed action and an action that actually occurred. Nor should masking delete the stored transcript.

**Best fit:** repetitive file reads, large search results, repeated snapshots, and logs that remain recoverable.

**Poor fit:** the only available error diagnosis, an unrecorded user correction, exact code needed by the next step, or a pending tool invocation whose result has not arrived.

The experiment should keep a recent exact tail, protect unresolved evidence, and compare a source-linked mask with the current baseline. A generic “keep the last N messages” policy can split tool-call/result pairs or discard the one old fact needed to finish.

### 2.2 What Mastra actually provides

Mastra's current observational-memory design has two jobs:

**Observer:** converts accumulated messages into a compact log. New observations append between reflection cycles.

**Reflector:** compresses the observation log when it grows, including material that earlier reflection passes already summarized. This bounds active memory but introduces repeated-summary drift as an evaluation concern.[^1]

The system can buffer observations asynchronously before activation. Buffered material becomes active when thresholds are reached, and the covered raw messages leave the active window. The docs distinguish these thresholds from hard caps and describe synchronous fallback when background work cannot keep up.[^1][^2]

The most consequential integration detail is **recovery of originals**. Current documentation makes retrieval mode opt-in. It stores source-message ranges and exposes a recall tool. Browsing originals does not require a vector store; semantic search can be added separately. When retrieval is enabled, its default scope is broader than one thread, so a shared application must configure scope deliberately.[^2]

This suggests an attractive pattern for Papercusp:

```text
Persisted raw events
        |
  source-linked observations + exact recent tail
        |
  bounded reflection over an identified source range
        |
  compact context, with original evidence still addressable
```

It does not require adopting Mastra as the entire agent runtime.

### 2.3 The hard engineering is in activation

The important question is not merely whether a model can write a good summary. It is whether the summary is activated safely.

Proposed invariants:

1. Identify exactly which source events the summary covers.
2. Do not advance the covered-event marker when generation fails or returns unusable content.
3. Commit the summary and its coverage marker consistently.
4. Preserve events arriving after the summarized snapshot.
5. Reject or reconcile a stale writer instead of overwriting a newer summary.
6. Keep source recovery scoped and version-aware.
7. Expose delayed or failed background work rather than silently implying complete coverage.

These are design requirements, not assertions that any one library satisfies every application-specific case. Mastra's current reference exposes lifecycle and transformation hooks, but explicitly warns that after-hooks do not roll back earlier extractor side effects and are not a redaction boundary for every piece of cycle data.[^2]

For sensitive content, filter the authorized input before it reaches the observer model; do not assume a post-summary text hook also cleaned structured extraction results.

### 2.4 LangMem and provider compaction

LangMem's summarization utilities maintain a running summary and track summarized message identities. Its implementation also handles the boundary between tool calls and tool responses. This is a smaller component to study when a full memory framework is unnecessary.[^4]

Current OpenAI API compaction can operate server-side or through a standalone compaction operation. The compacted item is opaque and encrypted. It is useful continuation state, but it should not be the only auditable or cross-provider record of work.[^5]

Anthropic's current API documents beta server-side compaction that produces a summary block, optional custom summarization instructions, and a pause after compaction. Its separate context-editing feature can clear old tool results. These are distinct mechanisms, not interchangeable settings.[^6][^7]

The integration boundary matters for Papercusp:

- **Application-owned model requests:** the application can choose messages, apply masking, retain source references, and use supported API compaction.
- **Hosted CLI agents:** Papercusp cannot assume it can arbitrarily rewrite the CLI's active message window. Use the supported host/carry interfaces. An external observer can supply better future context without necessarily controlling the current window.

An API feature's existence is not evidence that a CLI session exposes the same control.

### 2.5 Compression and caching can pull in different directions

A shorter prompt is not always cheaper if obtaining it requires extra model calls and repeatedly changes a previously cacheable prefix. OpenAI's current caching documentation describes reuse of matching rendered prefixes, including the effect of changes to tools and earlier content.[^16]

Measure:

```text
total task cost =
  foreground model work
  + observer and reflector work
  + embeddings and retrieval
  + reranking and background refresh
  + repeated work caused by lost context
```

Do not report only the foreground answer's tokens. Count the extra calls and their latency, including synchronous fallback. Re-evaluate the tradeoff when providers, accounts, models, or prompt layout change.

### 2.6 Recommendation for Papercusp

Use four experimental arms, not an immediate migration:

| Arm | Purpose |
|---|---|
| Existing rolling summary and continuity records | Actual baseline |
| Source-linked masking plus protected current task state | Cheapest alternative |
| Source-linked observations with asynchronous preparation | Test whether richer carry improves task continuation |
| Masking plus selective observation/reflection | Test a hybrid without summarizing every output |

Protect exact user choices, required follow-ups, source IDs, unresolved failures, and permission boundaries in existing structured state. Allow the model to summarize descriptive history.

Do not optimize for maximum compression. Optimize for correct continuation at a lower total cost.

## 3. Memory organization and consolidation

### 3.1 Use different representations for different jobs

The proposed organization is a set of roles for existing stores, not five new databases:

| Knowledge type | Example | Preferred treatment |
|---|---|---|
| Episodic evidence | A test run, observed error, or recorded conversation | Preserve source identity, time, scope, and outcome |
| Semantic fact | A documented constraint or durable preference | Track support, validity, corrections, and provenance |
| Procedural knowledge | A verified troubleshooting procedure | Keep in maintained, source-anchored documentation |
| Task state | Current work, blockers, next action, approval | Read authoritative records rather than infer from memory |
| Derived overview | A plan digest or a subsystem summary | Treat as a scoped, revisioned projection with drill-down |

For Papercusp, procedural knowledge should continue to use the maintained documentation layer rather than become an unreviewed vector-memory paragraph. The existing history and source-reference architecture already supplies much of the underlying structure.[^I1][^I2]

### 3.2 Hindsight's useful contribution

Hindsight distinguishes retained facts and experiences from observations and synthesized mental models. Its observation documentation describes source-backed updates, contradiction handling, and scoped consolidation; mental models provide an answer-like overview that can be refreshed ahead of requests.[^8][^9]

The implementation details are more useful than the biological analogy:

- The consolidator checks which source memories still exist before writing an observation.
- Its PostgreSQL path uses row locking to avoid a concurrent source deletion racing the derived write.
- An update can compare the previously read text before applying an LLM-produced change.
- Refresh selection is scoped to relevant source changes.[^10]

These patterns can be implemented over existing PostgreSQL records. A graph database is not required for a source-to-summary dependency.

**A metric caveat:** `proof_count` is written from the count of distinct supporting memory IDs. That measures linked records, not statistical independence, trustworthiness, or successful real-world verification. Several memories may repeat one mistaken source.[^10]

### 3.3 Consolidation should be evidence-preserving

A proposed consolidation workflow:

1. Select new or changed source material within one authorized scope.
2. Detect duplicates and possible conflicts.
3. Generate proposed additions or updates, each with source support.
4. Check exact identifiers, chronology, negation, and scope.
5. Apply accepted changes with version checks.
6. Mark affected summaries stale and refresh only those that are useful.
7. Preserve the original evidence and the reason for correction.

The result should distinguish “this is supported,” “this is inferred,” and “this conflicts with another source.” Repetition alone must not raise a claim to verified status.

Near-duplicate merging is especially risky for code and operations. Case, punctuation, units, dates, negation, and environment qualifiers can change meaning. A similarity score is a candidate-selection device, not proof of equivalence.

Likewise, “stopped surfacing” and “deleted” are different guarantees. A deletion policy must address derived summaries, indexes, source links, and authorized history retention—not only the visible memory row.

### 3.4 Append evidence; update the projection

A useful separation is:

- **Evidence/history:** append the new event or correction.
- **Current fact/state:** update through its existing authority.
- **Derived overview:** rebuild or patch from the relevant current evidence.

This avoids rewriting history every time the system changes its mind. It also limits how much a consolidation error can corrupt.

For a long-running plan, an incremental patch to a derived overview can preserve untouched sections. However, patching must be source-aware: a correction can invalidate a conclusion in a different section. Pure textual minimalism does not guarantee semantic consistency.

Hindsight's document-evolution benchmark is useful here. It evaluates repeated updates, lost content or structure, and lingering superseded claims. It is a vendor-maintained test design to borrow, not an independent ranking of memory products.[^11]

### 3.5 Letta, SimpleMem, ACE, and sleep-time compute

**Letta:** current documentation emphasizes MemFS, a Git-backed memory repository projected into an agent's environment. Selected system memory is always in context; other files are discovered and read on demand. Background dreaming can review interactions and update memory. This is broader than the older memory-block-only description.[^17]

The transferable ideas are hierarchy, explicit placement, version history, and background review. Replacing Papercusp's canonical PostgreSQL docs/history with a second Git memory authority is not recommended. “Agent reviews before applying” is also not the same as human approval.

**SimpleMem:** the January 5, 2026 paper combines compact self-contained memory units, write-time synthesis, and intent-aware retrieval. Its current repository has expanded into a unified package with multimodal and EvolveMem capabilities. Paper results must not be assumed to describe every current package configuration.[^12][^13]

Coreference resolution and conversion of relative dates into explicit time can improve retrieval. They can also introduce errors. If a source says “tomorrow” without sufficient timing information, the system must not invent a date. Treat “semantic lossless compression” as an evaluated objective, not a literal guarantee.

**ACE:** uses generation, reflection, and curation to incrementally improve an evolving playbook. The useful principle is selective adaptation rather than repeatedly replacing an entire prompt. In Papercusp, proposed procedural lessons should carry evidence and go through the existing documentation/verification workflow.[^14]

**Sleep-time compute:** moves reasoning about likely future queries off the request path. The original work found the usefulness related to query predictability and reuse. It does not make background compute free.[^15]

Use it for repeatedly consulted, slowly changing knowledge. Avoid repeatedly refreshing a broad overview that no agent reads.

### 3.6 Recommendation for Papercusp

Keep the existing scoped records and history compiler. Add or improve the following only where the present contract is insufficient:

- Source-supported, reviewable consolidation deltas.
- Revision-aware invalidation of derived overviews.
- Explicit status for incomplete or delayed consolidation.
- Scope-sensitive deduplication and conflict handling.
- Selective semantic extraction for important facts the current deterministic extraction misses.
- Evidence of downstream usefulness before promoting a recurring observation into procedural guidance.

Do not add mandatory fields to every checkpoint merely because a model could extract them. First measure what the existing write-time feedback captures, and use any additional model pass selectively.

## 4. Better retrieval without a knowledge graph

### 4.1 Find the stage that actually loses the answer

Retrieval failures have different causes:

```text
Source captured
    → source eligible and current
    → correct index representation
    → source enters candidate pool
    → reranker preserves it
    → context assembler includes needed evidence
    → answer uses it correctly
```

A reranker cannot fix an unindexed source. A larger context window cannot fix a candidate omitted before prompt assembly. A better embedding cannot correct an invalid scope filter.

The evaluation should label failures by stage before selecting a technique.

### 4.2 Source-aware chunks and parent expansion

A chunk may contain the answer while omitting what the answer refers to. Start by carrying deterministic context:

- Document title and section path.
- Source record type and stable ID.
- Revision and time.
- Speaker or actor where relevant.
- Resolved references that the application already knows.

Retrieve a compact chunk first, then expand its parent section or adjacent source range when needed. This can improve coherence without a global graph and without making every candidate a large document.

Papercusp already has write-time reference expansion and long-turn chunk indexing. The appropriate experiment extends those mechanisms rather than introducing another ingestion pipeline.[^I3]

### 4.3 Contextual retrieval

Anthropic's contextual-retrieval approach adds chunk-specific explanatory text before embedding and lexical indexing. It then optionally reranks a larger initial candidate set. Its published results concern retrieval failures on its evaluated datasets and settings, not Papercusp task completion.[^18]

A sensible deployment order is:

1. Deterministic titles, section paths, and known-reference context.
2. Model-generated context only for chunks that remain ambiguous.
3. Validation that generated context does not add unsupported facts.
4. Separate storage of the original text and its index augmentation.

When a document changes, invalidate both the chunk and the added context derived from it. A fluent but stale contextual prefix can make the wrong chunk easier to retrieve.

### 4.4 Late chunking is different from contextual retrieval

Late chunking first computes contextual token representations across a larger document window, then pools them into chunk embeddings. The chunk boundaries are applied after the transformer step rather than before it.[^19]

That can preserve relationships between a pronoun and an earlier name without generating a new contextual paragraph. It requires a suitable embedding pipeline with access to the necessary token representations; an API that returns only one pooled vector for a whole input does not automatically supply late chunking.

**Papercusp fit:** a targeted experiment on long technical documents or transcripts with cross-chunk references. Check model/window limits and re-indexing costs. Do not migrate the full embedding corpus on the strength of one benchmark.

### 4.5 Lexical retrieval, true BM25, and PostgreSQL

A terminology correction matters: the inspected prose-search SQL uses PostgreSQL `ts_rank_cd`, including coverage-aware options. This is cover-density ranking, not Okapi BM25. The memory store's identifier-oriented lexical leg is a different mechanism again.[^I4]

PostgreSQL's native text-search documentation describes `ts_rank` and `ts_rank_cd`. True BM25 options include extensions such as ParadeDB and `pg_textsearch`, but their packaging and operational requirements must be evaluated.[^20][^21][^22]

For Papercusp:

- Keep exact-identifier handling even if general prose ranking changes.
- Measure short relevant records against long repetitive records.
- Test code symbols, file paths, error messages, and mixed natural-language queries.
- Preserve the current lexical/semantic separation and score provenance.
- Treat a compiled extension and any required server restart as a deployment change, not a harmless library import.

A better name for the existing algorithm is not a reason to replace it. Only measured failure classes justify that work.

### 4.6 Candidate coverage, fusion, and reranking

Hybrid retrieval should combine complementary candidate sets. Rank fusion can merge incomparable ranking scales, but its score is not a calibrated probability of relevance.

In pgvector, approximate-neighbor search with selective filtering can return fewer relevant candidates than requested. Its documentation describes iterative scans and alternative indexing arrangements. Papercusp's prose source registry already invokes an iterative-scan helper, so the next step is checking effective behavior, not recommending an implementation that already exists.[^23][^I4]

After retrieval, a cross-encoder can rerank a bounded pool. Its job is ordering candidates, not proving completeness. Evaluate the number actually scored, timeout/degraded behavior, precision at the selected cutoff, and whether repeated near-identical chunks crowd out complementary evidence.

For ambient injection, irrelevant material is especially costly because the agent did not explicitly request it. For an explicit research query, a somewhat larger candidate pool can be useful. Those paths should not blindly share the same threshold.

### 4.7 Query adaptation and hierarchical retrieval

**Query rewriting/decomposition:** useful when a question contains several independently searchable requirements. Keep the original query, exact identifiers, and scope constraints. Add variants selectively; do not turn every retrieval into a multi-call reasoning loop.

**HyDE:** generates a hypothetical answer-like document to locate similar real documents. The hypothetical document can contain false details; it is a retrieval probe, never a source of evidence.[^24]

**RAPTOR:** builds a hierarchy of clustered summaries for retrieval at different levels of abstraction. Such summaries can be represented in PostgreSQL, but they need source references and refresh rules. Repeated summarization can lose important qualifications.[^25]

**VikingRAG:** the September 10, 2026 paper studies structured retrieval, reuse of retrieval traces, and escalation when evidence remains insufficient. The transferable idea is to spend extra retrieval only when the first pass lacks evidence.[^26]

A cached successful retrieval path must be rechecked against source revisions and current permissions. A previously useful route is not permanent authorization.

### 4.8 More expensive candidates

| Technique | What changes | Why it is not first |
|---|---|---|
| SPLADE-style learned sparse retrieval | Learned term expansion and sparse weights | Adds model/index complexity; compare against exact lexical plus dense first |
| ColBERT-style late interaction | Multiple token-level vectors per passage | More storage and specialized scoring than one-vector-per-chunk retrieval |
| LLMLingua-2-style compression | A smaller model selects tokens to retain | Can remove a crucial qualifier; exact code, quotes and permissions need protection |

SPLADE, ColBERTv2, and LLMLingua-2 each provide original research evidence for their respective mechanisms. They are different interventions, not interchangeable “better RAG” switches.[^27][^28][^29]

For ColBERT, “late interaction” is not “late chunking”: one changes query-document scoring, the other changes when chunk embeddings are formed. Store requirements and deployment effort differ.

For learned prompt compression, begin with descriptive prose and keep the original available. Do not use token deletion on authoritative instructions, exact commands, or code patches without task-specific evidence that the transformation is safe.

## 5. What Papercusp already implements

The following are source findings, not a live-health certification:

| Existing mechanism | Implication |
|---|---|
| Rolling operator-conversation summary stored in PostgreSQL | Compaction is already implemented in one application-owned conversation path |
| Summary coverage marker and compare-and-swap write | Reuse its concurrency contract for an observation experiment |
| Scoped history compiler and raw references | Source-linked compression should extend this machinery |
| Result-size control and recoverable spill references | Preventing large new outputs is already separate from rewriting old history |
| Scoped memory-hygiene sweep | Consolidation should preserve its access, soft-invalidation, and conflict rules |
| Reference-enriched embedding input | Contextual retrieval has an existing extension point |
| Long-turn chunks, hybrid retrieval, reranking and iterative-scan support | Diagnose the remaining stage-specific failures before adding another stack |

The operator conversation's rolling summary folds an existing summary with newly aged turns and writes a coverage marker with compare-and-swap protection. That is not the same path as every hosted CLI's internal compaction.[^I1]

The hygiene sweep distinguishes duplicate handling from conflict judgments, scopes eligible pools, and uses soft invalidation for eligible automatic resolutions. Those safeguards should survive any new consolidator.[^I2]

The result-size limiter also distinguishes content spilled for later recovery from content omitted before serialization. This is an important precedent: a pointer must never promise recovery of bytes that were not retained.[^I5]

## 6. Evaluation that would change the decision

### Separate memory recall from correct action

LongMemEval covers several conversational-memory abilities. MemoryArena couples earlier experience to later action in interdependent tasks. Both are useful, but neither substitutes for Papercusp scenarios.[^30][^31]

Construct a held-out set containing:

- A correction that reverses an earlier plan.
- A failed attempt followed by a different successful approach.
- An approval with a narrow scope and a separate unapproved action.
- A long tool output whose important line is not near the beginning.
- A task resumed after multiple compactions.
- A plan summary derived from several work-items, including contradictory or missing evidence.
- Cross-workspace records with similar names.
- A deleted or revised source whose old summary is still present.

### Metrics

Measure source recall, context precision, exact commitment retention, stale-claim use, appropriate abstention, correct action after resumption, and raw-source recovery.

Measure total model cost, latency to resume, observer/reflector backlog, retrieval stage latency, cache reuse, and duplicate work. Include ingestion and refresh costs.

Do not call an unmeasured field zero. Do not interpret a high similarity score as confidence, or a count of copied source records as independent corroboration.

### Acceptance approach

Compare one change at a time against the current implementation at equivalent task difficulty and evidence access. Hold the answering model and budget constant where possible; separately compare realistic end-to-end configurations.

Keep a deterministic correctness suite for source identity, permissions, invalidation, and concurrency. Use blinded semantic judgments where exact matching cannot fairly score the result. Recheck judge disagreement rather than treating the grader's output as ground truth.

No production change is recommended solely because a summary is shorter or a vendor reports a larger benchmark score.

## 7. Priority recommendation

| Priority | Experiment or improvement | Existing foundation |
|---|---|---|
| First | Stage-by-stage retrieval evaluation and source recovery checks | Search and history interfaces |
| First | Source-linked masks and exact protected task state | Transcript/spill/carry records |
| First | Better deterministic chunk context and parent expansion | Reference expansion and chunk indexing |
| Next | Selective observer log with atomic activation | Rolling summary and scoped history |
| Next | Evidence-backed consolidation and targeted refresh | Threads, source references, hygiene and docs |
| Conditional | True BM25 or late chunking | Current lexical/vector interfaces |
| Later | Learned sparse retrieval, multi-vector scoring or automatic retrieval optimization | Only after a measured unresolved failure |

The key architectural conclusion is that the three areas should reinforce one another: retrieval supplies trustworthy evidence, observations preserve task continuity, and consolidation maintains durable knowledge. They should not compete to rewrite the same authoritative facts.

## 8. Verification scope

Existing focused tests for operator-conversation compaction, corpus hygiene, and reference expansion were executed: **56 tests passed across three files**. They exercise tested mechanics, not LLM-generated summary quality or production-scale performance.

The design review of the separate scoped-history system is documented in [the scoped-continuity review](./scoped-continuity-design-review-2026-09-14.md), including its own tests and source/runtime distinction.

No benchmark results from external papers were independently reproduced in this investigation.

## Sources

Sources were content-read September 14, 2026. Undated pages are current documentation snapshots. Repository pins identify the inspected code. Research findings remain specific to the evaluated settings.

[^1]: Mastra, *Observational Memory guide*, revision `254ed3f2d307baf1e50d394454947f7d6454e1c0`. `https://raw.githubusercontent.com/mastra-ai/mastra/254ed3f2d307baf1e50d394454947f7d6454e1c0/docs/src/content/en/docs/memory/observational-memory.mdx`
[^2]: Mastra, *Observational Memory reference*, same revision. `https://raw.githubusercontent.com/mastra-ai/mastra/254ed3f2d307baf1e50d394454947f7d6454e1c0/docs/src/content/en/reference/memory/observational-memory.mdx`
[^3]: Tobias Lindenbauer et al., *The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management*, first submitted August 29, 2025; full HTML revision 3 inspected. `https://arxiv.org/html/2508.21433`
[^4]: LangMem, *Summarization implementation*, revision `9d033b47d9ce53e37e92c92241b0496c0278932e`. `https://raw.githubusercontent.com/langchain-ai/langmem/9d033b47d9ce53e37e92c92241b0496c0278932e/src/langmem/short_term/summarization.py`
[^5]: OpenAI, *Compaction*, current API documentation. `https://developers.openai.com/api/docs/guides/compaction.md`
[^6]: Anthropic, *Compaction*, current beta API documentation. `https://platform.claude.com/docs/en/build-with-claude/compaction.md`
[^7]: Anthropic, *Context editing*, current documentation. `https://platform.claude.com/docs/en/build-with-claude/context-editing.md`
[^8]: Hindsight, *Observations*, revision `e3efe5dd8b070d00129c5186d111c0bc5f992363`. `https://raw.githubusercontent.com/vectorize-io/hindsight/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-docs/docs/developer/observations.mdx`
[^9]: Hindsight, *Mental models*, same revision. `https://raw.githubusercontent.com/vectorize-io/hindsight/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-docs/docs/developer/mental-models.mdx`
[^10]: Hindsight, *Consolidator implementation*, same revision; source-liveness, compare-and-swap, and `proof_count` writers inspected. `https://raw.githubusercontent.com/vectorize-io/hindsight/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-api-slim/hindsight_api/engine/consolidation/consolidator.py`
[^11]: Hindsight, *Document evolution benchmark*, same revision. `https://raw.githubusercontent.com/vectorize-io/hindsight/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-dev/benchmarks/document_evolution/README.md`
[^12]: *SimpleMem: Efficient Lifelong Memory for LLM Agents*, January 5, 2026; original paper, full HTML inspected. `https://arxiv.org/html/2601.02553`
[^13]: SimpleMem, *README* and *Text memory*, revision `db80b6a7c591e0ea730a058e9f5fc4eb06572299`. `https://raw.githubusercontent.com/aiming-lab/SimpleMem/db80b6a7c591e0ea730a058e9f5fc4eb06572299/README.md` and `https://raw.githubusercontent.com/aiming-lab/SimpleMem/db80b6a7c591e0ea730a058e9f5fc4eb06572299/docs/text-memory.md`
[^14]: Qizheng Zhang et al., *Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models*, October 6, 2025; original abstract. `https://arxiv.org/abs/2510.04618`
[^15]: *Sleep-time Compute: Beyond Inference Scaling at Test-time*, April 17, 2025; original abstract. `https://arxiv.org/abs/2504.13171`
[^16]: OpenAI, *Prompt caching*, current API documentation. `https://developers.openai.com/api/docs/guides/prompt-caching.md`
[^17]: Letta, current *Memory*, *MemFS*, and *Memory & dreaming* documentation. `https://docs.letta.com/agent-sdk/memory/index.md`, `https://docs.letta.com/concepts/memfs/index.md`, `https://docs.letta.com/configuration/memory/index.md`
[^18]: Anthropic, *Introducing Contextual Retrieval*, September 19, 2024. `https://www.anthropic.com/news/contextual-retrieval`
[^19]: *Late Chunking: Contextual Chunk Embeddings Using Long-Context Embedding Models*, September 7, 2024; original abstract. `https://arxiv.org/abs/2409.04701`
[^20]: PostgreSQL Global Development Group, *Controlling Text Search*, PostgreSQL 18 documentation. `https://www.postgresql.org/docs/18/textsearch-controls.html`
[^21]: ParadeDB, current *README*. `https://raw.githubusercontent.com/paradedb/paradedb/main/README.md`
[^22]: TigerData/Timescale, current *pg_textsearch README*. `https://raw.githubusercontent.com/timescale/pg_textsearch/main/README.md`
[^23]: pgvector, current *README*, filtering and iterative-scan sections. `https://raw.githubusercontent.com/pgvector/pgvector/master/README.md`
[^24]: *Precise Zero-Shot Dense Retrieval without Relevance Labels*, December 20, 2022; HyDE original abstract. `https://arxiv.org/abs/2212.10496`
[^25]: *RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval*, January 31, 2024; original abstract. `https://arxiv.org/abs/2401.18059`
[^26]: *VikingRAG: Accurate and Token-efficient Retrieval-augmented Generation over Structured Documents*, September 10, 2026; original abstract. `https://arxiv.org/abs/2609.11390`
[^27]: *SPLADE v2: Sparse Lexical and Expansion Model for Information Retrieval*, September 21, 2021; original abstract. `https://arxiv.org/abs/2109.10086`
[^28]: *ColBERTv2: Effective and Efficient Retrieval via Lightweight Late Interaction*, December 2, 2021; original abstract. `https://arxiv.org/abs/2112.01488`
[^29]: *LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression*, March 19, 2024; original abstract. `https://arxiv.org/abs/2403.12968`
[^30]: *LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory*, October 14, 2024; original abstract. `https://arxiv.org/abs/2410.10813`
[^31]: *MemoryArena: Benchmarking Agent Memory in Interdependent Multi-Session Agentic Tasks*, February 18, 2026; original abstract. `https://arxiv.org/abs/2602.16313`

### Internal sources

[^I1]: [Rolling conversation compaction](../../packages/operator-core/lib/operator-conversation-compaction.ts#L162), [summary compare-and-swap writer](../../packages/operator-core/lib/operator-conversations.ts#L464), and [post-turn invocation](../../packages/operator-core/lib/agent-tools/operator/converse.ts#L707).
[^I2]: [Scoped corpus hygiene](../../packages/operator-core/lib/memory/corpus-sweep.ts#L309) and [effort history compiler](../../packages/operator-core/lib/prior-attempt-context.ts#L1396).
[^I3]: [Reference expansion](../../packages/operator-core/lib/memory/ref-expand.ts#L83) and [long-turn indexing](../../packages/operator-core/lib/search/embed-backfill.ts#L675).
[^I4]: [Prose retrieval SQL](../../packages/operator-core/lib/agent-tools/search/sources.ts#L199), [hybrid memory backend](../../libs/generic/memory/src/hybrid-backend.ts#L255), and [prose reranking](../../packages/operator-core/lib/agent-tools/search/rerank.ts#L1).
[^I5]: [Result-size control and recovery](../../packages/operator-core/lib/result-door.ts#L1).
