# Papercusp — Technology Stack

*Prepared for investor diligence · 27 July 2026*

---

## 1. What we're building, in one paragraph

Papercusp is a **local-first multi-agent software factory**. It ships as a desktop
application that runs an entire agent operations plane on the customer's own machine:
a supervisor process, an embedded Postgres database, and fleets of AI coding agents
that claim work, coordinate with each other over durable channels, and drive changes
through test and review gates to a deploy.

The architectural consequence matters for reading everything below: **we are not a
thin wrapper over a model API.** The large majority of what we've built is the
*substrate* agents run on — work scheduling, inter-agent coordination, file locking,
memory and retrieval, tool dispatch, provenance, and safety gating. The model is a
commodity input we route into that substrate; the substrate is the product.

---

## 2. The stack at a glance

| Layer | Technology |
| --- | --- |
| **Languages** | TypeScript (2.66M LOC), Rust (71k LOC), SQL |
| **Desktop shell** | Tauri 2 (Rust + native webview), typed IPC via specta |
| **Frontend** | React 19, Vite 8, TanStack Router, Radix UI, Tailwind 4, nuqs |
| **Backend** | Hono 4 on Node 25; DBOS for durable workflows |
| **Database** | PostgreSQL 18 — *embedded in the app*; Drizzle ORM; 630 migrations |
| **Realtime** | In-house sync layer: SSE over Postgres `LISTEN/NOTIFY` |
| **Agent interface** | Model Context Protocol (MCP) — 691 tools across 139 groups |
| **Model access** | In-house multi-provider inference gateway with failover |
| **Retrieval / memory** | Hybrid Postgres FTS + vector, RRF fusion, reranking, mem0 |
| **Extensibility** | WebAssembly Component Model (WIT + wasmtime / jco) |
| **Distribution** | First-party peer-to-peer git + coordination plane (Holepunch) |
| **Testing** | Vitest 4, Playwright, Cargo, LLM eval batteries (6,170 test files) |
| **Delivery** | Automated green-gate pipeline, auto-rollback, Tauri auto-updater |
| **Analytics** | PostHog (product analytics + feature flags) |

**Repository shape:** npm-workspaces monorepo, ~80 workspace packages, 39 git
submodules, 12,731 TypeScript source files. All figures measured 8 August 2026 and
regenerable on demand via `npm run stats:proof`.

---

## 3. Layer by layer

### 3.1 Desktop shell — Tauri, not Electron

The product ships as a **Tauri 2** application: a Rust host process driving the
operating system's native webview, with a Node sidecar for the server plane.

Why this choice matters commercially:

- **Binary size and memory.** Tauri uses the OS webview instead of bundling a full
  Chromium. Installers are roughly an order of magnitude smaller than the Electron
  equivalent, with materially lower idle memory — meaningful when the app is meant to
  sit resident all day running agent fleets.
- **Real OS integration.** We use the Rust plugin surface for tray/menubar operation
  (there is a headless "server" role with no main window), login auto-start,
  single-instance locking, native notifications, global shortcuts, and a signed
  auto-updater.
- **Typed boundary.** Every Rust command is annotated with `specta` and
  `tauri-specta` emits TypeScript bindings on each build, so the Rust↔JS IPC boundary
  is type-checked rather than stringly-typed.

We maintain vendored forks of three Tauri runtime crates (`tao`, `wry`,
`tauri-runtime-wry`) where we needed behaviour upstream doesn't yet expose.

### 3.2 Frontend

**React 19** on **Vite 8**, routed by **TanStack Router**, styled with **Tailwind 4**
over **Radix UI** primitives and our own design-token system (Style Dictionary /
DTCG). Notable pieces:

- **`dockview`** for the draggable multi-pane workbench — the app is closer to an IDE
  than a dashboard.
- **`xterm.js`** for live agent terminals rendered inside the app.
- **React Flow (`@xyflow/react`)** for plan and dependency graphs.
- **`nuqs`** for URL-backed state. This is a deliberate architectural rule, not a
  preference: user-meaningful state lives in the URL so that *agents can read and
  drive the UI through the same surface a human uses*. State hidden in React
  component memory is invisible to an agent; state in the URL is addressable.
- **Storybook 10** plus **lost-pixel** visual-regression and **axe-core**
  accessibility checks in CI.

### 3.3 Server plane

**Hono 4** running on **Node 25**. Hono is a small, web-standards HTTP framework
(`Request`/`Response`), which keeps our handlers portable across the desktop sidecar,
a hosted deployment, and test harnesses without rewrites.

Durable, long-running work runs on the **DBOS SDK** — Postgres-backed workflow
execution with automatic recovery, so a multi-hour agent pipeline survives a process
restart rather than losing its place.

### 3.4 Data — Postgres as the whole substrate

We ship **a real PostgreSQL 18**, embedded in the desktop application (with logical
replication enabled), not SQLite and not a hosted dependency. Access via
**postgres.js** and **Drizzle ORM**.

The standing engineering rule is that **new durable state goes in Postgres unless
there is a specific reason it must be a file** — no JSON state files, no in-process
caches standing in for storage. Everything the system coordinates on lives in one
transactional, queryable store: work items, plans and decisions, file locks, agent
presence, inter-agent messages, memories, feature flags, and a full telemetry table of
every tool invocation.

Schema is **migrations-only** — 630 of them to date, allocated through an atomic
number reservation service so that dozens of agents editing concurrently cannot
collide. There is no runtime DDL anywhere in the product.

This is a bigger deal than it sounds. Multi-agent systems usually keep coordination
state in process memory or in a message bus, and then cannot answer "what happened and
why" after the fact. Ours is a database, so provenance, audit, cost attribution, and
recovery are queries rather than features we'd have to build later.

### 3.5 Realtime sync

A first-party library (`@papercusp/sync`) presents a single query/mutate API to the UI
and picks its transport by deployment context:

- **Server-Sent Events over Postgres `LISTEN/NOTIFY`** — the desktop-primary path. A
  write anywhere in the system invalidates the exact affected queries and clients
  update, with reconnect and backpressure handling built in.
- **WebSocket** and **REST** fallbacks for browser and degraded contexts.

The library is deliberately schema-agnostic — apps inject their own schema — which is
why it is one of the components we can reuse across products.

### 3.6 The agent interface — one function, three transports

This is the piece we consider most load-bearing.

We write a feature **once**, as a single typed function with a small manifest. The
framework then projects it onto:

1. an **HTTP route** the UI calls,
2. an **MCP tool** an AI agent calls,
3. an **in-process call** any TypeScript module can `await`.

Authentication, role allow-lists, capability checks, per-window quotas, streaming
progress, uniform error shaping, and telemetry persistence are handled once in the
shared dispatcher — not re-implemented per endpoint. Result payloads are automatically
serialised into the most token-efficient format the data shape allows, which cuts
agent token spend on list results by roughly 20–35% with no change to calling code.

The catalogue currently stands at **691 tools across 139 functional groups**, and it
grows at roughly the cost of writing the function itself. That ratio — surface area
per unit of engineering — is the thing that compounds.

We use the **Model Context Protocol** as the agent-facing standard, which means any
MCP-capable model or client can drive Papercusp, and Papercusp can consume third-party
MCP servers as plugins. We're standards-aligned rather than proprietary at the
integration boundary.

### 3.7 Model access — the inference gateway

Model calls do not go directly to a provider. They go through a first-party
**inference gateway** that we run as a sidecar. It provides:

- **Credential pooling** across many provider accounts, with a per-account rate
  governor;
- **Automatic failover** when an account is throttled, and session-affinity routing so
  prompt caching still works;
- **Health probing, circuit breaking, and stall detection** with self-healing;
- **Provider adapters** for Anthropic and OpenAI-shaped APIs, plus **local backends**
  (Ollama, Groq, and on-device models via Transformers.js);
- **Per-call cost and usage accounting** written to Postgres.

Strategically this is our insulation against model-vendor risk. Providers are
interchangeable inputs behind a stable internal interface; pricing moves, rate limits,
and outages are routing problems rather than product outages. It also means a customer
who requires fully on-premise inference is a configuration change, not a rewrite.

### 3.8 Retrieval and memory

Agents need to find things in large codebases and remember what they learned:

- **Hybrid search** — Postgres full-text plus vector embeddings, fused with
  **Reciprocal Rank Fusion**, then reranked. Embeddings can be generated locally via
  **Transformers.js** (no data egress) or through a hosted provider.
- **Qdrant** client support for larger vector workloads.
- **mem0** for long-lived agent memory, with our own scoped-facts layer on top for
  deterministic recall of standing decisions.
- A **code-graph index** (call chains, callers/callees) so agents reason over
  structure rather than grep output.

### 3.9 Extensibility — WebAssembly

Third-party plugins compile to **WebAssembly components** against versioned **WIT**
(WebAssembly Interface Type) definitions. The same `.wasm` artifact loads on either
host: **jco**-transpiled to ESM for the JavaScript host, or **wasmtime** with
`bindgen!` for the Rust host.

This gives us a sandboxed, capability-scoped, language-agnostic plugin story — a
plugin author can write Rust, Go, or TypeScript, and the host enforces what it can
reach. It is a materially stronger security posture than "run this npm package in our
process," which matters for enterprise distribution.

### 3.10 Peer-to-peer git and a decentralised coordination plane

A first-party peer-to-peer implementation of git, built on the Holepunch stack
(hypercore append-only logs, hyperbee, hyperswarm DHT). Machines replicate code
**directly to each other** over encrypted connections with no forge in the middle — one
repository per project, each device authoring its own signed lane.

It is not a prototype. The layer carries repository identity and key pinning, an
authority-epoch model, ref announcement and fetch coalescing, convergence and
federation probes, foreign-merge admission with mirror quarantine, a secrets guard on
publish, integration requests, release promotion, and a bidirectional GitHub bridge
(ingress, egress, forks) for interoperating with existing infrastructure without
depending on it.

Crucially the **coordination plane is peer-to-peer too**, not just the code: messages,
events, presence and work state replicate machine to machine with signed receipts.
There is no central coordinator to go down, and no outside service ever holds customer
source, work history, or anything the agents produce.

Commercially this is the strongest single differentiator in the stack. Every competitor
in agent tooling is a hosted service holding the customer's code. This architecture
makes "your source never leaves your machines" a structural property rather than a
policy promise — which is the objection that otherwise ends enterprise conversations.

### 3.11 Quality engineering

Four canonical test frameworks, enforced by lint so the suite can't fragment:

- **Vitest 4** for unit and integration tests, with **testcontainers** spinning real
  Postgres instances for integration runs;
- **Playwright** (plus axe-core) for end-to-end browser flows;
- **Cargo** tests for the Rust shell;
- **LLM scenario/eval batteries** — a scored regression suite for agent *behaviour*,
  which is how we keep prompt and policy changes from silently degrading quality.

**6,170 test files / 1.23M lines of test code** against 1.43M lines of product code — a
0.86:1 ratio, and rising: on the narrower basis tracked longest it has gone from 0.72:1 to
0.90:1 in under two weeks. Test code growing faster than product code under autonomous
development is the opposite of the usual assumption about AI-generated software. Also in the loop: property-based testing, a mutation/fuzz harness for the UI, a
test quarantine mechanism, dependency-integrity doctors, and generated-artifact drift
checks that fail the build if documentation and code disagree.

### 3.12 Delivery pipeline

Fully automated, and notable because **the agents ship the product**:

1. A background sync service commits and pushes the shared working tree on a schedule.
2. An hourly **green checkpoint** runs the full suite and fast-forwards the `main`
   branch *only* if everything passes. Nothing reaches `main` by hand — a pre-push hook
   blocks it.
3. Green commits **auto-deploy** within ~15 minutes, with automatic rollback on
   failure, staged behind a two-port model (staging and green production run side by
   side).
4. Desktop releases go out through the signed **Tauri updater**.

Feature work is gated by a first-party **feature-flag system** with enforced defaults,
an audited "dark flag" allow-list, and expiry dates, so finished work cannot quietly
sit unshipped.

**PostHog** provides product analytics and flag distribution; every tool invocation is
independently recorded to Postgres with role, duration, status and payload size, giving
us first-party observability over agent behaviour and cost that doesn't depend on a
vendor.

---

## 4. What is bought vs. built

**Bought / open-source (we don't differentiate here):** the language runtimes, React,
Vite, Tauri, Hono, Postgres, Drizzle, Radix, Tailwind, Vitest, Playwright, PostHog, the
model providers themselves.

**Built, and where the defensibility sits:**

1. **The endpoint system** — one typed function projected onto HTTP, MCP, and
   in-process transports with shared auth, quota, telemetry, and streaming. 691 tools
   is a consequence of this, not an achievement independent of it.
2. **The coordination substrate** — durable work items, plans and decisions, presence,
   enforced file locking, and message passing, all transactional in Postgres. This is
   what makes many agents on one codebase safe rather than chaotic, and it is the part
   competitors most consistently under-build.
3. **The peer-to-peer git and federation layer** — a first-party decentralised git plus
   a decentralised coordination plane, so customer source never leaves customer machines
   as a structural property rather than a policy. Arguably the strongest single
   differentiator here: every competitor is a hosted service holding the code.
4. **The inference gateway** — multi-account pooling, governance, failover, and local
   backends behind one interface.
5. **The blueprint/harness engine** — declarative pipelines (48 blueprints today:
   coding, research, review, migration, deliberation, evaluation, and more) that shape
   how a queue of work routes through specialist agent roles and human approval gates.
6. **~30 domain-free internal libraries** (`libs/generic/*`) — sync, search, locks,
   rate limiting, scheduling, plugin loading, structured concurrency, IPC framing,
   deployment driving. Each is written behind a configuration seam specifically so it
   can be reused or spun out; we maintain a generated catalogue of them.

---

## 5. Honest risk notes

- **Model-provider dependency.** Real, but structurally mitigated: the gateway makes
  providers swappable and already supports local inference. Our exposure is to the
  *category* of frontier models, not to any one vendor's pricing or terms.
- **Surface area.** The system is large for the team size. The counterweights are the
  test ratio, the generated-artifact drift checks, and the fact that a substantial and
  growing share of the engineering is done by the agents the platform runs — we are our
  own highest-volume customer, so friction surfaces immediately rather than in support
  tickets.
- **Tauri/webview fragmentation.** Using OS webviews means per-platform rendering
  differences. We carry vendored runtime forks and platform-specific verification for
  this; it is a known, managed cost of not shipping Chromium.
- **Alpha-stage maturity.** There is no production user base yet. That is a
  go-to-market fact rather than a technical one, and it is why the codebase still moves
  with breaking changes rather than compatibility shims.

---

## 6. The one-line summary

**TypeScript and Rust, Postgres for everything durable, Tauri for a local-first desktop,
MCP as the agent interface, a first-party gateway that makes model providers
interchangeable, and our own peer-to-peer git so customer code never leaves customer
machines — with the genuinely proprietary work sitting in the coordination substrate that
lets many AI agents work one codebase without stepping on each other.**
