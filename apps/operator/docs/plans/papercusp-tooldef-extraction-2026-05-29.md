---
title: Extract the endpoint system into @papercusp/tooldef — a standalone, schema-agnostic tool framework
slug: papercusp-tooldef-extraction-2026-05-29
status: draft
created: 2026-05-29
updated: 2026-05-29
owner: pandawamble@gmail.com
companion-to: [endpoint-unification-2026-05-21, endpoint-route-migration-2026-05-20, phase-4-endpoint-system-2026-05-12, principal-rfc-2026-05-20]
---

# Extract the endpoint system into `@papercusp/tooldef`

## Now

**State:** Draft. Design ratified in conversation 2026-05-29: package name
`@papercusp/tooldef`, in-repo monorepo package (separate-repo/publish deferred),
**Standard Schema** for validation (not Zod-locked), no-shim in-place migration.
The investigation confirmed the engine is already ~80% decoupled — the dispatcher
does zero host I/O (`DispatchProjectedDeps` injects all of it) and the core
dispatch/projection files import only *types* from `@papercusp/plugin-sdk`. The
work is: invert the type dependency, replace 6 baked-in business rules with
injected interfaces, swap Zod for Standard Schema, and re-home what's left of
`packages/agent-mcp` as the Papercusp *profile* of the new core.

**Next:** an agent should start Phase 1 (P-001) — scaffold `packages/tooldef`
and move the pure files, with the plugin-sdk type dependency inverted — once a
human has confirmed the Phase-1 file-move map (P-000, needs-human).

## Background

### What the endpoint system already is

`defineTool` (`packages/agent-mcp/src/define-tool.ts`) is a "function-as-truth"
framework: you write one typed `(input, ctx) => ToolResult` function, declare a
manifest (capabilities, roles, quotas, exposure), and the framework projects it
onto HTTP, MCP, IPC, and in-process transports — all through one dispatcher
(`dispatch-projected.ts` → `dispatch-stack.ts`) with uniform auth/role/quota/
timeout/telemetry/streaming behavior. Full design:
`/internal/docs/endpoint-system/{overview,function-as-truth,transports}`.

### Why extraction is cheap (the seams already exist)

The expensive part of framework-extraction — pulling I/O out of logic — is
already done, deliberately:

- **`DispatchProjectedDeps`** (`dispatch-types.ts:88-145`) is the DI surface:
  `readQuotaState`, `recordInvocation`, `overrideTool` — all optional, all
  host-supplied. The file's own header: *"Nothing in this file is host- or
  transport-specific. Everything that does I/O … is threaded in through
  `DispatchProjectedDeps` by the host."*
- **`HttpToolHostExtras`** (`http-projection.ts`) injects `resolvePrincipalAndTx`,
  `withWorkspace`, `validateSuperuser`, `resolveHarnessPaths` — none imported.
- Every `from '@papercusp/plugin-sdk'` in `define-tool / tool-projection /
  dispatch-* / types` is `import type` — only `AgentRole`, `RolesQuota`,
  `ToolResult`. Zero runtime coupling.

### The 6 couplings that remain

| # | Coupling | Where | Move |
|---|---|---|---|
| 1 | Role enum `AgentRole` is a hardcoded union | plugin-sdk; `dispatch-stack.ts`, `tool-projection.ts` | Generic `Role extends string`; ship roles as host **config** |
| 2 | Quota window keying hardcodes worker/chunk, power-user, run | `dispatch-types.ts:19-36` `computeProjectedQuotaWindowKey` | Host-supplied `computeWindowKey(ctx)`; default `run:<id>` |
| 3 | Wire types owned by plugin-sdk | `ToolResult`, `EmitCallback`, `ProgressCallback`, `RolesQuota` | **Invert**: core owns them; plugin-sdk imports from core |
| 4 | Spawn context = `X-Papercusp-*` headers + 7 HMAC-signed URL params | `spawn-context.ts`, transports, orchestrator `spawn-mcp.ts` | Configurable `contextSchema` + `SigningProvider` strategy |
| 5 | Capability → tier business rule | `capability-tiers.ts` | Host-supplied `tierFor(capability)` |
| 6 | Auth tiers (superuser / power-user) | `http-projection.ts`, `superuser-token.ts` | `resolvePrincipal(req) => { principal, bypassGates }` strategy |

Card-correlator, state-channel, and replay-buffer are already in-memory — they
just need their persistence interface exposed with the current impl as the
default.

## End state

Three layers; the current `packages/agent-mcp` splits in two.

```
@papercusp/tooldef             ← PURE engine. zero papercusp/PG/Next/restart deps.
                                 defineTool, registry, dispatch-stack,
                                 dispatch-projected, ctx contract, events,
                                 state-channel, replay-buffer, card-correlator,
                                 ask-user, run lifecycle, openapi assembly.
                                 Role/tier/signing/window-key as INTERFACES.
                                 OWNS ToolResult / Emit / Progress / RolesQuota.
                                 peer dep: a StandardSchemaV1 validator + a
                                 pluggable toJsonSchema adapter.

@papercusp/tooldef-http        ← Web-standard Request→Response adapter + Next shim.
@papercusp/tooldef-mcp         ← mcp-handler bridge.
@papercusp/tooldef-ipc         ← unix-socket / named-pipe adapter.
                                 (thin; all share the one dispatcher)

packages/agent-mcp             ← the Papercusp *profile* of tooldef. Supplies the
(becomes the host adapter)       deps: withWorkspace+tx, recordInvocation →
                                 harness_shared.tool_invocations, the role config
                                 (scoper…curator), the HMAC SigningProvider, the
                                 tier map, superuser/power-user resolvers, the
                                 harness path resolver, the bootstrap import list,
                                 provisioning/auth/server-entry.
```

## Phase 0 — Scope lock (done)

- **P-000** `needs-human` Confirm the Phase-1 file-move map below before any code moves: which `packages/agent-mcp/src/*` files leave for `@papercusp/tooldef` vs stay as the host adapter. → D-001 D-002 D-003

### Phase-1 file-move map (for P-000 sign-off)

**Move to `@papercusp/tooldef` (pure engine):**
`define-tool.ts`, `registry.ts`, `dispatch-projected.ts`, `dispatch-stack.ts`,
`dispatch-types.ts`, `tool-projection.ts`, `replay-buffer.ts`,
`card-correlator.ts`, `state-channel.ts`, `ask-user.ts`,
`workspace-lifecycle.ts` (→ rename concept to `run-lifecycle`),
`capability-tiers.ts` (→ interface + default passthrough),
`define-prompt.ts`, `define-resource.ts`, `prompt-registry.ts`,
`resource-registry.ts`, `openapi-assemble.ts`, `openapi-fragments.ts`,
plus the pure half of `types.ts`. Their `*.test.ts` move with them.

**Stay in `packages/agent-mcp` (host adapter / transports):**
`auth.ts`, `provisioning.ts`, `tool-manifest.ts`, `plugin-events.ts`,
`server.ts`, `server-entry.ts`, `bootstrap.ts`, `define-ui-tool.ts`,
`spawn-context.ts` (the `X-Papercusp-*` parser — core exposes the schema, host
supplies the concrete one), `http-projection.ts` (→ eventually `tooldef-http`).

## Phase 1 — Carve the pure core package

- **P-001** `todo` Scaffold `packages/tooldef` (`@papercusp/tooldef`): `package.json`,
  `tsconfig.build.json`, `src/index.ts`, vitest config mirroring agent-mcp. blocked-by: P-000
- **P-002** `todo` Move the pure files (see map) + their tests; fix relative imports.
  blocked-by: P-001
- **P-003** `todo` **Invert the plugin-sdk type dependency.** Define `ToolResult`,
  `EmitCallback`, `ProgressCallback`, `RolesQuota` in `@papercusp/tooldef`; make
  `@papercusp/plugin-sdk` re-export from it. Per the no-shim rule, this is a clean
  move, not a duplicate. blocked-by: P-002 → D-004
- **P-004** `todo` Strip non-portable deps from core `package.json`:
  remove `@papercusp/host-platform`, `postgres`, `@restart/papercusp-db`. The
  unified ctx already types `tx` as `any`, so PG leaves cleanly. blocked-by: P-002 → D-007
- **P-005** `todo` Make the SSE/event encoder injectable so core drops `@restart/sse`:
  define an `EventSink` interface; the current `@restart/sse` writer becomes the
  host-supplied default. blocked-by: P-002 → D-007

## Phase 2 — Replace the 6 baked rules with injected interfaces

- **P-010** `todo` Genericize role: parameterize the core over `Role extends string`
  (or a `RoleRegistry` config); remove the `AgentRole` import. Papercusp passes its
  9-role config. blocked-by: P-003 → D-005
- **P-011** `todo` Promote `computeProjectedQuotaWindowKey` to a host-supplied
  `computeWindowKey(ctx) => string | null` on `DispatchProjectedDeps`; default
  impl = `run:<runId>`. Move the worker/chunk + power-user logic into the Papercusp
  adapter. blocked-by: P-003 → D-006
- **P-012** `todo` Make `tierFor(capability)` a host-supplied function; core ships an
  identity/`'low'` default. blocked-by: P-003 → D-006
- **P-013** `todo` Define a `SigningProvider` strategy + a configurable `contextSchema`
  for spawn context; core ships a no-op (loopback-only) provider. Papercusp's
  HMAC-over-PG-secret becomes one provider impl. blocked-by: P-003 → D-006
- **P-014** `todo` Define `resolvePrincipal(req) => { principal, bypassGates }`;
  superuser/power-user become host strategies, not core branches. blocked-by: P-003 → D-006
- **P-015** `todo` Expose persistence interfaces for card-correlator / state-channel /
  replay-buffer with the current in-memory impls as defaults. blocked-by: P-003

## Phase 3 — Standard Schema adoption

- **P-020** `todo` Replace `ZodTypeAny` constraints on `args` / `input` / `events` /
  `state` with `StandardSchemaV1`; validate via `~standard.validate`. blocked-by: P-002 → D-002
- **P-021** `todo` Add a pluggable `toJsonSchema` registry — Standard Schema has **no**
  JSON-Schema export, so this is a required separate hook. Ship the Zod adapter
  (wrapping today's `zod-to-json-schema`) as the default; document registering
  Valibot/ArkType. blocked-by: P-020 → D-002
- **P-022** `todo` Thread the `toJsonSchema` adapter through `tools/list`, the events
  discoverability surface, and openapi assembly. blocked-by: P-021
- **P-023** `todo` Keep Zod as the Papercusp host's chosen validator (no churn for the
  ~96 existing tools); only the *core* becomes schema-agnostic. blocked-by: P-020

## Phase 4 — Transport adapters (can run after Phase 1)

- **P-030** `todo` Extract `http-projection.ts` into `@papercusp/tooldef-http` as a
  Web-standard `Request → Response` core (the route-shaped path already is) with a
  thin Next.js shim; agent-mcp consumes the shim. blocked-by: P-005 → D-008
- **P-031** `todo` Extract the `mcp-handler` bridge into `@papercusp/tooldef-mcp`.
  blocked-by: P-005 → D-008
- **P-032** `todo` Extract the IPC adapter into `@papercusp/tooldef-ipc`. blocked-by: P-005

## Phase 5 — Re-home the Papercusp host adapter

- **P-040** `todo` In `packages/agent-mcp`, construct the `DispatchProjectedDeps` +
  `HttpToolHostExtras` from the real impls: `withWorkspace`/`tx`, `recordInvocation`
  → `tool_invocations`, role config, HMAC `SigningProvider`, tier map,
  superuser/power resolvers, harness path resolver. blocked-by: P-010, P-011, P-012, P-013, P-014
- **P-041** `todo` Repoint `bootstrap.ts`, `server-entry.ts`, `provisioning.ts`,
  `auth.ts` at `@papercusp/tooldef`. blocked-by: P-040
- **P-042** `todo` Update `apps/operator` import sites (`@papercusp/agent-mcp` →
  `@papercusp/tooldef` for the engine surface; host surface unchanged). blocked-by: P-041

## Phase 6 — Verification + proof-of-genericity

- **P-050** `todo` All existing suites green: `dispatch-stack.test`, `dispatch-projected.test`,
  `http-projection.test`, `tool-projection.test`, `card-correlator.test`,
  `state-channel.test`, `replay-buffer*.test`, `ask-user.test`, `publish-state.test`,
  `workspace-lifecycle.test`. These are the safety net proving the seam didn't move
  behavior. blocked-by: P-042
- **P-051** `todo` Write a ~40-line standalone example (`packages/tooldef/examples/`)
  that defines a tool and serves it over HTTP+MCP with **zero** `@papercusp/*` /
  `@restart/*` imports — the falsifiable proof of "anyone can use it." blocked-by: P-050
- **P-052** `todo` `README.md` + `TESTING.md` for `@papercusp/tooldef`; update
  `/internal/docs/endpoint-system/*` to point at the package boundary. blocked-by: P-050
- **P-053** `todo` `npm run test:affected:integration` + `npm run lint:knip` clean.
  blocked-by: P-050
- **P-054** `needs-human` Decide whether to promote `@papercusp/tooldef` to a separate
  public repo + neutral npm scope. Out of scope for this arc; gate here. blocked-by: P-051 → D-001

## Open questions

- **Q1 — `@restart/sse` in core.** Proposed: make the event encoder injectable
  (`EventSink`) so core has zero `@restart` deps (P-005). Alternative: vendor the
  ~150-line SSE writer. Decided toward "injectable" in D-007; confirm during P-005.
- **Q2 — Telemetry DDL.** `recordInvocation` is already a no-op-able callback, so
  core ships nothing. Should we publish an optional `@papercusp/tooldef-telemetry-pg`
  with the `tool_invocations` DDL, or leave persistence entirely to consumers?
  Deferred to the publish decision (P-054).
- **Q3 — Principal shape.** The core `principal` is currently
  `{ slug, workspaceId, capabilities }`. For a generic lib, is `workspaceId`
  core or host? Lean: keep a generic `tenantId?` slot in core, map
  `workspaceId → tenantId` in the adapter. Resolve during P-014.

## Decisions

### D-001 — Name, scope, home
Date: 2026-05-29
Package is **`@papercusp/tooldef`**, an in-repo monorepo package. The `@papercusp`
scope is the home; republishing under a neutral scope if it ever goes public is a
later, separate call (P-054) and doesn't change the seam. User decision, 2026-05-29.

### D-002 — Standard Schema, not Zod-locked
Date: 2026-05-29
Core accepts any `StandardSchemaV1` validator (Zod 3.24+, Valibot, ArkType). User
decision, 2026-05-29. **Consequence:** Standard Schema has no JSON-Schema export,
so JSON-Schema generation (needed for `tools/list` / openapi) is a *separate*
pluggable `toJsonSchema` adapter (P-021), shipped with a default Zod adapter. The
Papercusp host keeps Zod for its ~96 tools (D-002 only generalizes the core, not
the consumers).

### D-003 — No shims, in-place migration
Date: 2026-05-29
Per the repo policy (no production, no users, no deprecation aliases): move files
and invert dependencies in place across one arc. No `@papercusp/agent-mcp`
back-compat re-export layer; update import sites directly (P-042).

### D-004 — Core owns the wire types
Date: 2026-05-29
`ToolResult`, `EmitCallback`, `ProgressCallback`, `RolesQuota` move to
`@papercusp/tooldef`; `@papercusp/plugin-sdk` re-exports them. The dependency
direction was already type-only and one-way (plugin-sdk → consumed by core); we
invert it so the framework, not a plugin SDK, is the type authority.

### D-005 — Role is generic/config, not a baked union
Date: 2026-05-29
The core is parameterized over `Role extends string` (or a `RoleRegistry` config
object). Papercusp's 9-role set (scoper, architect, worker, validator, reviewer,
debugger, operator, documenter, curator) becomes adapter config, not a core enum.

### D-006 — Host-injected business rules
Date: 2026-05-29
Four Papercusp-specific rules become functions on the DI surface, each with a
sensible core default: quota window keying (`computeWindowKey`, default
`run:<id>`), capability→tier (`tierFor`, default `'low'`), spawn-context signing
(`SigningProvider`, default no-op/loopback), and principal resolution
(`resolvePrincipal`, default bearer-or-none). Papercusp supplies the real impls in
Phase 5.

### D-007 — Core has zero `@papercusp`/`@restart`/PG deps
Date: 2026-05-29
`@papercusp/host-platform`, `postgres`, and `@restart/papercusp-db` leave the core
package outright (the unified ctx already types `tx` as `any`). The `@restart/sse`
writer becomes an injectable `EventSink` with the current writer as the
host-supplied default, so core depends on no Restart/Papercusp package. Confirm the
injectable-vs-vendor call during P-005 (Q1).

### D-008 — Transports are Web-standard core + framework shims
Date: 2026-05-29
The dispatcher is already framework-free and route-shaped tools already use
Web-standard `Request → Response`. The HTTP adapter's core (`@papercusp/tooldef-http`)
is Web-standard; Next.js/Hono/Express are thin shims on top. The MCP adapter keeps
Vercel's `mcp-handler` (rebuilding the MCP transport is weeks for no win — see
`/internal/docs/endpoint-system/function-as-truth` §"Why we kept mcp-handler").

## Verification

Each phase is provable against the existing test suites (P-050) — they're already
deps-injected, so a correct seam-move leaves them green without edits. The
falsifiable end-state check is P-051: a standalone example with zero `@papercusp/*`
imports compiling and serving a tool. Run `npm run test:affected` after each phase;
`npm run test:all:integration` is not required unless a phase touches
`libs/papercusp/libs/db/**` (none do — core sheds PG).
