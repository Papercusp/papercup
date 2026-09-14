# Knowledge graphs and context management for Papercusp

## Executive recommendation

Papercusp should use graph techniques selectively, but should not replace its existing memory and coordination architecture with a general-purpose graph-memory platform.

The [PostgreSQL and Mem0 follow-up](./postgresql-mem0-graph-follow-up-2026-09-14.md) sharpens this recommendation: **use the existing relational relationships and bounded SQL traversal first.** The decision → implementation → evidence example below does not require a graph database. The follow-up verifies existing typed relations, examines the installed Mem0 release and its entity-retrieval limitations, and distinguishes ordinary PostgreSQL from graph extensions and PostgreSQL-backed memory services.

Two further reports develop the recommendation: [compaction, consolidation, and graph-free retrieval](./context-compaction-consolidation-retrieval-2026-09-14.md), and [the scoped-continuity design/implementation review](./scoped-continuity-design-review-2026-09-14.md). The latter includes the summary of draft plan `postgresql-evidence-traversal-2026-09-14` and distinguishes passing current-source tests from an older connected runtime.

The best near-term direction is to retain the current PostgreSQL-backed records, hybrid retrieval, explicit validity controls, and specialized code intelligence. Add relationship-aware retrieval only where it demonstrably improves questions that span decisions, work-items, evidence, and code. Treat any graph as a rebuildable view of authoritative records, not as a second authority.

Three external systems deserve different kinds of attention:

- **Graphiti:** a candidate for a narrowly scoped temporal relationship-retrieval experiment only if the existing PostgreSQL approach leaves a demonstrated gap.
- **Hindsight:** the strongest architectural comparison for an integrated memory system that separates evidence, experience, and synthesized understanding.
- **LightRAG:** a candidate for document-heavy, cross-document research, rather than the default memory system for every agent.

For context management beyond graphs, prioritize hierarchical on-demand retrieval, source-linked compression, correction propagation, and stable prompt prefixes. OpenViking/VikingRAG, Mastra observational memory, and the ACE and Recursive Language Models papers provide useful approaches to evaluate. These are recommendations based on architectural fit, not claims that one vendor has won a Papercusp benchmark.[^1][^3][^4][^8][^12][^15][^16][^17]

The most consequential current findings include:

1. Microsoft's original GraphRAG repository now describes itself as largely in maintenance mode, without new feature development or normal new-PR intake.
2. Graphiti deprecates its Kuzu integration and directs new projects toward Neo4j or FalkorDB.
3. Mem0 Platform now documents native entity-linked graph memory without an external graph database; that does not establish parity with Papercusp's installed OSS integration.
4. OpenViking's current main project is AGPLv3, while some components have different licenses.
5. Supermemory has a local embedded-graph edition, but its local and enterprise access-control models differ materially.
6. VikingRAG, submitted September 10, 2026, is a particularly recent research development: structural retrieval, reuse of retrieval paths, and escalation only when evidence is insufficient.[^1][^5][^8][^9][^17][^18][^19]

## 1. Scope and evidence

This assessment covers agent memory, graph-assisted retrieval, graph storage, active-context management, and their fit with the Papercusp repository. Public sources were checked on September 14, 2026 UTC, corresponding to September 13 locally in New York during the investigation.

Evidence comes from current official repositories, vendor documentation, original paper abstracts, and targeted Papercusp source reads. Repository and documentation statements establish what is documented or implemented upstream; they do not establish production reliability under Papercusp's workload. Papers are research evidence, not deployment guarantees. No external framework was installed, no vendor received private project data, and no comparative benchmark was executed.

This is a broad decision-oriented survey, not an exhaustive census of every graph database, agent framework, or unpublished release. Undated documentation can change after the access date. Vendor performance claims are deliberately not converted into a cross-product league table.

## 2. Different technologies solve different problems

A useful comparison separates four layers:

| Layer | Question it answers | Examples |
|---|---|---|
| Authoritative application state | What is true or permitted right now? | Work-item records, ownership, approvals, current source revision |
| Persistent memory and knowledge | What should remain available across sessions? | Mem0, Graphiti, Hindsight, structured records |
| Retrieval | Which evidence should be fetched for this task? | Lexical/vector fusion, rerankers, graph traversal, document hierarchy |
| Active-context management | What should enter or leave the model's current window? | Compaction, structured checkpoints, observations, progressive disclosure |

The recommended separation is architectural: a memory retrieval result should not grant permission, settle a work-item, or override a current ownership record.

A graph database is storage and a query engine. A graph-memory framework additionally extracts or manages entities and relationships. GraphRAG is a retrieval approach, and Microsoft's GraphRAG is one particular implementation. None of those automatically provides safe multi-agent coordination.[^1][^5][^6][^23]

Likewise, LangGraph's execution graph should not be confused with an entity knowledge graph. Its memory documentation separately describes thread-scoped checkpoints and cross-thread memory stores. Buying an execution framework and buying a knowledge representation are different decisions.[^10]

**An HNSW vector index is not a semantic knowledge graph.** Its graph serves approximate-neighbor search; it does not, by itself, encode relationships such as “decision supersedes policy” or “test verifies implementation.” pgvector offers HNSW while retaining normal PostgreSQL data and query capabilities.[^24]

## 3. What Papercusp already has

The repository does not support a diagnosis of “missing memory infrastructure.” It contains several components that current external products would overlap.

| Capability | Source evidence | Consequence for selection |
|---|---|---|
| Hybrid persistent memory | `DEFAULT_MEMORY_BACKEND` is `hybrid-pg`; its registration combines a lexical adapter and `Mem0Backend` over the canonical store. | A generic “add vector memory” project would duplicate existing functionality. |
| Rank fusion | `hybrid-fusion.ts` implements reciprocal-rank fusion and separate admission controls. | Compare challengers against the actual hybrid baseline, not vector-only search. |
| Memory lifecycle controls | Canonical-store SQL implements invalidation, supersession pointers, and point-in-time filtering. | Temporal metadata alone does not justify introducing a new graph service. |
| Reranking | The shared ranking implementation calls the cross-encoder seam; the prose-search layer supplies integration and budgets. | Extend and measure this seam before adding another reranking service. |
| Specialized code graph | `graph:query` exposes GitNexus symbol, caller, callee, impact, and health operations with freshness/error metadata. | Keep code topology separate from probabilistic prose extraction. |
| Rationale and context assembly | The rationale projector maps decisions, work-items, and insights into topic entries; plan launch bundles include revision rationale. | Reuse these projections and stable references for cross-object retrieval. |
| Durable continuity | The documented checkpoint/fact surfaces externalize task state before compaction. | A new summary mechanism should preserve this contract, not replace it. |

These are findings about the checked source, not a live-health certification or proof that every consumer uses each feature successfully.[^I1][^I2][^I3][^I4][^I5][^I6][^I7]

Two distinctions matter. First, Papercusp's validity columns are not proof of a complete bitemporal graph implementation. Valid time—when a fact applies—and transaction time—when the system learned or recorded it—are different requirements. Second, entity linking within the existing memory integration is not proof of a general cross-record graph spanning every plan, decision, and source artifact. The latter remains a useful hypothesis to evaluate, not an absence established by a narrow code search.[^I3][^I8]

The practical question is therefore: **which additional relationships or context-selection policies would improve outcomes beyond the current architecture?**

## 4. Knowledge-graph and graph-memory options

### 4.1 Main shortlist

The capability column below summarizes primary sources. The fit column is this assessment's judgment.

| Option | Documented capabilities and constraints | Papercusp judgment |
|---|---|---|
| **Graphiti / Zep** | Graphiti incrementally builds temporal entity/fact graphs from episodes and combines semantic, keyword, and graph retrieval. Zep is the managed context-infrastructure offering around this approach. Graphiti supports specified external graph backends; its Kuzu integration is deprecated.[^1][^2] | Best initial temporal-relationship challenger. Keep it behind an adapter and outside the authoritative write path. |
| **Hindsight** | Retain/recall/reflect operations; distinctions between world facts, experiences, observations, and mental models; PostgreSQL deployment options. Retrieval combines semantic, keyword, graph, and temporal signals, then fusion and reranking.[^3][^4] | Best integrated-memory comparison. Significant overlap means it needs stronger evidence than “more features.” |
| **Microsoft GraphRAG** | Research-oriented graph-based document analysis. The repository currently warns that it is largely in maintenance mode. Microsoft's LazyGraphRAG work explores reducing eager indexing and summarization costs.[^5][^6] | Useful reference architecture and research baseline; not the preferred new core dependency. |
| **LightRAG** | Entity-level and higher-level graph retrieval, vector retrieval, incremental updates, selective deletion, reranking, and multiple storage backends. The current README recommends PostgreSQL for production and describes document/multimodal additions.[^7] | Best document-oriented shortlist entry. Evaluate on a bounded corpus, not live coordination state. |
| **Cognee** | A broader memory platform combining graph, vector, code, and session-derived knowledge; current operations include remember, recall, improve, and forget.[^11] | Interesting for a shared organizational knowledge base. Lower priority for replacing Papercusp's established orchestration. |
| **Mem0** | Papercusp already integrates OSS Mem0. Current hosted Platform documentation describes native entity-linked graph memory without an externally provisioned graph database.[^9][^I1][^I8] | Reassess the installed adapter and upgrade path first. Do not assume hosted documentation describes the installed OSS package. |
| **Neo4j GraphRAG for Python** | First-party graph-building and retrieval package; it supersedes the deprecated `neo4j-genai` package. Current docs describe Neo4j version-specific capabilities.[^13] | A strong toolkit if Neo4j is selected for explicit graph requirements; not an autonomous-memory system by itself. |
| **LlamaIndex PropertyGraphIndex** | Source exposes configurable graph extraction, graph storage, embeddings, and optional separate vector storage.[^14] | Useful composition layer for a Python retrieval service. Avoid introducing a second agent framework solely to obtain it. |

### 4.2 Where a graph would help this project

The promising workload is not simply “remember an earlier message.” It is a question requiring several linked pieces of evidence:

> Which decision superseded an earlier approach, which work-item implemented that decision, what code embodies it, and what evidence verifies the behavior?

A relationship representation could connect those records through their existing identifiers. Another useful query might ask which still-current conclusions depend on a source that was corrected or withdrawn.

This is an example of a relationship query, not evidence that relational storage is inadequate. A fixed chain can use ordinary joins; variable-length dependency or supersession chains can use recursive SQL. See the follow-up for PostgreSQL-native implementation choices and the relationships already present in Papercusp.

For these cases, start with relationships already declared by the application: parentage, implementation coverage, evidence references, decision references, and explicit supersession. Use extraction from prose only for links the structured data does not already supply.

Graphiti is worth testing where the missing value is temporal entity reconciliation or relationship retrieval across unstructured episodes. If most target questions resolve through existing identifiers and a few joins, a framework that repeatedly extracts those same links with an LLM is an unnecessary source of cost and disagreement.[^1][^23]

### 4.3 Where a graph is unlikely to help

Do not route the following through inferred graph memory by default:

- Current lock ownership, approval state, deployment state, or work assignment.
- Exact compiler references when the language server can answer.
- A known file, record ID, or source span that can be fetched directly.
- A self-contained current document whose answer needs no cross-document relation.

This is a recommended routing policy. Papercusp's existing code-graph facade already distinguishes topology questions from compiler/reference and text-search questions, offering a useful model for that boundary.[^I5]

### 4.4 Dependency cautions

Graphiti's temporal model is attractive, but choosing it is also choosing ingestion, entity resolution, graph operations, and recovery obligations. Its README currently recommends Neo4j or FalkorDB for new projects rather than Kuzu. Verify the exact library release and driver compatibility at experiment time.[^1]

LightRAG's current documentation warns that its default locally persisted stores are for small tests rather than production. It also warns that changing embedding models requires re-embedding and that a general re-embedding tool is not currently supplied. Its “PostgreSQL all-in-one” option still requires checking the exact extensions and deployment recipe; it should not be interpreted as “works unchanged in our existing database.”[^7]

LazyGraphRAG should be treated separately from Microsoft's normal GraphRAG package. The research announcement's June 6, 2025 editor's note points to Microsoft Discovery and Azure Local integrations; it does not establish that an equivalently supported standalone OSS package is available.[^6]

## 5. Graph storage choices

Choose storage after identifying the required query shapes, not because a framework comparison lists a popular database.

| Storage option | What the primary source establishes | Recommended position |
|---|---|---|
| **Existing PostgreSQL tables and recursive queries** | PostgreSQL supports recursive CTEs for traversing relationships.[^23] | First option for bounded traversal of declared project links. Avoid copying records unnecessarily. |
| **Apache AGE** | Adds graph querying and SQL/openCypher composition to PostgreSQL. The checked repository references PostgreSQL 18.[^25] | Worth an extension-compatibility spike only if ordinary SQL becomes awkward. Repository support is not proof of compatibility with this packaged installation. |
| **Neo4j** | Dedicated graph ecosystem with a maintained first-party GraphRAG library.[^13] | First external database to evaluate for a Graphiti prototype when its driver path and operational profile fit. |
| **FalkorDB** | Property-graph storage with sparse-matrix representation and openCypher support; explicitly supported by Graphiti.[^1][^26] | A credible second Graphiti backend. Benchmark locally; do not adopt vendor latency comparisons as project measurements. |
| **Memgraph** | Graph platform with Cypher, durability/storage controls, and documented GraphRAG tooling.[^27] | An alternative if its operational or query model is specifically advantageous. No current project evidence makes it necessary. |
| **Amazon Neptune** | Managed graph database supporting property-graph query languages and RDF/SPARQL; Neptune Analytics is a distinct complementary service.[^28] | Relevant to an AWS deployment strategy, not the default choice for the existing local/shared architecture. |

RDF and ontology-heavy approaches become interesting when formal vocabularies, standards-based interchange, or explicit inference rules are requirements. For the proposed decision/work-item/evidence traversal, this assessment would begin with typed application relationships instead. Nothing in the reviewed project scope establishes a need for an enterprise ontology platform.

Storage procurement should examine tenant isolation, backup and restore, extension packaging, update/deletion behavior, concurrency, index rebuilds, exportability, and license terms. Current license snapshots illustrate why rechecking matters: Graphiti is Apache-2.0, Hindsight states MIT, and OpenViking's main project is AGPLv3. These are source observations, not a determination of obligations for a particular distribution.[^2][^3][^18]

## 6. Context-management technologies beyond graphs

### 6.1 Hierarchical and addressable context

**OpenViking** organizes resources, memories, and skills in a virtual filesystem. L0 abstracts, L1 overviews, and L2 details let an agent inspect summaries before loading full content. Directory-aware retrieval is part of the design. Its main-project licensing requires review before embedding or distributing it.[^8][^18]

**VikingRAG**, submitted September 10, 2026, extends the relevant research direction: combine structural and semantic access, retrieve again when evidence is missing, reuse prior retrieval paths, and avoid multi-round retrieval when one pass suffices. Its reported savings are author results on their datasets, not a forecast for Papercusp.[^17]

**Recommendation:** adopt the pattern before adopting another context database. Papercusp can expose existing authoritative objects at several detail levels, with stable source references and revision stamps. A manifest should tell the agent what an object is and whether it is worth expanding; the underlying record should remain available.

Do not rewrite all project data into a parallel filesystem just to obtain a hierarchy. Reuse current docs, plan bundles, and rationale projections. Every summary should identify the source revision it summarizes and become ineligible when that source changes.[^I6]

### 6.2 Observational memory and compaction

**Mastra observational memory** uses an Observer and Reflector to maintain a dense observation log in place of growing raw history. Its docs describe append-oriented observations that preserve a more cacheable prompt prefix.[^12]

**Letta** provides stateful agents, persisted messages, editable memory blocks, and shared blocks that can be attached to more than one agent. These are valuable control primitives, but also overlap with a substantial part of Papercusp's existing agent lifecycle.[^20]

**OpenAI compaction** currently supports automatic server-side compaction through Responses context-management configuration, as well as a standalone compaction path. The returned compacted state includes an encrypted item. This is an API capability, not proof that a CLI-hosted session exposes the same controls.[^21]

**Recommendation:** evaluate compression behind the existing checkpoint/carry boundary. Preserve exact identifiers, unresolved commitments, evidence references, approvals, and next actions in structured records. Do not make an opaque provider compaction item the only durable representation of work, and do not let a summary assert that a task passed without its verification record.

A useful experiment compares the existing checkpoint approach with an observation-log approach on the same long task sequences. Test what is retained, what is omitted, and whether a successor can recover original evidence—not just whether the summary is shorter.

### 6.3 Memory organization and consolidation

**Hindsight** is especially worth studying for its separation of facts, agent experiences, observations, and mental models. Its paper argues that evidence and inference should not be conflated; the current implementation combines several retrieval paths and token-budgeted reranking.[^3][^4]

**LangMem** provides memory extraction and management, background consolidation, and prompt-refinement capabilities, with a core API intended to work with different storage systems. **LangGraph** separately supplies checkpointed thread state and namespaced long-term stores.[^10][^22]

**MemOS** offers a broader memory operating-system approach: graph-structured editable memory, multiple knowledge bases, multimodal and tool memories, asynchronous ingestion, and feedback/correction. Its current README records further local-agent integrations during 2026.[^29]

**Recommendation:** keep provenance and confidence classes explicit in Papercusp. “An agent observed a failure,” “a test verified the cause,” and “a general rule was inferred” must be different records or clearly typed states. Inspect these external designs without migrating the entire runtime to inherit their vocabulary.

### 6.4 Managed or packaged memory services

**Supermemory** now documents a self-hosted binary with an embedded graph engine, local embeddings, and the same general API family as its hosted product. Its local-versus-enterprise documentation distinguishes a single-tenant, single-key local service from enterprise organizational access controls.[^19][^30]

**Google Memory Bank** is documented as persistent memory for facts and user preferences within its agent platform. **Amazon Bedrock AgentCore Memory** offers managed short-term interactions and long-term extracted information across sessions.[^31][^32]

**Recommendation:** keep these as buy-versus-build options for an application whose priority is managed operation. They are not the default recommendation for Papercusp's core shared workspace because they add another data-governance boundary. Any evaluation needs explicit decisions about external data transfer, deletion, export, tenant scopes, model providers, and offline behavior.

“Runs locally” must include the extractor and embedder if the objective is preventing network egress. A local storage process that calls a hosted extraction model is not an entirely local data path.[^30]

### 6.5 Better retrieval without a knowledge graph

**Contextual retrieval** augments chunks with information about their original document before embedding and lexical indexing. Anthropic's published approach combines contextual embeddings, contextual BM25, and optional reranking.[^33]

**Late chunking** instead embeds tokens with their surrounding document context before pooling them into chunk representations. Jina describes this as a way to avoid losing context at early chunk boundaries. It is an embedding technique, not a replacement for memory lifecycle management.[^34]

**pgvector** already supports approximate and exact vector search while keeping vectors alongside relational records. Its documentation also covers filtered searches and iterative scans; whether these features matter depends on the installed version and actual query plans.[^24]

**Recommendation:** evaluate these only on diagnosed retrieval failures. Preserve exact-identifier retrieval alongside semantic methods. Reranking cannot rescue an answer that never enters the candidate pool, and a new embedding model should not trigger an unmeasured full-corpus migration.

The existing Papercusp reranking and hybrid seams make controlled experiments possible without creating another search system.[^I2][^I4]

### 6.6 Prompt and inference-state caching

**Provider prompt caching** reuses computation for matching prompt prefixes. OpenAI's current documentation explains that this is reuse of KV state, not a memory database. Stable instructions and stable ordering can improve reuse; changing early content can invalidate later matching prefixes.[^35]

**LMCache** provides an inference-side KV-cache management layer for serving infrastructure. Its project describes persistent reuse and integration across serving engines and storage arrangements.[^36]

**Recommendation:** prioritize stable prompt assembly and measure cache behavior in the provider paths Papercusp actually uses. Consider LMCache only for a self-hosted model-serving deployment we control. It cannot be inserted into a closed hosted API's internal serving stack by an application client.

Caching is about computational reuse. It does not establish that a remembered fact is current, relevant, or authorized.

### 6.7 Research to watch: ACE and recursive context access

**Agentic Context Engineering (ACE)**, published October 6, 2025, treats context as an evolving playbook updated through generation, reflection, and curation. Its central concern is that repeated whole-summary rewriting can discard useful detail. The paper proposes structured incremental adaptation.[^15]

**Recursive Language Models (RLMs)**, published December 31, 2025, treat a long input as an external environment that a model can examine programmatically and address through smaller recursive calls. This is an inference strategy for large inputs, not a persistent-memory database.[^16]

**Recommendation:** borrow incremental curation for procedural knowledge, but require tests or other evidence before promoting an inferred lesson into standing guidance. Trial RLM-style decomposition only for large research or audit jobs with explicit cost and recursion bounds. Neither approach justifies automatically rewriting permissions or launching uncontrolled background agents.

## 7. Proposed architecture

The following is a proposed integration shape, not a description of a completed implementation:

```text
Authoritative records, source files, events, and verification evidence
                              |
                 scoped, revisioned projections
                              |
        +---------------------+----------------------+
        |                     |                      |
 lexical/vector search   typed relationships     code intelligence
        |              (SQL first; graph optional)   |
        +---------------------+----------------------+
                              |
              task-specific retrieval and ranking
                              |
          provenance, validity, scope, and size checks
                              |
             compact context with expandable sources
```

The graph should hold references and derived relationships where possible, not become a second writable copy of every project object.

### Relationships and provenance

Prefer stable application identifiers over name-based matching. A plan decision and a source file should not be merged because their labels are semantically similar.

A derived relationship needs enough information to answer:

- What source asserted or supported it?
- Which source revision and source span were used?
- Was it declared by the application or inferred by a model?
- When was it recorded, and over what period does it apply?
- Which workspace and access scope may retrieve it?
- What should happen when its source is corrected or deleted?

These are proposed acceptance requirements. They should be represented by extending existing contracts where those already fit, rather than automatically adding another table or API.

### Retrieval routing

Use authoritative reads for live state; direct source fetches for known IDs; lexical and vector retrieval for discovery; graph expansion for genuine relationship questions; code intelligence for code topology; and document-level synthesis for broad corpus questions.

Start with a small traversal depth and evidence budget. Escalate only when an identified evidence gap remains. The usefulness of that adaptive strategy is supported as a research direction by VikingRAG and by Anthropic's discussion of just-in-time context access, but the exact policy for Papercusp needs testing.[^17][^37]

### Security and correction

Do not allow retrieved documents or inferred memories to become instructions that override workspace authority. Mark untrusted source content as evidence. Enforce access scope before traversal and retrieval, not only after a cross-tenant graph has been searched.

A correction or deletion should invalidate affected retrieval projections, graph edges, and summaries. Preserve historical queries only when retention policy permits them. “Out of the prompt” is not the same as “deleted.”

For asynchronous projection updates, expose freshness explicitly. A projection that has not caught up must not answer a current-state question as though it has.

These controls matter more to the recommended design than the choice between two graph query languages.

## 8. Evaluation before adoption

### Why a leaderboard is insufficient

LongMemEval evaluates information extraction, multi-session and temporal reasoning, knowledge updates, and abstention. MemoryArena, published February 18, 2026, instead couples remembered experience to later actions in interdependent tasks. Its abstract reports that strong performance on existing conversational-memory benchmarks does not necessarily transfer to that agentic setting.[^38][^39]

Papercusp needs both: correct answers about prior evidence and correct continuation of real work. Public scores use different models, extraction settings, token budgets, datasets, and cost accounting. The Hindsight repository, for example, contains benchmark claims; they are not evidence that it outperforms the current Papercusp baseline.

### Stage one: measure the current system

Construct a representative, permission-safe evaluation set from real recurring questions and task transitions. Keep a development set separate from a held-out set. Include a small number of expensive multi-session tasks as well as cheaper retrieval checks.

| Test class | Example acceptance question |
|---|---|
| Exact identifiers | Does retrieval find the named work-item, error, symbol, or decision? |
| Paraphrase | Can it find the right evidence when the wording differs? |
| Relationships | Can it connect a decision to implementation and verification? |
| Temporal correction | Does it distinguish a former approach from the current one? |
| Conflicting evidence | Can it show the conflict instead of silently choosing a convenient fact? |
| Abstention | Does it decline a conclusion that the sources do not establish? |
| Access isolation | Can a tenant or role retrieve another scope's private evidence? |
| Deletion and rebuild | Do removed sources disappear from derived views and remain absent after rebuild? |
| Compaction recovery | Can a successor resume without inventing completed work or losing commitments? |
| Concurrency and freshness | Does it report stale projections and remain usable during simultaneous updates? |

Do not assign synthetic benchmark percentages to these categories before measuring them.

### Stage two: compare narrowly

Compare the current baseline against one improvement at a time:

1. Existing retrieval with revised context assembly and hierarchical source expansion.
2. Existing retrieval plus bounded traversal of declared application relationships.
3. The same relationship workload through Graphiti.
4. A smaller Hindsight comparison for cross-session memory and consolidation.
5. LightRAG only if document-level synthesis is a sufficiently important workload.

Hold the answering model, relevant evidence, access policy, and answer-token budget constant where possible. Separately measure a realistic end-to-end configuration where products have different ingestion behavior.

Include ingestion cost, re-indexing, background consolidation, storage, stale-data failures, and operating complexity. Retrieval latency alone is not total cost.

### Stage three: make the decision on evidence

Adopt an additional backend only if it produces a repeatable improvement on the failure classes it is meant to solve, without unacceptable regression in precision, temporal correctness, isolation, or latency.

Use paired outcomes and uncertainty estimates; do not declare a winner from a handful of favorable examples. For mandatory access and deletion tests, any observed violation is a stop condition. Passing a finite suite does not prove universal safety.

If existing SQL relationships match the graph framework's benefit with less operational burden, stop there. If hierarchical retrieval and better summaries solve most observed failures, no general-purpose knowledge graph is required.

## 9. Priority and disposition

| Priority | Action | Adoption position |
|---|---|---|
| First | Establish retrieval, correction, and continuation baselines | Required before choosing a new platform |
| First | Improve source-linked, hierarchical context assembly using current surfaces | Highest-fit design direction |
| First | Verify correction propagation, scope filtering, and context freshness | Acceptance requirements, not optional polish |
| Next | Trial typed relationship traversal over existing records | PostgreSQL first |
| Next | Run a bounded Graphiti comparison where SQL/existing retrieval misses | Experiment; no production commitment |
| Next | Compare Hindsight's memory organization and consolidation | Architecture comparison and small prototype |
| Conditional | LightRAG for document-heavy synthesis | Only for that workload |
| Conditional | Mastra-style observations and provider compaction | Behind existing continuity contracts |
| Later | OpenViking, MemOS, Cognee, or another complete memory platform | Require evidence that selective extensions are insufficient |
| Later | Managed memory services or an external graph database | Require a concrete deployment/operational reason |
| Serving-specific | LMCache | Relevant only to a controlled self-hosted inference stack |

The recommendation is intentionally not “install all of these.” Each additional extractor, index, graph, summary cache, and memory writer adds another place where facts can diverge.

## 10. Bottom line

**Use graph techniques where relationships are the missing information, not as a replacement for the project ledger.**

Papercusp already implements much of the foundation marketed by agent-memory products. The best opportunity is making the right evidence arrive at the right time, with source identity, validity, scope, and an escape route back to the original record.

Existing PostgreSQL relationships are the first implementation path. Graphiti is a conditional external graph-memory experiment; Hindsight is the most relevant PostgreSQL-backed integrated-memory comparison; LightRAG is a document-analysis option with extension compatibility to verify. Hierarchical retrieval, reliable compression, and correction-aware context management deserve at least as much attention as any graph database.

## Sources

Public sources below were accessed directly on September 14, 2026 UTC. Dates are publication/submission dates where established; otherwise the source is a current, undated documentation or repository snapshot. Paper-based descriptions use the original abstract unless noted. No cited benchmark was independently reproduced.

[^1]: Zep, *Graphiti README*, current repository. Temporal model, retrieval, deployment drivers, and Kuzu deprecation. `https://raw.githubusercontent.com/getzep/graphiti/main/README.md`

[^2]: Zep, *Graphiti LICENSE*, current repository. Apache License 2.0. `https://raw.githubusercontent.com/getzep/graphiti/main/LICENSE`

[^3]: Vectorize, *Hindsight README*, current repository. Deployment, memory organization, retrieval, licensing, and vendor benchmark disclosures. `https://raw.githubusercontent.com/vectorize-io/hindsight/main/README.md`

[^4]: Chris Latimer et al., *Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects*, December 14, 2025. `https://arxiv.org/abs/2512.12818`

[^5]: Microsoft, *GraphRAG README*, current repository. Project status, purpose, and maintenance warning. `https://raw.githubusercontent.com/microsoft/graphrag/main/README.md`

[^6]: Darren Edge, Ha Trinh, and Jonathan Larson, Microsoft Research, *LazyGraphRAG: Setting a new standard for quality and cost*, November 25, 2024; editor's note June 6, 2025. `https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/`

[^7]: HKUDS, *LightRAG README*, current repository, including its 2026 update log. Retrieval modes, storage guidance, lifecycle, and embedding migration caveat. `https://raw.githubusercontent.com/HKUDS/LightRAG/main/README.md`

[^8]: Volcengine, *OpenViking README*, current repository. Virtual filesystem, L0/L1/L2 context, directory retrieval, and component licensing. `https://raw.githubusercontent.com/volcengine/OpenViking/main/README.md`

[^9]: Mem0, *Graph Memory*, current Platform documentation. Native entity graph and replacement of the external graph-store approach. This is Platform documentation, not an assertion about the installed OSS version. `https://docs.mem0.ai/platform/features/graph-memory`

[^10]: LangChain, *Memory overview*, current LangGraph documentation. Thread checkpoints and namespaced long-term memory. `https://docs.langchain.com/oss/python/langgraph/memory`

[^11]: Cognee, *README*, current repository. Graph/vector/code/session knowledge and memory operations. `https://raw.githubusercontent.com/topoteretes/cognee/main/README.md`

[^12]: Mastra, *Observational Memory*, current documentation. Observer/Reflector, observation logs, and cacheable context. `https://mastra.ai/docs/memory/observational-memory`

[^13]: Neo4j, *GraphRAG for Python*, current documentation. First-party package, supported versions, and `neo4j-genai` deprecation. `https://neo4j.com/docs/neo4j-graphrag-python/current/`

[^14]: LlamaIndex, *PropertyGraphIndex implementation*, current repository. Configurable extraction and graph/vector storage. `https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/indices/property_graph/base.py`

[^15]: Qizheng Zhang et al., *Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models*, October 6, 2025. `https://arxiv.org/abs/2510.04618`

[^16]: Alex L. Zhang, Tim Kraska, and Omar Khattab, *Recursive Language Models*, December 31, 2025. `https://arxiv.org/abs/2512.24601`

[^17]: Peiyuan Gao et al., *VikingRAG: Accurate and Token-efficient Retrieval-augmented Generation over Structured Documents*, September 10, 2026. Submitted research, not an independently validated deployment result. `https://arxiv.org/abs/2609.11390`

[^18]: Volcengine, *OpenViking LICENSE*, current main-project license. GNU AGPL version 3. Component exceptions are listed in the README. `https://raw.githubusercontent.com/volcengine/OpenViking/main/LICENSE`

[^19]: Supermemory, *Local vs. Enterprise*, current documentation. Local single-tenant/single-key versus organizational controls. `https://supermemory.ai/docs/self-hosting/local-vs-enterprise.md`

[^20]: Letta, *Introduction to Stateful Agents*, current page reached through the memory-guide route. Persisted messages, agent-editable memory blocks, and shared blocks. `https://docs.letta.com/guides/agents/memory/`

[^21]: OpenAI, *Compaction*, current API documentation. Automatic and standalone compaction, including encrypted compaction items. `https://developers.openai.com/api/docs/guides/compaction`

[^22]: LangChain, *LangMem README*, current repository. Core API, memory tools, background consolidation, and prompt optimization. `https://raw.githubusercontent.com/langchain-ai/langmem/main/README.md`

[^23]: PostgreSQL Global Development Group, *WITH Queries (Common Table Expressions)*, current documentation. Recursive traversal. `https://www.postgresql.org/docs/current/queries-with.html`

[^24]: pgvector contributors, *pgvector README*, current repository. Vector search, HNSW, filtering, and iterative index scans. `https://raw.githubusercontent.com/pgvector/pgvector/master/README.md`

[^25]: Apache Software Foundation, *Apache AGE README*, current repository. SQL/openCypher graph extension; repository references PostgreSQL 18. `https://raw.githubusercontent.com/apache/age/master/README.md`

[^26]: FalkorDB, *README*, current repository. Property graph, sparse representation, and openCypher. `https://raw.githubusercontent.com/FalkorDB/FalkorDB/master/README.md`

[^27]: Memgraph, *Documentation*, current documentation index. Graph storage, durability, Cypher, and GraphRAG tooling. `https://memgraph.com/docs`

[^28]: Amazon Web Services, *What is Amazon Neptune?*, current documentation. Managed graph service, query languages, and distinction from Neptune Analytics. `https://docs.aws.amazon.com/neptune/latest/userguide/intro.html`

[^29]: MemTensor, *MemOS README*, current repository, including 2026 update log. Structured memory, knowledge-base composition, asynchronous ingestion, feedback, and integrations. `https://raw.githubusercontent.com/MemTensor/MemOS/main/README.md`

[^30]: Supermemory, *Supermemory local*, current documentation. Embedded engine, embeddings, extraction-provider choices, and API. `https://supermemory.ai/docs/self-hosting/overview.md`

[^31]: Google Cloud, *Scale your agents*, current agent-platform page reached through the Memory Bank overview route. Persistent facts and preferences; not a detailed feature-parity assessment. `https://docs.cloud.google.com/agent-builder/agent-engine/memory-bank/overview`

[^32]: Amazon Web Services, *Add memory to your Amazon Bedrock AgentCore agent*, current documentation. Short- and long-term memory. `https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html`

[^33]: Anthropic, *Introducing Contextual Retrieval*, September 19, 2024. Contextual embeddings, contextual BM25, and reranking. `https://www.anthropic.com/news/contextual-retrieval`

[^34]: Michael Günther and Han Xiao, Jina AI, *Late Chunking in Long-Context Embedding Models*, August 22, 2024. `https://jina.ai/news/late-chunking-in-long-context-embedding-models/`

[^35]: OpenAI, *Prompt caching*, current API documentation. Prefix matching and KV-state reuse. `https://developers.openai.com/api/docs/guides/prompt-caching.md`

[^36]: LMCache contributors, *README*, current repository. Inference-side KV-cache management and serving integrations. `https://raw.githubusercontent.com/LMCache/LMCache/dev/README.md`

[^37]: Anthropic, *Effective context engineering for AI agents*, September 29, 2025. Just-in-time retrieval, compaction, and structured notes. `https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents`

[^38]: Di Wu et al., *LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory*, October 14, 2024. `https://arxiv.org/abs/2410.10813`

[^39]: Zexue He et al., *MemoryArena: Benchmarking Agent Memory in Interdependent Multi-Session Agentic Tasks*, February 18, 2026. `https://arxiv.org/abs/2602.16313`

### Internal source evidence

Internal sources are repository reads, not public sources or production-health measurements. Line numbers refer to the inspected snapshot and may move with subsequent edits.

[^I1]: [Memory backend default](../../packages/operator-core/lib/memory/backend-selection.ts#L57) and [hybrid backend registration](../../packages/operator-core/lib/memory/configure.ts#L689).

[^I2]: [Hybrid retrieval fusion](../../libs/generic/memory/src/hybrid-fusion.ts#L105).

[^I3]: [Canonical memory validity filtering](../../libs/generic/memory/src/canonical-store.ts#L402), the same file's `invalidate` implementation, and [temporal-memory runbook](../../apps/operator-docs/src/content/docs/agent-insights/temporal-memory-validity-and-supersession.mdx#L32).

[^I4]: [Ranking implementation](../../libs/generic/search-core/src/rank.ts#L131) and [prose-search reranker integration](../../packages/operator-core/lib/agent-tools/search/rerank.ts#L1).

[^I5]: [Curated code-graph tool](../../packages/operator-core/lib/agent-tools/gitnexus/query.ts#L50).

[^I6]: [Rationale projector](../../packages/operator-core/lib/rationale/projector.ts#L1) and [plan context bundle](../../packages/operator-core/lib/agent-tools/plans/context-bundle.ts#L217).

[^I7]: [Compaction and continuity runbook](../../apps/operator-docs/src/content/docs/agents/compaction.mdx#L17).

[^I8]: [Installed Mem0 client integration](../../libs/generic/memory/src/mem0-client.ts#L361) and [entity-link maintenance implementation](../../libs/generic/memory/src/relink-entities.ts#L1).
