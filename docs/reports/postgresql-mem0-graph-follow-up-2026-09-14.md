# PostgreSQL-native relationships and Mem0 graph capabilities

## Recommendation

**Keep PostgreSQL. Build the required relationship queries over the existing project records before considering a separate graph database.**

The motivating example—connect a superseding decision to implementation, code, and verification—is a relational query. Fixed-length paths use joins; variable-length paths use recursive queries. Graph storage can make some patterns easier to express or execute, but the example does not establish a need for it.[^P1]

The deeper investigation changes the ordering of the shortlist:

1. Existing relational links and bounded SQL traversal.
2. Existing lexical/vector retrieval, with relationship expansion kept explicit and measurable.
3. Hindsight as a PostgreSQL-backed packaged-memory comparison, if a complete memory service is needed.
4. Apache AGE only if Cypher or its graph operations justify the extension and data-model integration.
5. Graphiti with an external graph backend only for a demonstrated gap not adequately addressed by the preceding options.

Mem0 remains relevant, but its graph-related capabilities should not be mistaken for a typed provenance graph. The current Platform explicitly describes co-occurrence connections rather than labeled relationships. The current OSS generation removed the old external graph integration; the installed TypeScript package supplies entity-overlap scoring instead.[^M1][^M2][^M3]

## 1. What relational PostgreSQL can provide

| Desired capability | PostgreSQL-native approach | Important boundary |
|---|---|---|
| Named relationships | Existing foreign keys and typed relationship tables | Prefer declared links to probabilistic extraction where IDs already exist. |
| Trace decision → implementation → evidence | Ordinary joins or a read-only view across the relevant tables | A missing link in the data remains missing regardless of database choice. |
| Transitive dependencies or supersession | `WITH RECURSIVE`, with cycle protection and explicit bounds | Broad path enumeration can still be expensive. |
| Time-dependent facts | Timestamp columns or `tstzrange`, with explicit validity predicates | Transaction history must be modeled separately if needed. |
| Flexible properties | Existing structured columns plus JSONB where variability warrants it | Do not replace well-defined schema with an opaque property bag unnecessarily. |
| Semantic discovery followed by relationship expansion | Existing vector/lexical search to identify seeds, then SQL traversal | Keep relevance ranking separate from structural completeness. |
| Workspace isolation | Scoped queries, roles, and tested row-security policies | Table owners and privileged roles can bypass ordinary RLS protections. |
| Document or resource hierarchy | Parent-child relations; `ltree` when path operations are valuable | `ltree` models hierarchy, not arbitrary cyclic relationships. |
| Graph analytics | A suitable extension or bounded off-database analysis | Analytics does not require moving the authoritative store. |

PostgreSQL documents recursive search and cycle handling, temporal ranges, row-security policies, and `ltree` as separate capabilities. pgvector supplies vector search alongside relational data. Those pieces can be composed without introducing another database service.[^P1][^P2][^P3][^P4][^P5]

The proposed architecture is therefore an access layer over existing records:

```text
Existing records and declared relationships in PostgreSQL
                         |
       direct lookup / joins / bounded recursive traversal
                         |
         source revisions + evidence + freshness checks
                         |
           compact result, expandable to source records
```

This is a proposed query composition, not an implemented new endpoint.

### Avoid an unnecessary universal edge table

A generic `(source, relationship, target, properties)` table can represent a property graph relationally. But it is not automatically the best starting point when the application already has typed dependency, specification, and evidence tables.

For Papercusp, first reuse those tables through their governing domain interfaces. Where a unified read is useful, expose a view or a query composition that normalizes their output. Preserve their distinct write invariants. A dependency that controls scheduling is not equivalent to a descriptive “related to” link.

Only introduce additional storage for relationships that are genuinely absent from the existing model. If inferred links are needed, label them as inferred, retain their evidence, and prevent them from silently becoming operational authority.

## 2. The relationships already present in Papercusp

The inspected source establishes several reusable pieces:

- `work_item_deps` stores scheduling dependencies, with indexes for both “what blocks this” and “what this blocks.”
- `coord_links` carries polymorphic descriptive relationships. The public linking vocabulary includes `fixes`, `investigates`, `caused-by`, `revises`, and others.
- `plan_items` and `plan_decisions` provide relational projections of plan content, including item/decision references.
- `work_item_spec_revision_edges` connects work-items to exact immutable specification revisions.
- `spec_evidence_bindings` attaches evidence to revision-specific claims.
- `work_items:links` already reads incoming or outgoing relationships, including batches of item IDs.[^I1][^I2][^I3]

These findings do **not** prove that every decision-to-code-to-evidence path is populated. They establish that the project already has relationship infrastructure and does not need to invent “nodes and edges” from scratch.

The most useful next step is a coverage audit of a small set of real questions:

1. Can existing links answer the question directly?
2. Is the problem an absent relationship, an inconvenient read interface, or missing source evidence?
3. Does the query need fixed joins, bounded recursion, or semantic discovery before traversal?
4. Can it return the evidence and identify missing portions without guessing?

If a relationship was never recorded, a graph database cannot recover it reliably by itself. An extractor can propose it, but that introduces a separate inference and verification problem.

## 3. Solutions that retain PostgreSQL

### 3.1 Ordinary SQL: preferred first route

This is the smallest implementation path for the concrete project questions. Keep typed relationships in their existing tables and use joins for known shapes.

Use recursion only for genuinely variable paths, such as descendants in a dependency network. Carry fully scoped object identities, track visited nodes, bound traversal depth, and cap work—not merely the final returned row count. PostgreSQL's `SEARCH` clauses describe output ordering; they should not be assumed to force a particular physical traversal strategy.[^P1]

For repeated expensive reachability queries, evaluate a cached or materialized result only after measuring the direct query. Such a cache introduces freshness and invalidation requirements, which may outweigh its benefit for small bounded traversals.

**Assessment:** best fit, lowest architectural disruption. This is a recommendation, not a performance result.

### 3.2 Apache AGE: graph querying inside PostgreSQL

AGE is a PostgreSQL extension that adds a property-graph model and openCypher alongside SQL. It avoids operating a separate database service, but it still adds a compiled extension, catalog/schema objects, and a graph representation to manage.[^P6]

The key caveat: installing AGE does not automatically reinterpret every existing application foreign key as a graph edge. Its documented operations create graph schemas and label tables. The application must decide what data is represented there and how changes stay consistent.[^P6]

**Current compatibility finding:** the checked LightRAG `PGGraphStorage` implementation uses AGE and has an explicit upper-version guard at `1.8.0`. By default it rejects that version and later versions pending verification. Separately, Apache AGE's GitHub latest-release endpoint returned the tag `PG18/v1.8.0-rc0`, published July 9, 2026. A repository “latest” label and a PostgreSQL-version badge are therefore insufficient deployment clearance.[^X1][^P7]

This does not establish that every AGE 1.8 deployment fails. It establishes a concrete integration incompatibility that must be resolved for that particular adapter. Do not bypass the guard or install it into the shared database merely to try a demo.

**Assessment:** a later option if Cypher materially simplifies important queries. Trial it in isolation on an explicitly compatible version combination.

### 3.3 Hindsight: a PostgreSQL-backed memory service

Hindsight offers extraction, entity-aware memory, temporal retrieval, consolidation, and reflection while using PostgreSQL as its database. Its current configuration selects `pgvector` and native PostgreSQL text search by default, with alternative index/search extensions available.[^H1]

That is a genuine way to obtain more memory-system behavior without adopting a separate graph database. However, it is **not** simply a library that queries Papercusp's existing tables. It brings its own schema, API process, background operations, and migration lifecycle.

A schema setting can separate its tables, but a separate schema does not isolate resource consumption or confer per-user authorization. The built-in default tenant extension permits unauthenticated single-tenant access; the simple API-key extension maps accepted requests to one configured schema. Multi-tenant mapping requires the appropriate tenant extension and enforcement.[^H2]

Its documented Memory Defense feature is opt-in and affects future writes. Its OSS rules described in that document redact or block recognized sensitive-data patterns; that is not a comprehensive defense against malicious instructions being stored as memory.[^H3]

**Assessment:** the most relevant packaged-memory comparison for a PostgreSQL-first strategy. Run it against its own disposable database/schema first, with migrations and authentication explicitly controlled.

### 3.4 LightRAG with PostgreSQL

LightRAG remains a document-oriented option, but “PostgreSQL all-in-one” must not be read as “plain SQL only.” Its PostgreSQL graph adapter uses AGE, including graph names derived from workspace and namespace.[^X1]

**Assessment:** conditional on document-retrieval value and an approved extension combination. It is not the simplest way to query existing work-item provenance.

### 3.5 pgRouting, `ltree`, and off-database analytics

pgRouting can run path algorithms over SQL-supplied edge data; its documentation includes shortest paths and connected-component functions. It is an additional extension, not a general memory platform. Consider it only if routing or graph algorithms are a real requirement.[^P8]

`ltree` is appropriate for hierarchical paths such as document sections or nested resources, but not a substitute for arbitrary relationships. For occasional community or centrality analysis, NetworkX can operate on a bounded graph extracted from PostgreSQL while PostgreSQL remains authoritative.[^P4][^P9]

**Assessment:** useful specialized tools, none necessary for the quoted fixed-chain example.

## 4. Mem0: three different things that must not be conflated

### 4.1 Older external-graph integrations

Mem0's current OSS migration guide explicitly says that the older graph-store configuration was removed. Its TypeScript migration table identifies `enableGraph` and `graphStore` as removed; the Python table makes the corresponding distinction. The guide directs graph-memory users toward the managed Platform.[^M2]

Consequently, an older tutorial showing Mem0 plus Neo4j is not evidence that the current installed OSS package supports that recipe. Reintroducing an obsolete major version solely to recover it would require a separate maintenance/security decision.

### 4.2 Current Mem0 Platform graph memory

Current Platform documentation describes entities linked to memories and connections through shared context. It explicitly states that these are **not typed, labeled relationships** such as one person managing another. Its graph influences ranking; normal search results contain a combined score rather than a separate typed-edge result set.[^M1]

This is useful for questions about a person, company, project, or other recurring entity. It is not equivalent to querying a declared chain:

```text
decision --supersedes--> decision
work-item --implements--> specification revision
evidence --verifies--> revision-specific behavior
```

Those relations can instead be modeled directly in PostgreSQL, using the project's declared identifiers and evidence contracts.

The Platform is a managed service. Its use of an internal graph does not mean it can be pointed at Papercusp's existing PostgreSQL tables. The reviewed documentation does not establish that deployment option.

### 4.3 Current OSS and the installed package

The local installed package and lockfile identify **`mem0ai` 3.1.8**. The npm registry's `latest` tag also resolved to 3.1.8 during this check, with a publication timestamp of September 2, 2026. Its published `gitHead` was `9a7924befd7026e41e445ba809370009e5e985a6`.[^M4][^I4]

The current documentation distinguishes OSS entity-overlap scoring from Platform graph memory. The installed implementation extracts entities, associates them with memory IDs, and computes entity boosts during the SDK search path.[^M3][^M5]

**Important candidate-retrieval limitation:** the installed scorer iterates the semantic result set. Keyword and entity signals adjust scores for those candidates; they do not independently add a memory absent from that set. A large entity boost cannot rescue a candidate that never entered this particular scorer.[^M5][^M6]

That is not a claim about the closed-source Platform's internal candidate generation.

## 5. What Papercusp actually receives from Mem0

Papercusp's wrapper has two materially different read paths:

| Read path | Mechanism | Mem0 entity boost |
|---|---|---|
| Single scope without a supplied vector | Calls SDK `client.search` | Available through the SDK search logic |
| Multiple scopes or a supplied vector | Embeds once, then directly queries the canonical vector store | Bypassed by design |
| Hybrid retrieval | Combines the selected semantic path with Papercusp's lexical leg | Not equivalent to the upstream SDK's combined scoring |

The ambient memory-injection code constructs a union of scopes, so multi-pool retrieval takes the direct canonical path. The comments document a deliberate latency and score-comparability tradeoff, and the executable branches match that explanation.[^I5]

The existing focused test group was executed: **9 passed, 61 unrelated tests skipped**. It verifies the multi-scope routing and the single-scope distinction. This is focused unit verification, not a measurement of real-world recall quality.[^I6]

Papercusp also supplements verbatim writes with the SDK's private entity-linking method. Separately, it already resolves referenced work-item titles into an enriched embedding input while keeping stored memory text unchanged.[^I5][^I7]

Two consequences follow:

1. “We use Mem0” is insufficient to describe the retrieval behavior. The adapter and call shape matter.
2. A proposed entity-aware improvement should be compared against the actual multi-scope hybrid baseline, including existing reference expansion—not against stock Mem0 or vector-only search.

Re-enabling an expensive per-scope SDK path indiscriminately would undo an intentional optimization. A more controlled candidate is a bounded entity-to-memory expansion stage using the already stored links, with independent recall and latency measurements. That proposal remains unimplemented.

## 6. Corrections, time, and deletion

### Temporal relevance is not validity enforcement

Mem0 Platform's Temporal Reasoning documentation describes a ranking boost based on event dates matching the query's time intent. It should not be treated as a guarantee that superseded claims are impossible to retrieve.[^M7]

Mem0's documented extraction is additive; explicit update/delete operations remain relevant for corrections. Expiration is another distinct feature: it hides a record from list-shaped retrieval, does not delete it, and permits direct retrieval by ID. Invalid stored expiration values are documented as not expired.[^M3][^M8]

Papercusp should retain explicit lifecycle controls and test them across every retrieval path. A timestamp in metadata, a recency weight, a supersession link, and a historical query are different mechanisms.

### Mem0 entity cleanup is best-effort

The installed update/delete implementation changes the primary memory and then performs entity cleanup. Cleanup errors are caught and logged. The entity cleanup routine itself tolerates errors while listing or modifying entities.[^M5]

A dependency-stubbed probe of the **exact installed methods**, with no database or network access, established that a simulated entity-store listing failure can coexist with a successful primary-memory deletion. This is a failure-contract observation, not evidence that Papercusp currently contains stale or leaked data.

For strict deletion requirements, test the memory row, vector rows, entity links, history, derived summaries, exports, and replay/rebuild behavior separately. A successful primary delete is not a full erasure certificate.

### Graphiti also needs deletion-contract tests

At the inspected revision, `remove_episode` selects edges for deletion when the deleted episode is the first episode associated with an edge, and deletes nodes mentioned only by that episode. That is creator-based deletion logic, not proof of support-count-aware recomputation across every remaining source.[^G1]

Graphiti offers explicit valid/invalid/created/expired date filters. The checked convenience search path supplies an empty filter object when none is provided. An integration should therefore construct its intended current/historical policy explicitly and test it rather than relying on the word “temporal” in the product description.[^G1][^G2]

These are acceptance-test obligations, not a declaration that the products are unusable.

## 7. Existing decisions and benchmark evidence

Historical work-item records report an earlier AGE-retrieval experiment and a preference for write-time reference expansion. The reference-expansion implementation is present and called by the memory writer. The separate structural-traversal proposal, EI-10057, was closed by an age-out/hygiene decision rather than an implementation completion.[^I7][^I8]

However, the retrieved original benchmark plan still describes an unfinished study and its D-001 section is a pre-registered decision rule—not a final rejection verdict. That conflicts with treating the historical shorthand “D-001 REJECT” as a complete, independently verified conclusion.

Accordingly, the old numeric claims are **not** reused as current performance evidence here. The durable implementation and the caution against conflating structural traversal with similarity ranking are useful context; a new comparison still needs its own frozen inputs and evidence.

A useful additional evaluation source is Hindsight's document-evolution benchmark. It tests repeated document updates, loss of structure, missed facts, and lingering superseded claims. This is closer to the failure modes of evolving runbooks and carry notes than a one-shot memory question. It is a vendor-maintained test design, not independent proof of a winner.[^H4]

## 8. Proposed evaluation and implementation boundary

The next approved implementation should be small:

1. Select three real relationship questions with known answers.
2. Map them onto existing records and identify missing links explicitly.
3. Implement bounded server-side reads through existing domain surfaces.
4. Compare agent round trips, evidence correctness, freshness, and query latency against today's multi-call workflow.
5. Add semantic seed discovery only where the starting object is unknown.

A later entity-retrieval experiment should compare:

- Current multi-scope hybrid retrieval.
- The same pipeline with bounded entity-linked candidate expansion.
- A PostgreSQL-backed packaged system such as Hindsight, only if broader memory organization is in scope.

Graphiti or AGE should enter the comparison only for a capability these simpler alternatives fail to supply adequately.

### Required tests

| Area | Discriminating test |
|---|---|
| Declared provenance | Return the exact chain and source revisions, not merely similarly worded records. |
| Missing evidence | Mark an absent link or verification explicitly; do not synthesize a successful chain. |
| Candidate generation | Include a relevant entity-linked memory outside the initial vector candidates. |
| Time | Separate a current answer from an as-of answer and a future-effective fact. |
| Contradiction | Show conflicting sources and apply the declared supersession policy. |
| Isolation | Test traversal and direct-by-ID access using different workspace identities. |
| Deletion | Inject cleanup failure, retry, and rebuild; verify the intended erasure scope. |
| Query cost | Exercise high fan-out, cycles, and simultaneous readers/writers with explicit limits. |
| Context updates | Apply repeated corrections and check facts, evidence references, and formatting for drift. |

The first objective is a reliable answer over existing data, not a general-purpose graph platform.

## 9. Verification scope

Public documentation, pinned upstream source, local source, the installed package, and the npm registry were inspected on September 14, 2026 UTC.

Completed checks:

- Installed `mem0ai` version compared with npm's current `latest` tag.
- Installed scoring implementation compared with the release-pinned source.
- Exact-method, dependency-stubbed probes of candidate admission and deletion cleanup.
- Focused Papercusp multi-scope memory tests: 9 passed.
- Read-only inspection of relationship schemas, their tool interfaces, and historical records.

The installed ESM bundle used for the probes had SHA-256:

```text
269b39e4740143256ba17b34aac2cac8ff63f91334d9af06a59fc1a8b3231789
```

No model-quality benchmark, production data-integrity audit, graph installation, schema migration, provider upload, or product implementation was performed. The probes are narrow reproducible diagnostic checks, not substitutes for framework integration tests.

## Sources

### PostgreSQL and graph-query options

[^P1]: PostgreSQL Global Development Group, *WITH Queries*, PostgreSQL 18 documentation. Recursive queries, output ordering, and cycle handling. `https://www.postgresql.org/docs/18/queries-with.html`

[^P2]: PostgreSQL Global Development Group, *Range Types*, PostgreSQL 18 documentation. Temporal ranges and constraints. `https://www.postgresql.org/docs/18/rangetypes.html`

[^P3]: PostgreSQL Global Development Group, *Row Security Policies*, PostgreSQL 18 documentation. Policy behavior and privileged-role exceptions. `https://www.postgresql.org/docs/18/ddl-rowsecurity.html`

[^P4]: PostgreSQL Global Development Group, *ltree*, PostgreSQL 18 documentation. Hierarchical paths and indexing. `https://www.postgresql.org/docs/18/ltree.html`

[^P5]: pgvector contributors, *README*, current repository. `https://raw.githubusercontent.com/pgvector/pgvector/master/README.md`

[^P6]: Apache Software Foundation, *AGE README*, current repository. Graph schemas, label tables, SQL/Cypher, extension setup. `https://raw.githubusercontent.com/apache/age/master/README.md`

[^P7]: Apache AGE, GitHub latest-release metadata, checked September 14, 2026. Returned `PG18/v1.8.0-rc0`, published July 9, 2026. `https://api.github.com/repos/apache/age/releases/latest`

[^P8]: pgRouting, *Dijkstra* and algorithm index, current 4.0 documentation. `https://docs.pgrouting.org/latest/en/pgr_dijkstra.html` and `https://docs.pgrouting.org/latest/en/index.html`

[^P9]: NetworkX, *Algorithms*, current reference. `https://networkx.org/documentation/stable/reference/algorithms/index.html`

### Mem0

[^M1]: Mem0, *Graph Memory*, current Platform documentation. Explicit distinction between co-occurrence connections and typed relationships. `https://docs.mem0.ai/platform/features/graph-memory.md`

[^M2]: Mem0, *OSS v2 to v3 Migration*, current migration guide. Removal of the OSS external-graph configuration and current retrieval design. `https://docs.mem0.ai/migration/oss-v2-to-v3.md`

[^M3]: Mem0, *How Mem0 Works*, current documentation. Additive extraction and OSS/Platform retrieval distinction. `https://docs.mem0.ai/core-concepts/how-it-works.md`

[^M4]: npm registry, *mem0ai package metadata*, checked September 14, 2026. `latest`, publication time, and published `gitHead`. `https://registry.npmjs.org/mem0ai`

[^M5]: Mem0, TypeScript OSS memory implementation at the published 3.1.8 `gitHead`. Search, entity linking, update/delete, and cleanup behavior. `https://raw.githubusercontent.com/mem0ai/mem0/9a7924befd7026e41e445ba809370009e5e985a6/mem0-ts/src/oss/src/memory/index.ts`

[^M6]: Mem0, TypeScript OSS scoring implementation at the same revision. `scoreAndRank` iterates semantic candidates. `https://raw.githubusercontent.com/mem0ai/mem0/9a7924befd7026e41e445ba809370009e5e985a6/mem0-ts/src/oss/src/utils/scoring.ts`

[^M7]: Mem0, *Temporal Reasoning*, current Platform documentation. Date-intent ranking rather than an erasure or validity contract. `https://docs.mem0.ai/platform/features/temporal-reasoning.md`

[^M8]: Mem0, *Memory Expiration*, current documentation. Hiding versus deletion, direct-by-ID retrieval, and malformed-date semantics. `https://docs.mem0.ai/platform/features/memory-expiration.md`

### Other source-level comparisons

[^H1]: Hindsight, *Configuration*, revision `e3efe5dd8b070d00129c5186d111c0bc5f992363`. PostgreSQL schema, migration, vector and text-search options. `https://raw.githubusercontent.com/vectorize-io/hindsight/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-docs/docs/developer/configuration.md`

[^H2]: Hindsight, *Built-in tenant extensions*, same revision. `https://raw.githubusercontent.com/vectorize-io/hindsight/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-api-slim/hindsight_api/extensions/builtin/tenant.py`

[^H3]: Hindsight, *Memory Defense*, same revision. Opt-in sensitive-data processing and future-write scope. `https://raw.githubusercontent.com/vectorize-io/hindsight/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-docs/docs/developer/memory-defense/index.md`

[^H4]: Hindsight, *Document evolution benchmark*, same revision. Repeated-update evaluation design. `https://raw.githubusercontent.com/vectorize-io/hindsight/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-dev/benchmarks/document_evolution/README.md`

[^X1]: HKUDS LightRAG, *PostgreSQL implementation*, revision `b9bd1c965c8832acc34240db49447c4a104dc331`. `PGGraphStorage` and `AGE_FIRST_UNSUPPORTED_VERSION`. `https://raw.githubusercontent.com/HKUDS/LightRAG/b9bd1c965c8832acc34240db49447c4a104dc331/lightrag/kg/postgres_impl.py`

[^G1]: Zep Graphiti, *Graphiti implementation*, revision `c035afb7990b6077331a81e98b04efcfd9bf8184`. Search defaults and `remove_episode`. `https://raw.githubusercontent.com/getzep/graphiti/c035afb7990b6077331a81e98b04efcfd9bf8184/graphiti_core/graphiti.py`

[^G2]: Zep Graphiti, *Search filters*, same revision. `https://raw.githubusercontent.com/getzep/graphiti/c035afb7990b6077331a81e98b04efcfd9bf8184/graphiti_core/search/search_filters.py`

### Internal evidence

[^I1]: [Dependency schema](../../libs/papercusp/libs/db/sql/367-work-item-deps.sql#L17), [typed link writer](../../packages/operator-core/lib/agent-tools/work_items/link.ts#L1), and [relationship reader](../../packages/operator-core/lib/agent-tools/work_items/links.ts#L1).

[^I2]: [Plan item and decision projections](../../libs/papercusp/libs/db/sql/675-normalize-plan-items-decisions.sql#L51).

[^I3]: [Immutable specification and evidence relationships](../../libs/papercusp/libs/db/sql/855-work-item-spec-evidence-bindings.sql#L1).

[^I4]: [Installed package metadata](../../node_modules/mem0ai/package.json) and [lockfile](../../package-lock.json#L33757).

[^I5]: [Mem0 backend adapter](../../libs/generic/memory/src/mem0-backend.ts#L507), including `remember` earlier in the same file, and [ambient multi-scope injection](../../packages/operator-core/lib/memory/injection.ts#L1140).

[^I6]: [Multi-scope unit tests](../../libs/generic/memory/src/mem0-backend.test.ts#L99). Executed command: `./node_modules/.bin/vitest run libs/generic/memory/src/mem0-backend.test.ts --maxWorkers=1 -t 'batched multi-scope path'`.

[^I7]: [Write-time reference expansion](../../packages/operator-core/lib/memory/ref-expand.ts#L1) and [memory writer call site](../../packages/operator-core/lib/agent-tools/memory/remember.ts#L613).

[^I8]: Internal work-item records EI-10048 and EI-10057, and the complete `Decisions` section of plan `memory-recall-age-ab-benchmark-2026-07-11`, read September 14, 2026. The records contain historical claims; the plan section is a decision rule, not independent verification of a completed benchmark.
