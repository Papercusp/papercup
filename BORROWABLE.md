# Borrowable libraries

> **Generated — do not edit by hand.** Run `npm run gen:borrowable`.
> Source of truth: `scripts/gen-borrowable-catalog.mjs`.

Papercusp builds a number of **general-purpose libraries with zero
Papercusp/Restart domain coupling** — any project can borrow them. Each
names no consuming app: where a host-specific value is needed it is
injected via a small seam (a `configure*()` call or a prop), and Papercusp
maps its own domain onto that seam in the operator.

Most live as standalone git submodules (their own repo under
`github.com/Papercusp/`) — clone that one repo to borrow it. In-repo
packages are consumed as `file:` workspace deps and can be promoted to
their own repo when needed.

## Pure utilities & infra

| Package | What it is | Source |
|---|---|---|
| `@papercusp/embedded-pg-discovery` | Generic Postgres connection-URL discovery for desktop / local-first apps: env vars → JSON discovery file → fallback. Pure, zero domain coupling, parameterized. | in-repo · `packages/embedded-pg-discovery` |
| `@papercusp/file-claim` | Shared FileClaimCoordinator vocabulary + conformance suite. Both backends (in-process FileLockQueue + PG-backed SU-locks) satisfy this interface via thin adapters. Vocabulary-aligning, not implementation-sharing — the backends correctly remain separate (Map vs PG). file-locking-improvements #11. | `libs/papercusp/packages/file-claim` · [Papercusp/papercusp](https://github.com/Papercusp/papercusp.git) |
| `@papercusp/plan-parser` | Pure plan-document parser: frontmatter + item/decision algebra + effective-status (blocked-by graph) + canonical content hash. Zero I/O, zero domain coupling. | in-repo · `packages/plan-parser` |
| `@papercusp/rate-limit` | Generic two-bucket rate limiter (soft refundable + hard lockout) over an injected BucketStore. Pure algorithm, zero domain coupling, zero runtime deps. | in-repo · `packages/rate-limit` |
| `@papercusp/rrf` | Reciprocal Rank Fusion — combine multiple ranked result lists into one. Pure, zero-dependency. Canonical use is fusing a BM25 ranking with a vector-similarity ranking, but it is domain-agnostic. | in-repo · `packages/rrf` |
| `@papercusp/token-kit` | Generic DTCG → multi-format tooling for Style Dictionary: OKLCH/hex/rgba colour transforms, a Tailwind v4 @theme emitter, a typed-TS emitter, and source preflight guards. Brand-value-free; shared across projects. | [Papercusp/token-kit](https://github.com/Papercusp/token-kit.git) |

## Search & retrieval

| Package | What it is | Source |
|---|---|---|
| `@papercusp/memory` | mem0-backed persistent memory store core: the mem0ai/oss wrapper, a canonical pgvector store (one memory_canonical row per fact, per-embedder vec tables), a worker-thread-isolated local BGE embedder, and the cross-model re-embed pass. Host-agnostic — the embedded-pg admin URL, LLM credentials, the resolved embedder (pre-built embed fn + mode), and the optional adaptive-instruction hook are injected via configureMemory(). mem0 owns its own pg.Client, so no shared transaction handle is injected. Zero @papercusp/@restart runtime deps. | in-repo · `packages/memory` |
| `@papercusp/rerank` | Engine-agnostic cross-encoder reranking (ZeroEntropy zerank). Shared across Papercusp and Restart. | [Papercusp/rerank](https://github.com/Papercusp/rerank.git) |
| `@papercusp/search-core` | Engine-agnostic search-relevance core: instruction-following rerank steering, live LLM category-match, brand-aware query rewrite, tiered escalation, and the shared eval-harness metric contract. Builds on @papercusp/rerank; no project (Typesense/PG/catalog-schema) deps. Shared across Papercusp and Restart. | [Papercusp/search-core](https://github.com/Papercusp/search-core.git) |
| `@papercusp/search` | Host-agnostic BM25 + pgvector hybrid search over Postgres. The host registers pluggable SearchSources (each owning its tsvector/pgvector SQL); the engine runs BM25-only or BM25+embeddings fused via Reciprocal Rank Fusion. PG handle + query embedder are injected — zero schema coupling, zero embedding-provider dependency. | in-repo · `packages/search` |

## IPC, transport & sync

| Package | What it is | Source |
|---|---|---|
| `@papercusp/chat-protocol` | Deps-free streaming-chat wire contract — SSE event union + interactive-card protocol. Shared across Restart (Scout) and papercusp. | [Papercusp/chat-protocol](https://github.com/Papercusp/chat-protocol.git) |
| `@papercusp/desktop-ipc` | Endpoint-stream transport for Tauri desktop webviews: an IPC transport (over the Tauri bridge) + HTTP transport + a runtime picker, with the desktop-bootstrap fetch/EventSource polyfills. Routes /api/* over IPC to dodge the WebKitGTK/libsoup 6-connection-per-host limit. | in-repo · `packages/desktop-ipc` |
| `@papercusp/ipc-endpoint-server` | Host-agnostic Unix-socket/named-pipe server for the endpoint IPC protocol: framed REQUEST/CANCEL in, EVENT_JSON/EVENT_BIN/DONE/ERROR out, with the privileged sys:http HTTP-over-IPC bridge. Tool resolution, dispatch, and workspace state are injected via an IpcEndpointHost seam — zero registry or application coupling. | in-repo · `packages/ipc-endpoint-server` |
| `@papercusp/ipc-framing` | Length-prefixed binary frame codec for IPC/socket streams: [4B BE length][1B type][payload], with a streaming decoder. Pure, zero dependencies, zero domain coupling. | in-repo · `packages/ipc-framing` |
| `@papercusp/sse` | Spec-compliant Server-Sent Events primitives — server response builder, in-process channel bus, PG NOTIFY bridge, resilient EventSource client, React hook. | [Papercusp/sse](https://github.com/Papercusp/sse.git) |
| `@papercusp/sync` | Schema-agnostic Zero + SSE sync transports with reconnect/backpressure handling. | [Papercusp/sync](https://github.com/Papercusp/sync.git) |

## UI components

| Package | What it is | Source |
|---|---|---|
| `@papercusp/bloom-grid` | Bloom-filter-backed grid data layer: a versioned row store, a server-side bloom-query handler, and client React hooks (useBloomQuery / useInfiniteBloomQuery) for incremental sync of large cold catalogs. Part of the Papercusp grid stack. | `libs/generic/papergrid/bloom-grid` · [Papercusp/papergrid](https://github.com/Papercusp/papergrid.git) |
| `@papercusp/git-graph` | React components for rendering a git commit graph (commit list, commit detail, diff tooltips). Brand-value-free; styling injected by consumers via git-graph.css. | [Papercusp/git-graph](https://github.com/Papercusp/git-graph.git) |
| `@papercusp/grid-core` | Domain-agnostic datagrid primitives: GridTable, DataGridShell, grid-config, grid-theme, use-hover-expand. | `libs/generic/papergrid/grid-core` · [Papercusp/papergrid](https://github.com/Papercusp/papergrid.git) |
| `@papercusp/ui-primitives` | Shared headless React UI primitives — ANSI/terminal output, markdown (GFM), JSON tree viewer, and virtualized lists — used across Papercusp surfaces. Brand-value-free; styling is injected by consumers. | [Papercusp/ui-primitives](https://github.com/Papercusp/ui-primitives.git) |

## Reusable with host wiring (Papercusp tie-in kept by design)

These ship a host-injection seam but deliberately retain a Papercusp
tie-in (DB/schema/path assumptions). Borrowable with adaptation, not as-is.

| Package | What it is | Source |
|---|---|---|
| `@papercusp/locks` | SU-agent file-lock coordinator: PG-backed cross-process file claims over a dedicated papercusp_su side-database with its own pools, pg_advisory_xact_lock serialization, FIFO grant cascade, LISTEN/NOTIFY wait subsystem, and background expiry janitor. Implements @papercusp/file-claim's FileClaimCoordinator (SuLocksCoordinator). Host-agnostic — the embedded-pg admin URL is injected via configureLocks(); coordinationDomain is an opaque caller string. Zero @papercusp/@restart runtime deps besides the @papercusp/file-claim interface. | in-repo · `packages/locks` |
| `@papercusp/coordination` | Agent coordination substrate, extracted as host-agnostic seams: coord-core (pure envelope types + identity-free fold/merge/glob protocol logic), CoordEventLog (the swappable append-only channel-log seam — fs default + in-memory double + workspace-scoped single-table Postgres backend; covers messages/handoffs/escalations/plan-events), PresenceStore (live presence), WatermarkStore (per-agent read cursors), and SubscriptionStore (path/glob watches) — each over an injected PgHandle with an in-memory double, all passing one conformance suite. No @papercusp/@restart runtime deps; identity resolution stays host-side by design. | in-repo · `packages/coordination` |
| `@papercusp/backup` | Per-workspace kopia backup system: snapshot/restore/verify/maintenance over the kopia CLI, SQL-backed snapshot+settings+destination metadata, pre-snapshot DB-dump hook, interval+event scheduling, and orphan sweep. Host-agnostic — the org PG handle, workspaces-root path, schema bootstrap, and embedded-pg admin URL are injected via configureBackup(). Zero @papercusp/@restart runtime deps. | in-repo · `packages/backup` |
| `@papercusp/docs-engine` | Source-agnostic docs retrieval engine. Outline + get + search + MDX-to-markdown pipeline, operating on a pluggable DocSource adapter. | in-repo · `packages/docs-engine` |
| `@papercusp/host-platform` | Host-boundary interface — fs / paths / database URL resolution behind one swappable adapter. Desktop impl + server stub. | in-repo · `libs/host-platform` |

