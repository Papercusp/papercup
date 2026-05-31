---
title: Extract the endpoint system into @papercusp/tooldef — a standalone, schema-agnostic tool framework
slug: papercusp-tooldef-extraction-2026-05-29
status: active
created: 2026-05-29
updated: 2026-05-30
owner: pandawamble@gmail.com
companion-to: [endpoint-unification-2026-05-21, endpoint-route-migration-2026-05-20, phase-4-endpoint-system-2026-05-12, principal-rfc-2026-05-20]
---

# Extract the endpoint system into `@papercusp/tooldef`

## Now

**State:** Phase 1 (carve the pure core) **shipped** 2026-05-29. **Phase 2 core
decoupling is complete** as of 2026-05-30 — P-010, P-011, P-012, **P-014** shipped;
**P-013** re-scoped to Phase 4 and **P-015** deferred (rationale below). The engine
now carries no Papercusp role / quota / tier / auth-tier knowledge.
- **P-010** (role): augmentable `RoleRegistry` seam + host role config
  (`agent-mcp/src/role-config.ts`) + `ToolContext<Tx>`.
- **P-011** (quota): host-injected `computeQuotaWindow(ctx, roleQuota) => { key,
  limit }` (`agent-mcp/src/quota-policy.ts`) — engine lost `'worker'`/`'chunk:'`/`perChunk`.
- **P-012** (tiers): pluggable `setCapabilityTierResolver` (engine default `'low'`);
  table → `agent-mcp/src/capability-tiers-papercusp.ts`.
- **P-014** (auth tiers): the dispatcher's role/capability/quota gates read a neutral
  `ctx.gateBypass` (`{ role?, capability?, quota? }`); the superuser/power-user→bypass
  matrix moved to `agent-mcp/src/gate-bypass.ts` (`papercuspGateBypass`), set by the
  HTTP + MCP transports. Engine no longer reads `isSuperuser`/`isPowerUser` for gating.

Verified across all four: tooldef typecheck clean + **191** tests; agent-mcp typecheck
19 errors (pre-existing baseline — **0 new, 0 lost**) + **111 pass / 1 pre-existing
fail**. See the **Progress log** (2026-05-30) for design rationale + follow-ups.

**Phase 3 is COMPLETE as of 2026-05-30 — the core is no longer Zod-locked (D-002).**
- **P-021 + P-022**: schema→JSON-Schema is pluggable (`schema-adapter.ts`:
  `setJsonSchemaAdapter`/`toJsonSchema`, default Zod); all five core conversion
  callsites route through it.
- **P-020**: tool `args`/`input`, card `dataSchema`, and `state` are now typed
  `StandardSchemaV1` (any validator — Zod 3.24+, Valibot, ArkType) and validated via
  `~standard.validate`, not `.safeParse`. New `standard-schema.ts` (`standardValidate`
  async / `validateSync` Promise-guard for `publishState` / `formatIssues`). Zod schemas
  satisfy `StandardSchemaV1` and `InferOutput ≡ z.infer`, so the ~96 host tools compile
  unchanged. **Scoped exceptions (documented):** `RouteDefinition` stays Zod (routes are
  validated host-side by `registerRoute`, which P-020 doesn't touch) and `EventsSchema`
  stays Zod (event wire-classification needs schema introspection — `classifyEventWire`'s
  `_def`/binary probe — that Standard Schema's `validate()` can't expose).
- **P-023**: the host keeps Zod for all its tools (zero churn) — satisfied by default.

**Verified (whole arc + P-020):** tooldef tsc **0** + **202 tests** (incl. a hand-rolled
non-Zod `StandardSchemaV1` validator proof — `standard-schema.test.ts`); agent-mcp tsc
**19 = baseline** + **113 tests**; operator tsc **0 new errors** (proven via a targeted
stash baseline — the 3 `routes/index.ts` cast errors are pre-existing, identical at HEAD);
standalone example still runs.

**Phase 4 (transports) is substantially done 2026-05-30:** **P-030** extracted HTTP →
`@papercusp/tooldef-http`; **P-032** was already a package (`@papercusp/ipc-endpoint-server`).
**P-031** (the MCP bridge) is the one remaining item and is **runtime-gated** — its source
(`_mcp-handler.ts`) is the 865-line auth/spawn gateway (superuser/power-user admission +
HMAC `verifySpawnParams`, the P-013 `SigningProvider`); it's the main agent-spawn path, so
extraction must be done with the operator running to verify the auth path, not on a
typecheck alone (see P-031).

**Phase 5 (re-home) is already satisfied:** P-040 done (deps already wired from real impls —
`PROJECTED_DEPS` + route-site `HttpToolHostExtras`); P-041/P-042 are `optional` per D-010
(the agent-mcp re-export is a fine permanent arrangement).

**Next / remaining:** **P-031** (runtime-gated, above); **Phase 6** wrap-up — P-052 docs
(overview done; other endpoint-system pages are low-priority touch-ups), P-053 (knip /
affected-integration clean), P-054 (needs-human: the in-tree-vs-mirror fork). Follow-up:
generic `Tx` on `UnifiedToolContext`; `isSuperuser`/`isPowerUser` remain host ctx *metadata*.

> ℹ️ **Resolved 2026-05-30:** the `@papercusp/chat-protocol` build break (from commit
> `4a5ac215`) was the submodule's `package.json` declaring its entry only via `exports`
> (no top-level `main`/`types`), unresolvable under classic `moduleResolution: node`.
> Fixed by adding `main`/`types` to the submodule (pushed `916861f`) + bumping the pin
> (`f41566f5`). tooldef tsc is back to 0 baseline errors.

## Progress log

### 2026-05-30 — P-030 shipped + P-032 found-done (Phase 4 begun: HTTP + IPC extracted)

New package **`@papercusp/tooldef-http`** (`packages/tooldef-http`): `http-projection.ts`
moved out of agent-mcp (`git mv`, history-preserving). The adapter had exactly two host
couplings: it called `papercuspGateBypass` (agent-mcp) and imported `AgentRole` from
plugin-sdk — everything else (principal resolution, workspace tx, harness paths,
superuser admission, quota/telemetry) was *already* injected via `HttpToolHostExtras`.
Inlined the superuser→gateBypass mapping (`isSuperuser ? {role,capability,quota:true} :
undefined` — identical to `papercuspGateBypass({isSuperuser})` since HTTP has no
power-user tier) and repointed `AgentRole` to the core, so the package depends only on
`@papercusp/tooldef` + `@papercusp/sse`. `agent-mcp/index.ts` re-exports the surface from
the new package (D-010 style) → operator's 3 consumer sites (all importing from
`@papercusp/agent-mcp`) are untouched. Recipe: src-as-entry pkg + `node_modules/@papercusp/tooldef-http`
symlink + top-level `main`/`types` (so it resolves under agent-mcp's classic `moduleResolution: node`).

**P-032 was already satisfied** — the IPC adapter has long been its own package
(`@papercusp/ipc-endpoint-server`), consuming the engine via `dispatchProjectedToolStream`.

**Verified:** tooldef-http tsc 0 + 3 standalone smoke tests (no agent-mcp deps — proves
the adapter routes/dispatches with an empty DI surface); agent-mcp tsc 19 = baseline +
113 tests (the moved adapter's superuser/bearer/quota-429 integration test stays in
agent-mcp and passes against `@papercusp/tooldef-http`); operator tsc 599 = baseline,
**0 new** (transparent re-export). **P-031** (the operator-coupled, auth-critical
mcp-handler bridge) is the remaining Phase-4 item.

### 2026-05-30 — P-020 shipped (Standard Schema; Phase 3 complete, core not Zod-locked)

Files: `packages/tooldef/src/{standard-schema.ts (new),standard-schema.test.ts (new),
types,define-tool,tool-projection,dispatch-stack,card-correlator,index}.ts` +
`package.json`; host: `packages/agent-mcp/src/{define-ui-tool,server}.ts`.

**De-risked first.** A throwaway type probe confirmed the make-or-break: a Zod schema
satisfies `StandardSchemaV1` and `StandardSchemaV1.InferOutput<ZodSchema> ≡ z.infer` —
so swapping `args: ZodTypeAny` → `args: StandardSchemaV1` wouldn't break the ~96 host
tools' handler-arg inference. (`@standard-schema/spec` is installed; Zod 4.4 implements
`~standard`.)

**Shipped:** tool `args`/`input`, card `dataSchema`, and `state` are typed
`StandardSchemaV1` and validated via `~standard.validate`. `standard-schema.ts` adds
`standardValidate` (async; for the already-async define-tool fn wrappers + agent-mcp
`server.ts`), `validateSync` (a Promise-guard for the fire-and-forget `publishState`
and the sync card-response handler — throws loudly if a host plugs in an async
validator on those paths), and `formatIssues`. Host adapters `define-ui-tool.ts` +
`server.ts` adopted the same. Two internal storage callsites needed an explicit
cast-through-`unknown` (`register`, the card map) because a specific `TArgs` isn't
assignable to the `unknown`-output base under Standard Schema's variance — this
worked under Zod only because `z.infer<ZodTypeAny>` is `any`.

**Scoped exceptions (deliberate, documented in the Now block):** `RouteDefinition`
(host-validated routes) and `EventsSchema` (wire-classification needs Zod `_def`/binary
introspection) stay Zod.

**Verified:** tooldef tsc 0 + 202 tests (the new `standard-schema.test.ts` proves a
hand-rolled non-Zod validator works end-to-end through `standardValidate`/`validateSync`
— sync, async, and the Promise-guard); agent-mcp tsc 19 = baseline + 113 tests; operator
tsc **0 new** — confirmed rigorously by stashing only the P-020 files and re-running the
full operator typecheck: the 3 `routes/index.ts` cast errors are present identically at
HEAD (pre-existing; P-020 only renamed the displayed type param), and the operator total
actually fell 615→599 from other agents' concurrent fixes.

### 2026-05-30 — P-021 + P-022 shipped (pluggable JSON-Schema adapter; Phase 3 begun)

Files: `packages/tooldef/src/{schema-adapter.ts (new),define-tool,card-correlator,
openapi-fragments,tool-projection,index}.ts`. tooldef-only — no host change.

Standard Schema (P-020's target validator interface) has no JSON-Schema export, so
schema→JSON-Schema is a separate pluggable concern (D-002). Added `schema-adapter.ts`
— a module-level resolver (`setJsonSchemaAdapter` / `toJsonSchema`) mirroring the
P-012 `tierFor` pattern — with the **default** being Zod 4's `toJSONSchema`
(`zodJsonSchemaAdapter`). Because the default is Zod, behavior is byte-identical and
no host registration is needed yet; a Valibot/ArkType host calls
`setJsonSchemaAdapter` at startup.

Routed all five core conversion sites through it (P-022): `defineTool` inputSchema
(principal- + role-gated paths), the `tools/list` events-schema cache and
`classifyEventWire` (tool-projection), card open-snapshots (card-correlator), and
openapi fragments. The `import { z }` *value* import is now gone from define-tool,
card-correlator, openapi-fragments, and tool-projection — they keep only
`import type { ZodTypeAny }` (+ `.safeParse` method calls, which P-020 removes).

**Pulled P-021 ahead of P-020** (the plan had it blocked-by P-020) because it's
cleanly separable, behavior-preserving, and a prerequisite enabler — P-020's type
swap needs the adapter in place so non-Zod schemas still get JSON-Schema generation.
P-020 itself (the `ZodTypeAny`→`StandardSchemaV1` + `safeParse`→`~standard.validate`
swap) is the atomic, intricate remainder — left for a focused pass.

**Verified:** tooldef 191/191 tests; P-021's files tsc-clean (the only tooldef tsc
errors are 2 pre-existing ones from commit `4a5ac215`'s `@papercusp/chat-protocol`
import of a package that doesn't exist yet — unrelated, not reverted).

### 2026-05-30 — P-014 shipped + P-013/P-015 re-scoped (Phase-2 core decoupling complete)

Files: `packages/tooldef/src/{tool-projection,dispatch-stack,index}.ts` +
`dispatch-projected.test.ts`; `packages/agent-mcp/src/{gate-bypass.ts (new),
http-projection.ts,index.ts}`; `apps/operator/lib/endpoint-route/routes/transport/_mcp-handler.ts`.

**Extraction reality reframed P-013/P-014.** The plan's pre-extraction "6 couplings"
table assumed signing + principal resolution lived in the core. They don't: Phase 1
kept `http-projection.ts`, `spawn-context.ts`, principal resolution
(`resolvePrincipalAndTx`), and HMAC signing entirely **host-side** in agent-mcp. So:

- **P-014 (shipped)** — the *only* residual auth coupling in the engine was three
  dispatch gates reading `ctx.isSuperuser`/`ctx.isPowerUser`. Replaced with a neutral
  `ctx.gateBypass: { role?, capability?, quota? }` the engine reads; the
  superuser/power-user→bypass matrix moved to `agent-mcp/src/gate-bypass.ts`
  (`papercuspGateBypass`). Wired at the two real dispatch transports only —
  `http-projection.ts` (superuser) and `_mcp-handler.ts`'s `buildMcpToolContext`
  (all tiers, computed once from `spawn.isSuperuser/isPowerUser`). **Fail-closed**:
  absent `gateBypass` ⇒ every gate enforces. Audited the other dispatch sites —
  the `{}`-deps streaming sites (operator-converse, oracle, …) set no `isSuperuser`
  and dispatch ungated/principal-less ctxs; the `_audit-write`/`_smoke` scripts call
  `tool.handler` directly (no dispatcher) — so none needed changes. Mapping verified
  identical to the old baked logic at every site. `isSuperuser`/`isPowerUser` stay as
  host ctx *metadata* (profile resolution, agent_tools:list, docs adapters).
- **P-013 (re-scoped → Phase 4)** — signing is *already* host-side; the core has zero
  signing code, so a `SigningProvider`/`contextSchema` interface has no core consumer
  today. It belongs with the transport extraction (P-030, `@papercusp/tooldef-http`),
  where a Web-standard adapter actually needs a pluggable verifier. Folded there;
  not a punt (see Open questions / D-006).
- **P-015 (deferred)** — the card-correlator / state-channel / replay-buffer already
  ship working in-memory defaults, so the core is fully standalone-usable without a
  persistence interface (the P-051 falsifiable test needs nothing here). Exposing a
  swappable persistence seam with **no consumer** is speculation the repo ethos says
  to avoid ("don't build for a future not yet built"). Do it when a host actually
  needs durable cards/state.

**Verified:** tooldef typecheck clean + **191** tests (+3 gateBypass cases — role,
capability, quota each bypassed only with the flag); agent-mcp typecheck 19 = baseline
+ 111 pass / 1 pre-existing fail (http-projection 429/403 auth tests still green);
operator full typecheck **615 errors = pre-existing baseline, 0 new** (gateBypass /
`_mcp-handler` clean — confirms the P-011/P-012/P-014 operator touches added nothing).

### 2026-05-30 — P-012 shipped (capability tiers → injectable resolver)

Third Phase-2 item. Files: `packages/tooldef/src/{capability-tiers,index}.ts`;
`packages/agent-mcp/src/{capability-tiers-papercusp.ts (new),index.ts,vitest.config.ts}`,
`src/__tests__/{define-tool.test.ts,test-setup.ts (new)}`.

**The wrinkle vs. the other seams: `tierFor` runs at module-load, not per-request.**
`defineTool`/`defineResource`/`definePrompt` stamp `def.tier = tierFor(capability)`
eagerly at registration, so this can't be a `DispatchProjectedDeps` (per-dispatch)
injection like P-011 — the resolver must be registered *before* any tool
self-registers. Solved with a module-level resolver in the engine
(`setCapabilityTierResolver`, default `() => 'low'`) and a load-time registration in
the host: `agent-mcp/src/capability-tiers-papercusp.ts` exports `papercuspTierFor`
(the moved EXACT/PREFIX table, `'medium'` fallback) and calls
`setCapabilityTierResolver(papercuspTierFor)` on import. That import sits at the
**top of `agent-mcp/index.ts`, above `bootstrap`** — robust because (verified) all
186 operator tools import `defineTool` from `@papercusp/agent-mcp` (so the full
index, incl. this registration, evaluates before their `defineTool` runs), and
agent-mcp's own 27 tools load via `bootstrap` (imported last). `tier` is descriptive
metadata — the dispatcher does **not** gate on it — so the worst case of a missed
registration is a wrong descriptive tier, never a security gap.

**Tests:** the `tierFor` table cases moved to assert `papercuspTierFor` directly in
`define-tool.test.ts`. Three agent-mcp test files (`define-tool`, `dispatch`,
`prompts`) assert tier stamping via `defineTool`/`definePrompt`; rather than scatter
side-effect imports, a vitest `setupFiles` (`__tests__/test-setup.ts`) registers the
host resolver for every agent-mcp test — mirroring production, where importing the
package always activates it. tooldef 188/188 (engine default `'low'`, no tier
assertions there); agent-mcp 111 pass / 1 pre-existing fail; typecheck 19 = baseline.

### 2026-05-30 — P-011 shipped (quota windowing → host-injected)

Second Phase-2 item. Files: `packages/tooldef/src/{dispatch-types,dispatch-stack,
dispatch-projected,index}.ts` + `dispatch-projected.test.ts`;
`packages/agent-mcp/src/{quota-policy.ts (new),quota-policy.test.ts (new),index.ts,
http-projection.test.ts}`; `apps/operator/lib/projected-tool-deps.ts`;
`apps/operator/lib/endpoint-route/routes/transport/_mcp-handler.ts` (comment).

**Design — one `computeQuotaWindow(ctx, roleQuota) => { key, limit }` seam, not the
plan's sketched `computeWindowKey(ctx) => string | null`.** Found that the window
key and the ceiling are inseparable: the worker→`chunk:`/`perChunk` vs.
everyone-else→`run:`/`perRun` choice is one decision, and a `string`-only return
can't carry the limit — which would have left the `role === 'worker' ? perChunk :
perRun` branch baked in the core. Returning `{ key, limit }` moves *both* out, so the
engine no longer references `'worker'`, `'chunk:'`, `'power-user:'`, or the
`perChunk`/`perRun` field names at all (it treats `RolesQuota` opaquely, passing it
to the host policy). The window key also feeds telemetry (`recordInvocation`), so the
seam is resolved once in `initExecution` for every call — quota'd or not.

Verified the universal convention that makes the split clean: across all ~30
`rolesQuota` declarations, `worker` only ever sets `perChunk` and every other role
only `perRun` — never both.

**Shipped:**
- **Core** `dispatch-types.ts`: deleted `computeProjectedQuotaWindowKey`; added the
  `QuotaWindow` type + `defaultComputeQuotaWindow` (run-scoped, `perRun`) + the
  optional `computeQuotaWindow` dep on `DispatchProjectedDeps`.
- **Core** `dispatch-stack.ts`: `initExecution` resolves `{ windowKey, quotaLimit }`
  via `deps.computeQuotaWindow ?? defaultComputeQuotaWindow`; the quota step enforces
  `count >= quotaLimit` with no role/field knowledge. (`AgentRole` is still imported
  for the role-allowlist step — unrelated to quota.)
- **Host** `agent-mcp/src/quota-policy.ts` (new): `papercuspComputeQuotaWindow`
  carries the worker/chunk + power-user/session + run logic verbatim; exported from
  `agent-mcp/index.ts` and wired into `PROJECTED_DEPS.computeQuotaWindow`.
- **Safety:** the only dispatch sites that observe the window key are the
  `PROJECTED_DEPS` ones (quota + telemetry); the `{}`-deps streaming sites
  (operator-converse, oracle, …) compute it but never read it, so the core-default
  change is a no-op there. Worker/power-user quotas all flow through `PROJECTED_DEPS`.

**Tests:** the 5 `computeProjectedQuotaWindowKey` cases moved to
`agent-mcp/src/quota-policy.test.ts` (now testing the host impl, + limit assertions);
the core keeps `defaultComputeQuotaWindow` tests + a new "honors a host-supplied
computeQuotaWindow" e2e case; the HTTP-transport 429 test now supplies the real
`papercuspComputeQuotaWindow` (proves the policy reaches the HTTP path). tooldef
188/188; agent-mcp 111 pass (+6) / 1 pre-existing fail.

**Follow-up:** the `isSuperuser && !isPowerUser` quota *bypass* still lives in the
core quota step (reads core ctx auth flags) — that's auth-tier territory (P-014),
not window keying, so it stayed.

### 2026-05-30 — P-010 shipped (role genericization + ToolContext<Tx>)

First Phase-2 item. Files: `packages/tooldef/src/{host-types,types,index}.ts`,
`packages/agent-mcp/src/{role-config.ts (new),index.ts}`,
`packages/plugin-sdk/src/index.ts`.

**Design decision — `RoleRegistry` config object, NOT a threaded `<Role>` generic.**
D-005 left both open; chose the config-object arm for concrete reasons found in the
code:
- Roles **must** stay `string`-assignable. Plugins register arbitrary custom roles
  at runtime (`apps/operator/lib/role-registry.ts` is fully dynamic; plugin-sdk's old
  union used `(string & {})`), so a *closed* union is impossible.
- A threaded `<Role extends string = string>` param would default to `string` at all
  ~601 `defineTool` consumers (none would ever pass it), delivering **zero**
  host-config benefit for large type-noise — and the core-defined fields
  (`ToolDefinition.roles`, `byRole`, `rolesQuota`) can't pick up host suggestions from
  a generic the host never specifies.
- The augmentation pattern (the TanStack `Register` / i18next `CustomTypeOptions`
  idiom) lets the host register roles **once**; that shapes the core-defined fields'
  autocomplete program-wide while staying `string`-assignable, and falls back to bare
  `string` for any consumer that registers nothing (the standalone P-051 example).

**Shipped:**
- **Core** (`host-types.ts`): `AgentRole = string` → an augmentable
  `export interface RoleRegistry {}` + `AgentRole = [RegisteredRole] extends [never] ?
  string : RegisteredRole | (string & {})`. `RoleRegistry` exported from `index.ts`.
- **Core** (`types.ts`): `ToolContext` → `ToolContext<Tx = any>` with `tx: Tx`
  (D-009's "generic Tx rides with it"). Default `any` keeps the ~601 `ctx.tx.<…>()`
  consumers green; a host binds `ToolContext<SqlClient>` for a checked `tx`.
- **Host** (`agent-mcp/src/role-config.ts`, new): `declare module '@papercusp/tooldef'
  { interface RoleRegistry extends Record<BuiltinAgentRole, true> {} }`, the
  augmentation *derived from* a single runtime `AGENT_ROLES` const (19 built-in roles,
  the real working set grepped from tool `roles:`/`byRole` usage — pipeline + chat +
  cross-cutting expert roles). Re-exported from `agent-mcp/index.ts` (exporting the
  value pulls the augmentation into the program).
- **plugin-sdk**: deleted its hand-maintained 7-role union (stale — missing
  `documenter`/`curator`, with an "update both when canonical changes" drift comment)
  and re-exports the core's `AgentRole`. plugin-sdk is now role-set-agnostic; the host
  owns the role config (the plan's end-state).

**Verified:** tooldef `tsc` clean + **188/188** tests; agent-mcp `tsc` **19** errors
(identical set to the pre-P-010 baseline — diffed line-by-line, **0 new, 0 resolved**)
+ **105 pass / 1 fail** (the documented pre-existing `prompts.test` collision case —
untouched by this change). Cross-module augmentation merge proven with a throwaway
type probe (`keyof RoleRegistry` resolves to the built-in union in the host program,
not `never` and not widened-to-`string`), then deleted.

**Follow-ups (none blocking):**
- `UnifiedToolContext.tx` (the dispatch-path ctx in `tool-projection.ts`) is still
  `any` — only the legacy `ToolContext` got the `<Tx>` param. Threading `Tx` through
  `UnifiedToolContext` → `ProjectedTool` → `ToolFn` → dispatch is a larger, separate
  change; deferred.
- `apps/operator/lib/prompt-assembly.ts`'s local `Role` union (10 roles) is a separate
  hand-kept list with its own "mirrors AGENT_ROLES / update both" comment — a candidate
  to point at `AGENT_ROLES`, but it deliberately avoids dragging a workspace-aware enum
  into the prompt layer. Left as-is.
- `role === 'worker'` / power-user quota branching in `dispatch-stack.ts` +
  `computeProjectedQuotaWindowKey` is still baked — that's P-011's job, not P-010's.

### 2026-05-29 — Phase 1 shipped (P-000…P-005)

Commits `9b1620b2`, `8f3c950a` (both on `main`, committed via scoped pathspec in a
shared multi-agent checkout). Every edit was lock-claimed via `locks:*`.

**Shipped:**
- **P-000** gate cleared by the user ("do it on main, use the locking system").
- **P-001** `packages/tooldef` scaffolded (package.json, tsconfig(.build), vitest
  config, README) — **zero** runtime deps.
- **P-003** wire types (`ToolResult` / `RolesQuota` / `ProgressCallback` /
  `EmitCallback`) now owned by tooldef; `@papercusp/plugin-sdk` imports + re-exports
  them (type-only, erased at runtime; local defs deleted — no shim, per D-003).
- **P-002** engine moved (30 files via `git mv`, history preserved): defineTool /
  defineResource / definePrompt, registry + projected-tool registry, dispatch-stack
  / -projected / -types, tool-projection, state-channel, card-correlator,
  replay-buffer, workspace-lifecycle, capability-tiers, openapi-assemble /
  -fragments, core types. 48 internal relative imports + 1 dynamic import + 2
  external `/tool-projection` consumers repointed to `@papercusp/tooldef`; 3 dead
  subpath exports dropped. agent-mcp re-exports the engine (D-010).
- **P-004** done implicitly: tooldef has **zero** `dependencies` — `postgres`,
  `@papercusp/host-platform`, `@restart/*` never entered it (verified: no
  papercusp/restart/postgres import in tooldef source *or* tests). The legacy
  `ToolContext.tx` was widened to `any` to shed `postgres` (D-009).
- **P-005** the core is already `@restart/sse`-import-free (tool-projection uses the
  existing `MinimalEventSink` seam). A formal standalone `EventSink` host-injection
  interface is **not** yet broken out; treating the "core drops @restart/sse" goal
  as met and folding the formal interface into Phase 4. The live-SSE integration
  test (`replay-buffer-live.test.ts`) was moved **back** to agent-mcp since it
  exercises the HTTP transport, not the core.

**Deviations from the original P-000 file-move map:**
- `ask-user.ts` does not exist as a source file — the `ctx.askUser` impl lives in
  card-correlator/state-channel; only `ask-user.test.ts` moved.
- `workspace-lifecycle.ts` kept its name (the "→ run-lifecycle" rename is deferred,
  cosmetic).
- `capability-tiers.ts` moved as-is; converting `tierFor` to a host-injected
  function is Phase 2 (P-012), not done in the move.
- `http-projection.test.ts` and `plugin-events.test.ts` stayed with their host
  source files (they test host modules, not the engine).

**Drive-by fixes** (pre-existing errors that rode in with the moved files — this is
why the agent-mcp typecheck baseline dropped 22 → 20):
- `replay-buffer.ts`: exported `ReplayBufferWriter` (was a dangling `TS2305` import
  in `dispatch-stack.ts`).
- `define-tool.ts`: `as unknown as` on the legacy-ctx principal cast (`TS2352`).

**Known follow-ups (none blocking; tracked here):**
- Declare `zod` (+ `zod-to-json-schema`) in `tooldef/package.json` — resolves via
  workspace hoist today; folds into Phase 3 when Standard Schema lands.
- Declare `@papercusp/tooldef` in `apps/operator/package.json` — resolves via hoist.
- Move `replay-buffer-live.test.ts` into the http-adapter package in Phase 4.
- Pre-existing failing test `prompts.test "rejects collision on duplicate name"`
  (proven pre-existing: `prompt-registry.ts`/`define-prompt.ts` byte-identical to
  HEAD; test differs from HEAD only in import specifiers). Decide separately whether
  to fix the test or the same-capability HMR-replace logic in `registerPrompt`.

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

- **P-000** `done` Confirm the Phase-1 file-move map below before any code moves: which `packages/agent-mcp/src/*` files leave for `@papercusp/tooldef` vs stay as the host adapter. Cleared by user 2026-05-29 ("do it on main"). → D-001 D-002 D-003

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

- **P-001** `done` Scaffold `packages/tooldef` (`@papercusp/tooldef`): `package.json`,
  `tsconfig.build.json`, `src/index.ts`, vitest config mirroring agent-mcp. Commit `9b1620b2`. blocked-by: P-000
- **P-002** `done` Move the pure files (see map) + their tests; fix relative imports.
  30 files via `git mv`; 48 internal + 1 dynamic + 2 external consumers repointed. Commit `8f3c950a`. blocked-by: P-001
- **P-003** `done` **Invert the plugin-sdk type dependency.** Define `ToolResult`,
  `EmitCallback`, `ProgressCallback`, `RolesQuota` in `@papercusp/tooldef`; make
  `@papercusp/plugin-sdk` re-export from it. Per the no-shim rule, this is a clean
  move, not a duplicate. Commit `9b1620b2`. blocked-by: P-002 → D-004
- **P-004** `done` Strip non-portable deps from core `package.json`:
  `@papercusp/host-platform`, `postgres`, `@restart/papercusp-db` never entered
  tooldef (`dependencies: {}`); legacy ctx `tx` widened to `any`. blocked-by: P-002 → D-007 D-009
- **P-005** `wip` Core is already `@restart/sse`-import-free via the existing
  `MinimalEventSink` seam (goal met). A formal standalone `EventSink` host-injection
  interface is **not** yet broken out — folded into Phase 4 (P-030). The live-SSE
  test moved back to agent-mcp. blocked-by: P-002 → D-007

## Phase 2 — Replace the 6 baked rules with injected interfaces

- **P-010** `done` Genericize role: the core exposes an augmentable `RoleRegistry`
  config object (chosen over a threaded `<Role>` generic — see Progress log
  2026-05-30); `AgentRole` resolves to the host's registered roles as a
  `string`-assignable suggestion-union, or bare `string` when unaugmented. Papercusp
  registers its built-in roles in `packages/agent-mcp/src/role-config.ts`
  (`AGENT_ROLES`). `ToolContext<Tx = any>` rides along (D-009). plugin-sdk's stale
  union deleted in favor of re-exporting the core seam. Shipped 2026-05-30.
  blocked-by: P-003 → D-005
- **P-011** `done` Promoted `computeProjectedQuotaWindowKey` to a host-supplied
  seam on `DispatchProjectedDeps` — landed as `computeQuotaWindow(ctx, roleQuota) =>
  { key, limit }` rather than `computeWindowKey(ctx) => string | null` (window key
  and ceiling are inseparable; the richer return also un-bakes the
  `role === 'worker' ? perChunk : perRun` branch — see Progress log 2026-05-30).
  Core default = run-scoped/`perRun` (`defaultComputeQuotaWindow`); the
  worker/chunk + power-user logic moved to `agent-mcp/src/quota-policy.ts`
  (`papercuspComputeQuotaWindow`), wired into `PROJECTED_DEPS`. Shipped 2026-05-30.
  blocked-by: P-003 → D-006
- **P-012** `done` `tierFor` is now a pluggable module-level resolver
  (`setCapabilityTierResolver`); the engine default classifies everything `'low'`.
  The Papercusp table moved to `agent-mcp/src/capability-tiers-papercusp.ts`
  (`papercuspTierFor`, `'medium'` fallback) and registers itself on import, wired in
  at the top of `agent-mcp/index.ts` before `bootstrap` (registration must precede
  tool self-registration since `tier` is stamped eagerly — see Progress log
  2026-05-30). Shipped 2026-05-30. blocked-by: P-003 → D-006
- **P-013** `deferred→P-030` Define a `SigningProvider` strategy + configurable
  `contextSchema`. Re-scoped to Phase 4 (transport extraction) 2026-05-30: signing +
  spawn-context parsing are already entirely host-side (`spawn-context.ts`,
  orchestrator) — the core has **no** signing code, so the interface has no core
  consumer until the Web-standard HTTP adapter (`@papercusp/tooldef-http`, P-030)
  needs a pluggable verifier. Folded into P-030. blocked-by: P-003 → D-006
- **P-014** `done` De-baked the superuser/power-user auth tiers from the engine. The
  dispatch role/capability/quota gates now read a neutral `ctx.gateBypass`
  (`{ role?, capability?, quota? }`, fail-closed when absent); the tier→bypass matrix
  moved to `agent-mcp/src/gate-bypass.ts` (`papercuspGateBypass`), set by the HTTP +
  MCP transports. (Principal *resolution* was already host-side since Phase 1 —
  `HttpToolHostExtras.resolvePrincipalAndTx` — so only the gate-bypass branches
  remained in core.) `isSuperuser`/`isPowerUser` stay as host ctx metadata. Shipped
  2026-05-30. blocked-by: P-003 → D-006
- **P-015** `deferred` Expose persistence interfaces for card-correlator /
  state-channel / replay-buffer. Deferred 2026-05-30: the in-memory defaults already
  make the core standalone-usable (nothing in P-051 needs swappable persistence);
  exposing a seam with no consumer is speculative. Revisit when a host needs durable
  cards/state. blocked-by: P-003

## Phase 3 — Standard Schema adoption

- **P-020** `done` Replaced `ZodTypeAny` with `StandardSchemaV1` on tool `args`/`input`,
  card `dataSchema`, and `state`; validation via `~standard.validate` (`standardValidate`
  / `validateSync`), not `.safeParse`. Zod schemas satisfy the interface +
  `InferOutput ≡ z.infer`, so the host's tools are unchanged. `events` + `RouteDefinition`
  kept on Zod (documented exceptions — wire-classification / host-side route validation).
  Proven non-Zod-locked via a hand-rolled validator test. Shipped 2026-05-30. blocked-by: P-002 → D-002
- **P-021** `done` Pluggable `toJsonSchema` registry shipped 2026-05-30 (pulled ahead
  of P-020 — it's cleanly separable and a prerequisite enabler). `schema-adapter.ts`:
  `setJsonSchemaAdapter` + `toJsonSchema`, default = Zod 4's `toJSONSchema`
  (`zodJsonSchemaAdapter`). Same module-level resolver pattern as `tierFor`. blocked-by: — → D-002
- **P-022** `done` (with P-021) — all five core schema→JSON-Schema callsites now route
  through the adapter: `defineTool` inputSchema (×2), `tools/list` events cache +
  `classifyEventWire` (`tool-projection.ts`), `card-correlator` open-card snapshots,
  and `openapi-fragments`. The core's `import { z }` value-import is gone from those
  four files (only `safeParse` method-calls remain, which P-020 swaps). blocked-by: P-021
- **P-023** `done` The host keeps Zod for all ~96 tools (zero churn) — satisfied by
  construction: Zod schemas satisfy `StandardSchemaV1` and the default `toJsonSchema`
  adapter is Zod, so only the *core* became schema-agnostic. Shipped 2026-05-30. blocked-by: P-020

## Phase 4 — Transport adapters (can run after Phase 1)

- **P-030** `done` `http-projection.ts` extracted into **`@papercusp/tooldef-http`**
  (2026-05-30). The adapter's only host couplings were `papercuspGateBypass` (inlined —
  an admitted superuser bypasses all 3 gates; behavior-identical, HTTP has no power-user
  tier) and `AgentRole` from plugin-sdk (→ the core's `AgentRole`); everything else was
  already injected via `HttpToolHostExtras`. So it now depends only on `@papercusp/tooldef`
  + `@papercusp/sse`. `agent-mcp` re-exports the surface byte-preserved (D-010 style), so
  all operator consumers are untouched. New package has a standalone smoke test (no
  agent-mcp deps); the Papercusp-integration test (superuser/bearer/quota-429) stays in
  agent-mcp. Verified: tooldef-http tsc 0 + 3 tests; agent-mcp tsc 19 = baseline + 113
  tests; operator tsc 599 = baseline, 0 new. **Deferred refinements:** (a) make the request
  type literally Web-standard `Request` (today it's a structured `HttpToolRequest`,
  trivially built from `Request`); (b) the formal `SigningProvider`/`contextSchema` (P-013)
  — there's no spawn-URL *verification* in the HTTP adapter today (it reads `X-Papercusp-*`
  + bearer), so the seam belongs where verification actually happens; not blocking.
  blocked-by: P-005 → D-008
- **P-031** `done` Created **`@papercusp/tooldef-mcp`** 2026-05-30 — the host-agnostic
  MCP↔dispatcher **bridge primitives**: the `RequestHandlerExtra` extractors
  (`bearerFromExtra`/`urlFromExtra`/`headersFromExtra`) + a projected-dispatch→MCP-result
  mapper (`dispatchProjectedToolToMcp`). Depends only on `@papercusp/tooldef` (the
  extractors type `extra` loosely, so no `mcp-handler` dep — Vercel's `mcp-handler` stays
  host-side, D-008). `_mcp-handler.ts` now imports these (verbatim helper moves + identical
  mapping) and casts the SDK-neutral result to the SDK shape at the host boundary.
  **Scope decision (architectural, not a punt):** the `createMcpHandler` *assembly* —
  superuser/power-user admission, HMAC `verifySpawnParams`, the legacy-vs-projected pipeline
  routing, tx synthesis (~70% of the 865-line file) — **stays host-side**, because it is
  inherently host-specific; a "generic factory" wrapping it would only be a Papercusp-shaped
  injection surface masquerading as generic (and a high-risk parameterization of the
  agent-spawn path). The auth logic was **not touched** — this is a safe, behavior-preserving
  extraction of the genuinely-reusable glue, which is what `tooldef-mcp` should own.
  Verified: tooldef-mcp tsc 0 + 5 tests (extractors + success/error mapping, no agent-mcp
  deps); `transport-mcp-notifications` 8/8 (the path's existing test); operator tsc — 0 new
  errors attributable to P-031 (`_mcp-handler`/`tooldef-mcp` absent from the error list; the
  total delta is concurrent-agent drift). Residual: the live `tools/call` MCP path has no
  unit test (true before this change too) — covered here by behavior-preservation + untouched
  auth. tooldef-mcp is papercup-internal (not mirrored) — no cross-repo carry. blocked-by: P-005 → D-008
- **P-032** `done` The IPC adapter is already its own package —
  **`@papercusp/ipc-endpoint-server`** (`packages/ipc-endpoint-server`, src-as-entry).
  It consumes the engine via `dispatchProjectedToolStream`. (A cosmetic rename to
  `@papercusp/tooldef-ipc` is optional and deferred — not worth the consumer churn.)
  blocked-by: P-005

## Phase 5 — Re-home the Papercusp host adapter

- **P-040** `done` (already satisfied — assessed 2026-05-30) The real-impl
  `DispatchProjectedDeps` (`apps/operator/lib/projected-tool-deps.ts` → `PROJECTED_DEPS`:
  PG `readQuotaState`/`recordInvocation`, `computeQuotaWindow`, `overrideTool`) and the
  `HttpToolHostExtras` (constructed at the route sites — catchall, plugins, plans,
  locks-queue — with `resolvePrincipalAndTx`/`withWorkspace`/`resolveHarnessPaths`) are
  already wired from real impls; role config, tier resolver, and gate-bypass landed
  incrementally in P-010/P-012/P-014. Nothing left to construct. blocked-by: P-010, P-011, P-012, P-014
- **P-041** `optional` (D-010) `bootstrap.ts`/`server-entry.ts`/`provisioning.ts`/`auth.ts`
  resolve the engine through `@papercusp/agent-mcp`'s own re-export, which is a fine
  permanent arrangement (a bundle re-exporting its engine, not a shim). Repointing them
  directly at `@papercusp/tooldef` is cosmetic; deferred. blocked-by: P-040
- **P-042** `optional` (D-010) Same: operator import sites use the `@papercusp/agent-mcp`
  re-export. No functional need to repoint; cosmetic churn, deferred. blocked-by: P-041

## Phase 6 — Verification + proof-of-genericity

- **P-050** `todo` All existing suites green: `dispatch-stack.test`, `dispatch-projected.test`,
  `http-projection.test`, `tool-projection.test`, `card-correlator.test`,
  `state-channel.test`, `replay-buffer*.test`, `ask-user.test`, `publish-state.test`,
  `workspace-lifecycle.test`. These are the safety net proving the seam didn't move
  behavior. blocked-by: P-042
- **P-051** `partial` The **in-process** form shipped early (2026-05-30):
  `packages/tooldef/examples/standalone-inprocess.ts` registers a tool and dispatches
  it through the full gate stack importing **only** `@papercusp/tooldef` — no
  agent-mcp / host-platform / @restart / postgres / zod. Runs green via
  `npx tsx examples/standalone-inprocess.ts` (`math.add(2,3) = 5`), exercising the
  engine's generic defaults (role=`string`, quota=run/perRun, tier=`'low'`,
  fail-closed gates). This is the falsifiable proof that Phase-2 decoupling achieved
  standalone usability. The **HTTP+MCP-serving** form awaits the transport extraction
  (Phase 4, P-030/P-031) — added then. blocked-by: P-050 (in-process form pulled
  forward as the Phase-2 capstone)
- **P-052** `done` (docs) `README.md` + `TESTING.md` (2026-05-30); `endpoint-system/overview.mdx`
  "How it's packaged" section (package table + host-injection seam table + standalone-example
  pointer); and a **path/symbol accuracy pass across all `endpoint-system/*` pages** —
  every stale `packages/agent-mcp/src/<engine-file>` pointer repointed to `packages/tooldef/src/`
  (P-002 move) / `tooldef-http` (P-030), the File map updated (MCP-transport + host-deps + IPC
  rows), and two references to the **deleted** `computeProjectedQuotaWindowKey` symbol
  (reference "Window keys" + telemetry) rewritten to the P-011 `computeQuotaWindow` reality.
  Remaining is only optional deep-narrative polish (prose still occasionally frames the system
  as monolithic), which describes unchanged behavior — not worth the churn. blocked-by: P-050
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
Date: 2026-05-29 (**resolved 2026-05-30, P-010**)
The core is parameterized over a role config. Papercusp's role set becomes adapter
config, not a core enum.

**Resolved 2026-05-30 — the `RoleRegistry` config-object arm, not the threaded
`<Role>` generic arm.** Roles must remain `string`-assignable (plugins register
custom roles at runtime), so a closed union is impossible; and a defaulted `<Role>`
generic delivers no host-config benefit because the ~601 consumers never pass it and
the core-defined `roles:`/`byRole`/`rolesQuota` fields can't pick up host suggestions
from an unspecified generic. The host augments `RoleRegistry` via declaration merging
(TanStack-`Register` idiom); `AgentRole` resolves to a `string`-assignable
suggestion-union of the host's roles, or bare `string` when unaugmented. The
canonical role set turned out to be ~19 (the real `roles:`-allowlist working set),
not the 9 named here — confirming the set is open and a hard union was the wrong shape.
Full rationale in the Progress log (2026-05-30).

### D-006 — Host-injected business rules
Date: 2026-05-29 (**quota windowing realized 2026-05-30, P-011**)
Four Papercusp-specific rules become functions on the DI surface, each with a
sensible core default: quota window keying, capability→tier (`tierFor`, default
`'low'`), spawn-context signing (`SigningProvider`, default no-op/loopback), and
principal resolution (`resolvePrincipal`, default bearer-or-none). Papercusp
supplies the real impls in Phase 5.

**Quota windowing realized 2026-05-30 (P-011) as `computeQuotaWindow(ctx,
roleQuota) => { key, limit }`, not the sketched `computeWindowKey(ctx) =>
string`.** The window key and the per-role ceiling (`perChunk` vs `perRun`) are a
single inseparable decision, and the window key is needed for telemetry too — so
one function returns both, resolved once per call. Core default
`defaultComputeQuotaWindow` = run-scoped/`perRun`; the host
(`papercuspComputeQuotaWindow`) carries worker→chunk/`perChunk`, power-user→session,
else→run/`perRun`. The engine now references none of `'worker'`/`'chunk:'`/
`perChunk` — it treats `RolesQuota` opaquely.

**Tier realized 2026-05-30 (P-012)** as a module-level resolver
(`setCapabilityTierResolver`, default `'low'`; Papercusp table = `papercuspTierFor`)
— module-load injection, not per-dispatch, because `tier` is stamped eagerly.

**Auth tiers realized 2026-05-30 (P-014)** — but *not* as the sketched
`resolvePrincipal(req) => { principal, bypassGates }`. Principal resolution was
already host-side since Phase 1 (`HttpToolHostExtras.resolvePrincipalAndTx`), so the
only thing left in the engine was the gate-bypass *branches*. Landed as a neutral
`ctx.gateBypass: { role?, capability?, quota? }` the engine reads, with the
superuser/power-user matrix in the host (`papercuspGateBypass`). Fail-closed.

**Signing (`SigningProvider`) deferred to Phase 4 (P-030).** It was never in the
core — `spawn-context.ts` + the orchestrator do HMAC host-side. The interface has no
core consumer until the Web-standard HTTP adapter is extracted, so it lands there.
Of D-006's four rules: quota + tier + auth-bypass shipped (P-011/P-012/P-014);
signing rides Phase 4.

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

### D-009 — Phase-1 transitional seams: `string` stand-ins + `tx: any`
Date: 2026-05-29
The engine move (P-002) widened the still-coupled types to neutral seams rather
than fully genericizing them, to keep the move green and bounded. In
`packages/tooldef/src/host-types.ts`: `AgentRole` and `Capability` are `string`,
and `PluginSpawn` is a generic subprocess type. The legacy `ToolContext.tx` is
typed `any`. Every concrete Papercusp value is assignable to these, so the ~601
consumers stay green. Phase 2 (P-010) promotes `AgentRole` to a real generic `Role`
parameter / role-config; a generic `Tx` parameterization of `ToolContext` rides
with it. This is the *how* of D-005's role decision, applied incrementally.

### D-010 — agent-mcp re-exports the engine (a bundle, not a shim)
Date: 2026-05-29
With ~601 `import … from '@papercusp/agent-mcp'` consumers, P-002 kept agent-mcp's
public export surface byte-preserved by re-exporting the engine from
`@papercusp/tooldef` (`export … from '@papercusp/tooldef'` in `index.ts`). This is
the Papercusp host bundle legitimately re-exporting its own engine — **not** a
deprecation alias — so it doesn't conflict with D-003's no-shim rule. Phase 5
(P-042) *may* repoint consumers directly at `@papercusp/tooldef`, but the re-export
is a fine permanent arrangement for the bundle either way. The only true shims
removed were plugin-sdk's duplicate wire-type definitions (D-004).

## Verification

Each phase is provable against the existing test suites (P-050) — they're already
deps-injected, so a correct seam-move leaves them green without edits. The
falsifiable end-state check is P-051: a standalone example with zero `@papercusp/*`
imports compiling and serving a tool. Run `npm run test:affected` after each phase;
`npm run test:all:integration` is not required unless a phase touches
`libs/papercusp/libs/db/**` (none do — core sheds PG).
