---
title: Abstract Papercusp's reusable systems into standalone libraries — the storage-adapter seam and the extraction backlog
slug: papercusp-systems-abstraction-2026-05-29
status: draft
created: 2026-05-29
updated: 2026-05-29
owner: avi@storewolf.com
created-by-revision: R-001
companion-to: [papercusp-tooldef-extraction-2026-05-29]
---

# Abstract Papercusp's reusable systems into standalone libraries

How the general-purpose systems we built for Papercusp get carved out of
`apps/operator/lib/*` into standalone, project-agnostic libraries — what's
already done, what's trapped, the *one* coupling that gates the whole backlog,
and the order to do it in.

## Now

**State:** Draft. Code-grounded audit complete (2026-05-29, repo-wide fan-out
across `packages/`, `libs/`, `apps/`). Two extractions are already in flight and
are **out of scope here**: the endpoint/`defineTool` system →
[[papercusp-tooldef-extraction-2026-05-29]], and the chat system (`@restart/agent-chat` +
`libs/papercup-shared/src/agent/chat-stream.ts`). The audit's central finding:
the still-trapped value (locks, coordination, search, memory, plans, backup) is
**not** coupled on domain logic — it shares ONE coupling, the PG access path
(`withWorkspace()` / `inWorkspaceTxn()` from `@restart/db-org` + hardcoded
`harness_shared.*` table names). Define one storage-adapter seam (P-001) and the
whole cluster becomes extractable. `@papercusp/file-claim` already proves the
shape. The coordination-storage question the audit raised is **resolved** below
(D-004): the file+PG hybrid is deliberate, shipped architecture, not drift.

**Next:** a human confirms the package-bundling decision (P-000, needs-human) —
ship as ~4 bundles (D-002) vs. one-package-per-system — then an agent starts
Phase 1 (P-001): the `WorkspaceStore` seam + the two trivial pure extractions
(`rrf`, `embedded-pg-discovery`) as the proof-of-pattern.

## Background

### The question

"I really like a lot of the systems we built but they're tied to Papercusp. How
can we abstract them into a generalized library anyone can use?" Other agents
already own `defineTool` and chat; this plan covers **everything else** general
enough to share.

### What reading the code changed vs. the first-pass guess

Papercusp has *already* pushed a large reusable layer into `libs/` + `packages/`.
So the work isn't "find reusable code" — it's "free the reusable code still
trapped inside the app." Two populations:

**Population A — already factored out (just need publishing / promotion):**
`@restart/sse` (`libs/sse`), `@papercusp/token-kit` (`libs/token-kit`),
`@papercusp/host-platform` (`libs/host-platform`), `@papercusp/docs-engine`
(`packages/docs-engine`), `@papercusp/file-claim`
(`libs/papercusp/packages/file-claim`), plus the React libs `@restart/agent-chat`,
`@restart/git-graph`, `@restart/papergrid`, `@restart/ui-primitives`, and
`@papercusp/flags` (`libs/flags`). These are low/no coupling and mostly done.

**Population B — trapped in `apps/operator/lib/` (this plan's real work):**
`locks` (`agent-tools/locks/`, ~4.7K LOC, own `papercusp_su` DB), `coordination`
(`agent-tools/coordination/`, ~4.5K LOC), `search` (`agent-tools/search/`,
`rrf.ts` is pure), `memory` (`lib/memory/` + `agent-tools/memory/`), `plans`
(`agent-tools/plans/`, `parser.ts` is pure), `backup` (`lib/backup/` +
`agent-tools/backup/`). Plus small ones: `embedded-pg-discovery.ts` (~58 LOC),
the Tauri IPC polyfill (`lib/transport-adapters/desktop-bootstrap.ts` +
`lib/endpoint-ipc/`), `prompt-assembly.ts`, `auth.ts` / `auth-rate-limit.ts`.

### The one seam that unlocks the cluster

Every trapped agent-tools subsystem reaches the database the same way — through
Papercusp's `withWorkspace(id, tx => …)` / `inWorkspaceTxn()` helpers (from
`@restart/db-org`) and writes `harness_shared.*` tables with hardcoded names.
They are **not** coupled on the harness/feature/role *nouns* — those barely
appear in these subsystems' core logic. So one decision gates the whole backlog:
define a small **storage-adapter interface** (a `Store` / transaction handle the
caller supplies) and have each subsystem take it as a constructor arg instead of
importing `inWorkspaceTxn` directly. Do that once → locks/coord/search/memory/
backup all become extractable PG-default packages with swappable backends
(Redis / SQLite / in-memory for tests). Skip it → the same coupling gets
re-litigated six times. `@papercusp/file-claim` already demonstrates the target
shape: a pure interface (`FileClaimCoordinator`) + a conformance suite, with the
PG locks code as one implementation.

## Audit results — the master table

| System | Location | Coupling | Status | Verdict |
|---|---|---|---|---|
| **locks** | `agent-tools/locks/` (~4.7K LOC, own `papercusp_su` DB) | LOW | interface split to `file-claim` | Extract — top pick (P-010) |
| **coordination** | `agent-tools/coordination/` (~4.5K LOC) | LOW→MED (storage) | not extracted | Extract — top pick (P-011) |
| **search / rrf** | `agent-tools/search/` (`rrf.ts` pure) | LOW (rrf=NONE) | not extracted | rrf now (P-002); search w/ seam (P-020) |
| **embedded-pg-discovery** | `lib/embedded-pg-discovery.ts` (~58 LOC) | NONE | not extracted | Extract now (P-003) |
| **memory / mem0** | `lib/memory/` + `agent-tools/memory/` | MEDIUM | not extracted | Extract w/ store+embedder seam (P-021) |
| **plans (parser)** | `agent-tools/plans/parser.ts` | NONE (parser) | not extracted | Extract pure parser (P-022) |
| **plans (lifecycle)** | `agent-tools/plans/` (~10K LOC) | MED-HIGH | not extracted | Keep lifecycle in-app |
| **backup** | `lib/backup/` + `agent-tools/backup/` | LOW | not extracted | Extract w/ root injection (P-023) |
| **Tauri IPC polyfill** | `lib/transport-adapters/` + `lib/endpoint-ipc/` | LOW-MED | not extracted | Extract — Tauri niche (P-030) |
| **auth-rate-limit** | `lib/auth-rate-limit.ts` | MEDIUM | not extracted | Extract w/ store seam (P-031) |
| **prompt-assembly** | `lib/prompt-assembly.ts` (~300 LOC) | HIGH (role enum + agent-mcp) | not extracted | Document pattern; defer |
| **orchestrator** | `libs/papercusp/packages/orchestrator/` (~2MB) | HIGH | partial pkg | Keep in-tree — it IS the harness |

**Population A (already factored — publish/promote only):** `@restart/sse`,
`@papercusp/token-kit`, `@papercusp/host-platform`, `@papercusp/docs-engine`,
`@papercusp/file-claim`, `@restart/agent-chat`, `@restart/git-graph`,
`@restart/papergrid`, `@restart/ui-primitives`, `@papercusp/flags`.

**Explicitly out of scope (other teams):** endpoint/`defineTool`
([[papercusp-tooldef-extraction-2026-05-29]]); chat system.

**Keep in-tree (do not over-abstract):** orchestrator, roles/experts,
autoloop/goals, `zero-harness`, `papercup-shared` (shop domain), the nuqs
UI-control surface (document only — already in `CLAUDE.md`).

## The coordination-storage question — resolved (see D-004)

The audit surfaced an apparent conflict: one read found JSONL file-backed coord
logs, another found `harness_shared.coord_*` PG tables. **Reading the code, both
are correct, and the split is deliberate, documented, shipped architecture** —
not drift. Authoritative source:
`apps/operator/docs/plans/agent-coordination-architecture-v2-2026-05-20.md`
(status: shipped), §2 "the layered model" and §4 "L1 — identity & presence".

What the code actually does, file by file:

| Concern | Backend | File | Why |
|---|---|---|---|
| messages + acks (outboxes) | **JSONL** `coord/messages/<ownerId>.jsonl` | `messages.ts` | per-sender outbox = one writer per file = zero contention, no lock; an OMP agent with no operator can still read/write directly |
| handoffs | **JSONL** `coord/handoffs/<msg_id>.json` | `handoffs.ts` | same portability rule; one file per event |
| escalations | **JSONL** `coord/escalations/<msg_id>.json` | `escalations.ts` | same |
| watermarks (read cursors) | **JSONL** `coord/watermarks/<ownerId>.json` | `watermarks.ts` | per-agent, single writer |
| subscriptions / watches | **JSONL** `coord/subscriptions/<ownerId>.jsonl` | `subscriptions.ts` | per-agent |
| plan-events feed | **JSONL** `coord/plan-events-<YYYY-MM>.jsonl` | `plan-events.ts` | single writer (operator), best-effort observability, not state |
| **live presence / heartbeat** | **PG** `harness_shared.coord_presence` | `presence.ts` | needs frequent concurrent heartbeat upserts + a LEFT JOIN to the durable `power_user_sessions` roster — file store can't do that cleanly |
| durable agent roster | **PG** `harness_shared.power_user_sessions` | (owned by OMP-bundle) | already shipped; coord *reads* it, never duplicates it |

The design rule (v2 §1, "Preserve portability" + §4.2): **L3 async channels and
the read-cursors are filesystem JSONL** precisely so an OMP agent running outside
Papercusp (no operator, no PG) still participates by direct fs reads/writes. The
operator adds tool-mediated UX on top, it is not a prerequisite. **L1 live
presence is PG** because it is many-writer heartbeat state that must JOIN the
durable roster — exactly what PG is for and files are not. (Note this is a
*different* `coord/` from the rust-port `coord/*.jsonl`, which keys on `action`
not `kind`; v2 §3.2 documents the two-schema reality. This plan's coordination
extraction governs the operator's typed-envelope files only.)

**Recommendation:** extract coordination as a **dual-backend library by design,
not by accident.** The `CoordStore` interface (P-011) has two implementations
shipped in the box: a `FsCoordStore` (the portable JSONL path, default) for the
channel/cursor surfaces, and the `WorkspaceStore`-backed PG presence path for
the heartbeat surface. This is strictly *more* reusable than collapsing to one
backend: consumers who want zero-infra multi-agent coordination get the file
path; consumers who want live presence dashboards get the PG path; both are the
same library. Do **not** "fix" the hybrid by forcing everything into PG — that
would delete the detached-mode portability that is a stated, shipped goal.

## End state

- `WorkspaceStore` (or similarly named) seam defined once; the trapped
  subsystems take it as a dependency instead of importing `inWorkspaceTxn`.
- ~4 published bundles (per D-002): `@papercusp/agent-coord` (file-claim + locks
  + coordination), `@papercusp/agent-retrieval` (rrf + search + memory +
  docs-engine), `@papercusp/plan-kit` (pure parser + optional persistence),
  `@papercusp/desktop-runtime` (embedded-pg-discovery + IPC polyfill +
  endpoint-ipc; host-platform already exists).
- Each extracted package: PG impl as default, an in-memory impl for tests, a
  conformance suite (the `file-claim` pattern), zero `@papercusp`-domain imports
  in core.
- Coordination ships dual-backend (`FsCoordStore` + PG presence) as a feature.
- Orchestrator, roles, autoloop, prompt-assembly stay in-app (documented why).

## Phase 0 — Scope lock

- **P-000** `needs-human` Confirm the bundling decision (D-002): ship as ~4
  bundles vs. one package per system. This sets every package boundary
  downstream. → D-001 D-002
- **P-001** `todo` Define the `WorkspaceStore` seam: a minimal interface
  wrapping the transaction handle + table-namespace that locks/coord-presence/
  search/memory/backup currently get from `withWorkspace()`/`inWorkspaceTxn()`.
  Ship a PG impl (wraps the existing helper) + an in-memory impl + a conformance
  suite, mirroring `@papercusp/file-claim`. This is THE seam; everything else
  blocks on it. blocked-by: P-000 → D-003

## Phase 1 — Trivial pure extractions (proof-of-pattern, no seam needed)

- **P-002** `todo` Extract `@papercusp/rrf` from `agent-tools/search/rrf.ts`
  (~50 LOC, zero imports — reciprocal rank fusion). Ship with its existing test.
  Proves the publish pipeline end to end. → D-001
- **P-003** `todo` Extract `@papercusp/embedded-pg-discovery` from
  `lib/embedded-pg-discovery.ts` (~58 LOC). Parameterize the discovery-file path,
  env-var names, and DB name; keep `getHarnessAdminUrl()` as the Papercusp-
  configured wrapper. Every embedded-PG desktop app needs this. → D-001

## Phase 2 — The coordination cluster (depends on the seam)

- **P-010** `todo` Extract `@papercusp/locks` (PG impl behind the existing
  `file-claim` `FileClaimCoordinator` interface) from `agent-tools/locks/`. Move
  the SQL to the package; inject the `WorkspaceStore` instead of `inWorkspaceTxn`;
  keep the separate `papercusp_su` DB as a deployment detail, not a hard import.
  blocked-by: P-001 → D-003
- **P-011** `todo` Extract `@papercusp/coordination` from
  `agent-tools/coordination/` as a **dual-backend** library: a `CoordStore`
  interface with a `FsCoordStore` (portable JSONL — the default, covers messages/
  acks/handoffs/escalations/watermarks/subscriptions/plan-events) and a
  `WorkspaceStore`-backed PG presence path (heartbeat + roster JOIN). Extract the
  protocol (envelope, handoff state machine, escalation flow, watermark merge)
  and the `resolveAgentIdentity` primitive. blocked-by: P-001 → D-004

## Phase 3 — The retrieval cluster (depends on the seam)

- **P-020** `todo` Extract `@papercusp/search` (BM25 + pgvector hybrid) from
  `agent-tools/search/`. Source-registration becomes an adapter (callers declare
  which tables/tsvector columns to search) instead of the hardcoded 4 surfaces;
  embedder is injectable; `WorkspaceStore` supplies the tx. Depends on `rrf`
  (P-002). blocked-by: P-001, P-002 → D-003
- **P-021** `todo` Extract `@papercusp/memory` (mem0-style semantic memory) from
  `lib/memory/` + `agent-tools/memory/`. Seams: the vector store (PG default via
  `WorkspaceStore`), the embedder selection (OpenAI/local → injected), the
  scoping convention (`user:` / `harness:` → caller-supplied), and the dedup
  judge (Claude → injected). Leave the pre-turn injection wiring in the operator.
  blocked-by: P-001 → D-003
- **P-022** `todo` Extract `@papercusp/plan-parser` — the **pure** parser from
  `agent-tools/plans/parser.ts` (frontmatter + item/decision algebra +
  effective-status + lint rules; zero imports). The full plans lifecycle
  (revisions, promote, launch, runs, CAS chunked writes, git history) **stays in
  the operator** — it's MED-HIGH coupled to harness features/registry/PG. → D-005

## Phase 4 — Desktop runtime cluster

- **P-023** `todo` Extract `@papercusp/backup` (kopia wrapper) from `lib/backup/`
  + `agent-tools/backup/`. Inject the workspace-root + settings store
  (`WorkspaceStore`); kopia is the real IP, this is a thin shell. Keep the
  load-bearing self-exclusion guard. blocked-by: P-001 → D-003
- **P-030** `todo` Extract `@papercusp/desktop-ipc` — the Tauri/WebKitGTK IPC
  polyfill (`lib/transport-adapters/desktop-bootstrap.ts`: `IpcEventSource`,
  `ipcFetch`) + the `lib/endpoint-ipc/` framing/server protocol. Make dispatch
  pluggable (pass a handler, not Papercusp's `dispatchProjectedToolStream`). This
  is the libsoup pool-exhaustion fix — high value to every Tauri+WebKitGTK app
  doing long-lived streaming. → D-006
- **P-031** `todo` Extract `@papercusp/rate-limit` (the 2-bucket, PG-durable
  limiter) from `lib/auth-rate-limit.ts`; parameterize bucket windows/keys; use
  `WorkspaceStore`. The opaque-session auth (`auth.ts`) can follow if wanted, but
  is lower priority (schema-parameterization only). blocked-by: P-001

## Phase 5 — Promote what's already factored (Population A)

- **P-040** `todo` Audit the already-extracted libs for publish-readiness
  (versioning, README, zero stray `@papercusp`-domain imports) and publish/
  promote: `@restart/sse`, `@papercusp/token-kit`, `@papercusp/host-platform`,
  `@papercusp/docs-engine`, `@papercusp/file-claim`, plus the React libs and
  `@papercusp/flags`. Low effort; mostly packaging. → D-007

## Phase 6 — Verification

- **P-050** `todo` Each extracted package: in-memory `WorkspaceStore`/`CoordStore`
  passes the same conformance suite as the PG impl; the operator re-points at the
  package with no behavior change; existing suites green. blocked-by: P-010,
  P-011, P-020, P-021, P-022, P-023, P-030, P-031
- **P-051** `todo` Proof-of-genericity: stand up one extracted package
  (recommend `@papercusp/coordination` via `FsCoordStore`) in a throwaway non-
  Papercusp script with zero operator/PG present, to prove detached mode works.
  blocked-by: P-011

## Decisions

### D-001 — Scope: everything reusable except endpoint + chat
Date: 2026-05-29
This plan covers all general-purpose systems EXCEPT the two already in flight:
the endpoint/`defineTool` system ([[papercusp-tooldef-extraction-2026-05-29]])
and the chat system (`@restart/agent-chat` + `chat-stream.ts`). Those are owned
by other agents; duplicating them here would collide. User framing, 2026-05-29.

### D-002 — Bundle into ~4 packages, not ~12 micro-libs (proposed, needs P-000)
Date: 2026-05-29
The systems cluster by shared dependency, so the recommendation is ~4 bundles —
`@papercusp/agent-coord`, `@papercusp/agent-retrieval`, `@papercusp/plan-kit`,
`@papercusp/desktop-runtime` — rather than one package per system. Fewer
publish/version surfaces, and the natural dependency seams (file-claim→locks→
coord; rrf→search→memory) live inside a bundle. Final call gated on P-000.

### D-003 — One storage-adapter seam gates the cluster
Date: 2026-05-29
The trapped subsystems share exactly one coupling: PG access via
`withWorkspace()`/`inWorkspaceTxn()` + hardcoded `harness_shared.*` names — NOT
domain (harness/feature/role) logic. Define a `WorkspaceStore` seam once (P-001),
inject it everywhere, and locks/coord-presence/search/memory/backup all extract
with PG-default + swappable backends. `@papercusp/file-claim` already proves the
interface+conformance shape; replicate it. This is the load-bearing decision.

### D-004 — Coordination ships DUAL-backend; the file+PG hybrid is correct
Date: 2026-05-29
Resolves the audit's open question. The hybrid is deliberate, shipped
architecture (`agent-coordination-architecture-v2-2026-05-20.md`, §2/§4), not
drift. L3 async channels + read-cursors are JSONL files (`coord/*`) so a
detached OMP agent with no operator/PG still participates by direct fs I/O
(stated portability goal); L1 live presence is PG (`harness_shared.coord_presence`)
because it's many-writer heartbeat state that JOINs the durable
`power_user_sessions` roster. Extract coordination as a `CoordStore` interface
with BOTH a `FsCoordStore` (default, portable) and a PG presence path shipped in
the box. Do NOT collapse to PG-only — that deletes detached-mode portability.

### D-005 — Plans: extract the pure parser only; lifecycle stays in-app
Date: 2026-05-29
`plans/parser.ts` (frontmatter + item/decision algebra + lint) is pure and
extracts cleanly as `@papercusp/plan-parser`. The lifecycle surface (revisions,
promote-to-features, launch, runs, CAS chunked writes, git history) is MED-HIGH
coupled to harness registry/features/PG and stays in the operator. Splitting at
the parser boundary is the clean seam.

### D-006 — Tauri IPC polyfill: extract with pluggable dispatch
Date: 2026-05-29
The IPC polyfill + endpoint-ipc framing solve a real, niche-but-painful problem
(WebKitGTK/libsoup `max-conns-per-host=6` starving long-lived SSE). Extract as
`@papercusp/desktop-ipc` with dispatch injected (a handler fn, not Papercusp's
tool dispatcher) so any Tauri+WebKitGTK app can adopt it.

### D-007 — Population A is publish-work, not extraction-work
Date: 2026-05-29
The libs already in `libs/`+`packages/` (sse, token-kit, host-platform,
docs-engine, file-claim, the React libs, flags) are low/no coupling and largely
done. Treat them as a packaging/publish pass (P-040), not re-architecture.

### D-008 — Keep the harness core in-tree
Date: 2026-05-29
Orchestrator (`libs/papercusp/packages/orchestrator/`, ~2MB), roles/experts,
autoloop/goals, `zero-harness`, and `papercup-shared` are the Papercusp domain
itself; extracting them would just recreate a generic agent runner with none of
the value. The nuqs UI-control surface is a *pattern* to document (already in
`CLAUDE.md`), not a library. `prompt-assembly.ts` is HIGH-coupled (role enum +
agent-mcp catalog) — document the layering pattern, defer extraction until the
tooldef work settles the catalog dependency.
