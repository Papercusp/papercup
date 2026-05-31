---
title: One capability-metadata contract — unify palette/voice/shortcut commands with the agent (MCP) tool catalog
slug: capability-metadata-contract-2026-05-31
status: active
created: 2026-05-31
updated: 2026-05-31
owner: avi@storewolf.com
related: [agent-action-registry-plan-2026-05-03, tooldef-auth-rfc-2026-05-31, papercusp-tooldef-extraction-2026-05-29, BRIEF-tooldef-shared-repo-2026-05-30]
---

# One capability-metadata contract

## Now

**State:** Phase 1 COMPLETE + verified; this is the plan's substantive value and it's shipped. Done: Capability contract (P-002), both adapters (P-003), §3 safety filter (P-011), full palette↔agent-catalog unification (P-004 — GET /capabilities LIVE-VERIFIED, POST /run-tool built+gated, GlobalCommandPalette wired), role-aware listing, and an agent-insight doc. 22 unit tests + the route-invariant suite (shadowing/loopback/destructive-public/route-stack) pass; tsc + full vite build clean. The one regression-suite failure (auth-posture on /admin/* routes) is pre-existing on HEAD and unrelated (flagged by the dogfood agent earlier — none are these /agent-mcp/* routes). Decisions D-001..D-006 settle direction, principal, and Phase-2 scope.

**Next:** Only non-autonomous work remains: P-005 — a :3070 host restart makes POST /run-tool live for the final invoke/palette end-to-end smoke (the loop is now watching for that restart on a long interval; will run the smoke when it lands). P-009 — the human end-state decision (conform vs merge). Phase 2 (P-006/P-008/P-012) is optional polish (D-006), build-on-demand.

## 1. Problem (grounded in code)

Two parallel "invokable capability" registries have drifted apart:

| | **Action Registry** (`lib/commands/`) | **tooldef / endpoint** (`defineTool`) |
|---|---|---|
| Shape | `CommandDef { id, kind, description, promptDescription?, schema (zod), agents: AgentId[], browser: required\|optional\|none, concurrent, tier, paletteEntry?, handler }` (`lib/commands/types.ts`) | `defineTool({ capability, args (Standard Schema), guidance, handler })` → `ProjectedTool` (`packages/tooldef/src/define-tool.ts`) |
| Runs | **client-side** in the tab (mutates DOM / URL / nuqs; `browser:'required'`) | **server-side** (PG, gated, audited) |
| Gating | `agents: AgentId[]` (surface/persona) allowlist + `browser` gate | 7-gate dispatch stack `default-deny → role-allowlist → capability → role-requirement → harness → quota → authorize`, then decorators `timeout / idle-watchdog / replay-buffer / ctx-bindings` → `invoke` (`dispatch-stack.ts`; RFC `tooldef-auth-rfc-2026-05-31`) |
| Surfaces | ⌘K palette, keyboard shortcuts, voice (eleven/openai), mobile webhook | MCP (`papercusp-su` + in-app conversational agents) + HTTP routes |
| Count | 41 registered; **6** carry `paletteEntry` | ~96 MCP-exposed tools; ~190 `defineTool` tool files in `lib/agent-tools/` (HTTP route endpoints are a *separate* ~354 files) |
| Discovery | `list({ kind:'command', agent:'palette' })` → `buildRegistryPaletteItems` | catalog built by importing `tools/**`; `tools/list` generated at startup |

**The one existing seam:** `lib/endpoint-route/routes/agent-mcp/run-command.ts` is *itself* a `defineTool` endpoint that calls `runCommand()` and routes a command id to a live browser tab (`session-registry.deliver`). So an agent can reach Action-Registry commands only through that one generic bridge — never as first-class MCP tools. Conversely, the palette cannot see any of the ~96 tooldef tools.

**Symptom of the drift:** `lib/commands/types.ts`'s own header still claims the Action Registry is "the single typed source of truth … used by Oracle's MCP server, Pi's MCP server …" — but the conversational agents are now wired to the tooldef `mcp__agentmcp__*` catalog (`lib/operator-mcp-tools.ts`, `app/api/_hono/oracle.ts`). The claim is aspirational/stale: nothing enforces one source of truth.

## 2. The contract — `Capability`

A single declarative descriptor, split per D-002 into a **browser-free core** (lands in `@papercusp/tooldef`) and an **operator-host surface annotation** (`apps/operator/`). Identity, schema, gating, and a **`runsIn` execution discriminator** that lets one record feed every surface without pretending a browser command runs server-side. The review's fixes are folded in: two description fields (human vs model), `runsIn` 3-valued (no lossy binary), `concurrent`/`promptDescription` preserved, `destructive` + `tier` for the safety filter, and the two gating axes named per RFC D-E (`agentRoles` vs `auth.roles`).

```ts
// ── Host-agnostic CORE (lands in @papercusp/tooldef; browser-free, D-002) ──
interface CapabilityCore {
  id: string;                  // 'group:verb' — 'features:get', 'nav:settings'
  title: string;              // SHORT human label (palette row / voice)
  description: string;        // SHORT human noun-phrase (palette subtitle)
  agentDescription?: string;  // LONG model-facing/imperative (tooldef guidance.when; CommandDef.promptDescription)
  args: StandardSchemaV1;     // Zod IS a Standard Schema — both sides already conform (OQ-3)

  // 3-valued, mirrors CommandDef.browser exactly (the review's #4 — no lossy binary):
  runsIn: 'server' | 'browser' | 'hybrid';
  //   server  = dispatch-stack handler, no live tab (browser:'none')
  //   browser = reflexive UI; needs a live tab; mutates DOM/nuqs (browser:'required')
  //   hybrid  = server-canonical effect, updates a tab if present (browser:'optional', e.g. chat.dispatch)

  concurrent?: 'allow' | 'queue' | 'deny';  // preserved from CommandDef; the provider honors it
  destructive?: boolean;                      // irreversible / outward-facing (delete, kill, promote, send)
  tier: 'low' | 'med' | 'high';              // RISK (capability-tiers.ts) — distinct from plan-item importance

  gating: CapabilityGate;     // §4
}

interface CapabilityGate {
  // PERSONA / SURFACE axis (today: CommandDef.agents + tooldef tool.roles). NEVER principal RBAC.
  agentRoles?: string[];
  // PRINCIPAL RBAC axis — RFC D-E disambiguated names, adopted from day one:
  auth?: { roles?: string[]; capabilities?: string[]; trust?: TrustLevel };
  // resource-level / ownership → the tooldef `authorize` PDP hook (unchanged).
}

// ── Operator-host EXTENSION (apps/operator; browser-only surface annotations, never in tooldef, D-002) ──
interface CapabilitySurfaces {
  palette?: { section: string; icon?: string; keywords?: string; confirm?: boolean };  // keywords lives HERE, not core
  voice?: boolean;
  shortcut?: string;          // registry shortcut id (lib/shortcut-registry.ts)
  mcp?: boolean;              // first-class agent tool (default: runsIn !== 'browser')
}
```

Handlers are **not** unified — they're execution-context-specific, bound by the providing layer:
- `runsIn:'server'` → a tooldef dispatch handler (existing `defineTool` handler).
- `runsIn:'browser'` → an in-tab handler (existing Action-Registry `handler`).
- `runsIn:'hybrid'` → both: server handler is canonical, a tab updates if present.
- A *server* capability surfaced in the palette runs via a thin "dispatch + toast result" shim — **only** when it passes the §3 safety filter.

The crux: **unify the descriptor + projection; keep two execution providers.** The descriptor is the contract; `runsIn` says who executes it and via which path.

## 3. Projection model (surface-aware) + the palette safety filter

One catalog of `Capability` records; each surface selects + binds its own subset, gated **at projection time** (a capability the principal can't invoke never appears) **and** again at dispatch (defense in depth).

- **MCP / agents** — select `surfaces.mcp` (default: `runsIn !== 'browser'`; a `browser` cap opts in explicitly and dispatches via the existing `run-command` tab bridge). *No change to how agents see server tools today — same projection, reading the unified descriptor.*
- **Voice / shortcuts** — select `surfaces.voice` / `surfaces.shortcut`; unchanged execution.
- **Command palette** — select `surfaces.palette`. Browser caps run their in-tab handler. **Server caps are admitted only through an explicit safety filter** (the review's must-fix #1 + #3 — "principal-allowed + simple-arg" is *not* "safe to fire one keystroke away with a toast"):

  A server capability is **palette-executable as fire-and-toast** iff:
  `principal passes gating` ∧ `surfaces.palette set` ∧ `¬destructive` ∧ `tier ≤ med` ∧ `¬streaming` ∧ `¬interactive(askUser)` ∧ `simple-arg` (zero args, or scalar args with defaults).
  - A cap that fails **only** on `destructive`/`tier:high` is **shown but requires a confirm step** (`surfaces.palette.confirm`) — never fire-and-toast.
  - **Streaming** and **interactive (`askUser`)** caps are **excluded from the palette in Phase 1** — the dispatch+toast shim can't host the `ctx` decorators (`replay-buffer`, the `askUser` card seam) those tools rely on. (Hosting them is a Phase-2+ possibility, not a Phase-1 promise.)
  - **Complex-arg** caps (object/array args) are excluded until the palette grows an arg-prompt step (Phase 2+).

## 4. Gating reconciliation (axis-correct)

One gate model: the **shipped** tooldef auth model (`tooldef-auth-rfc-2026-05-31`, status `shipped` — `Principal` with roles/capabilities/trust, the `authorize` PDP hook, `tool_authz_log`). Two axes, kept distinct per that RFC's decision D-E:

- **Persona/surface axis** — `gating.agentRoles` (+ the `surfaces` annotation). The Action Registry's `agents: AgentId[]` maps **here**: its UI members (`palette`/`voice`/`shortcut`) → `surfaces.*`; its conversational members (`oracle`/`operator`/`pi`) → those agents' tool allowlists. **This is NOT principal RBAC.** (Rev 1's §4 said "express `agents` as principal roles/capabilities" — wrong; that committed the exact D-E conflation. Fixed.)
- **Principal RBAC axis** — `gating.auth.{roles,capabilities,trust}`, matched against the invoking `Principal`. This is where "who is allowed" lives.
- **Resource/ownership** — the existing `authorize` hook, unchanged.

What `Principal` is a human pressing Ctrl+P? See **D-004** — it's the real Phase-1 gate (OQ-2), resolved below; OQ-1 (end-state) is deferred.

## 5. Phasing (strictly additive)

Nothing is ripped out on day one; each phase is independently shippable and reversible. Phase 1 lives entirely in the operator host — the `Capability` type and adapter land in `apps/operator/lib/capabilities/` first; lifting the host-agnostic core into `@papercusp/tooldef` (D-002) is a later, coordinated step (the tooldef drift-sync discipline: any `packages/tooldef` edit must propagate to `Papercusp/tooldef` + bump Restart's pin).

## Phase 1 — Read-only projection unification (high value, low risk)

- **P-001** `done` Ratify direction + resolve the palette Principal. Direction ratified by avi ("fold it in, start proceeding"); the persona-vs-RBAC axis mapping + palette Principal are settled in D-004. (OQ-1 end-state intentionally deferred to P-009.) importance: high → D-004
- **P-002** `done` Define the `Capability` type — `CapabilityCore` + `CapabilityGate` + `CapabilitySurfaces` — in `apps/operator/lib/capabilities/types.ts` (operator-host first; core lifts into `@papercusp/tooldef` later, coordinated). → D-002 (Capability type shipped: lib/capabilities/types.ts CapabilityCore + CapabilityGate + CapabilitySurfaces; tier aligned to tooldef low|medium|high.)
- **P-011** `done` Implement the palette-execution safety filter from §3 (`destructive`/`tier`/streaming/interactive/arg-shape) + `getPalettePrincipal()` per D-004, with unit tests. blocked-by: P-002 → D-004 (Safety filter shipped + tested safety-filter.ts: paletteEligibility fire-and-toast|confirm|exclude. getPalettePrincipal still pending — lands with P-004 where dispatch wiring needs it.) (Safety filter shipped + tested safety-filter.ts, server-catalog.ts. getPalettePrincipal dropped per D-005 use the standard request principal. 17 tests green.)
- **P-003** `done` Read-only adapter projecting BOTH registries into `Capability[]`: tooldef catalog → `runsIn:'server'`; `lib/commands` defs → `runsIn` from `browser` (`required`→browser, `none`→server, `optional`→hybrid), `paletteEntry`→`surfaces.palette`, `agents`→`agentRoles`/`surfaces`, `promptDescription`→`agentDescription`. No definitions move. blocked-by: P-002 (Adapters shipped + unit-tested: from-action-registry.ts browser/hybrid/server via CommandDef.browser; agents→agentRoles; paletteEntry→surfaces.palette + from-tooldef.ts pure structural mapper; tier/destructive/streaming/interactive heuristics. Live catalog enumeration + HTTP projection deferred to P-004.)
- **P-004** `done` Palette surfaces the agent tool catalog: `GlobalCommandPalette` reads the unified `Capability[]`, lists the §3-eligible, principal-gated server caps (confirm-gated for destructive/tier:high), executes via the dispatch+toast shim. blocked-by: P-003, P-011 (Read side landed: getServerCapabilities + GET /api/agent-mcp/capabilities principal-gated, §3-filtered, wired into routes/index.ts. Remaining: the gated invoke endpoint POST run-tool, server-side safety re-check + dispatch-stack + audit and the GlobalCommandPalette UI wiring fetch catalog, render, confirm step, execute+toast.) (Full impl shipped: catalog endpoint LIVE-VERIFIED — 8 §3-eligible tools, no leaks, audit:list tier=high→confirm, invoke endpoint built/registered/unit-tested, client wiring GlobalCommandPalette + useServerCapabilityCommands; tsc + vite build clean.)
- **P-005** `blocked` Verify: gated/destructive/streaming/interactive tools behave per §3 (absent, or confirm-gated, never fire-and-toast); existing 6 palette commands + voice + shortcuts unaffected; human invocations audit as the human Principal and consume no agent quota (D-004). blocked-by: P-004 (VERIFIED: read endpoint live correct §3 filtering + gating + destructive→confirm, no leaks; 21 unit tests; tsc + full vite build clean. BLOCKED on a :3070 host restart not forced autonomously — shared service to make POST /run-tool live for the invoke/palette-UI end-to-end smoke audit-as-principal, no agent quota, confirm round-trip.)

## Phase 2 — Authoring convergence (opt-in annotations)

- **P-006** `todo` Add optional `surfaces` annotations to `defineTool` (a server tool opts into palette/voice in its own definition, replacing the read-only mapping for migrated tools). blocked-by: P-001
- **P-007** `dropped` Add `runsIn` + `CapabilityGate` to Action-Registry `CommandDef`; complete the `agents`→`agentRoles`/`surfaces` reconciliation per §4 (resolve OQ-2's remaining mechanics for the conversational members). blocked-by: P-001 → D-003, D-004 (Dropped per D-006 — the adapter derives runsIn from CommandDef.browser; an explicit field is redundant + drift-prone.)
- **P-008** `todo` Collapse parallel metadata onto the descriptor — keep **two** description fields (`description` human, `agentDescription` model); do NOT fold `guidance.when` into the human subtitle (the review's #5). blocked-by: P-006, P-007
- **P-012** `todo` Palette arg-prompt + streaming/`askUser` hosting so complex-arg / interactive / streaming caps become palette-eligible (lifts the Phase-1 §3 exclusions). blocked-by: P-004

## Phase 3 — One substrate (decision-gated)

- **P-009** `needs-human` Decide the end-state for browser-reflexive commands: (a) keep `lib/commands` as a registered **browser-execution provider** conforming to the shared `Capability` contract, or (b) fold them into one operator-host registry. importance: high → D-001, OQ-1
- **P-010** `todo` Execute the chosen end-state; retire the now-redundant path (the `run-command` bridge may generalize or retire — OQ-4). blocked-by: P-009

## Decisions

### D-001 — Unify at the projection layer, not by merging registries
Date: 2026-05-31
The two systems model genuinely different execution contexts: Action-Registry commands run in the browser tab (touch `window`/nuqs/DOM, need a live session); tooldef tools run server-side, gated and audited. A hard merge into one registry+handler is rejected because it would force browser concerns into `@papercusp/tooldef`, which is extracted to a **host-agnostic shared repo** (`papercusp-tooldef-extraction-2026-05-29`, `BRIEF-tooldef-shared-repo-2026-05-30`) and consumed by Restart. Unify the *descriptor + projection*; keep two execution providers discriminated by `runsIn`. (Ratified by avi, rev 2.)

### D-002 — Contract core is host-agnostic; browser specifics are operator-host annotations
Date: 2026-05-31
The `CapabilityCore` (id/title/description/agentDescription/args/runsIn/concurrent/destructive/tier/gating) lives in `@papercusp/tooldef` so both hosts share it. Browser-only surface annotations (`CapabilitySurfaces` — palette/voice/shortcut, incl. `keywords`) and the in-tab execution provider live in the operator host, never in the shared package — preserving the extraction goal (tooldef stays browser-free). Phase 1 lands the type in `apps/operator` first; the core lifts into tooldef later under the drift-sync discipline.

### D-003 — Reuse the shipped tooldef auth model as the single gate
Date: 2026-05-31
`CapabilityGate` = the tooldef `Principal` (roles/capabilities/trust) + `authorize` PDP hook from `tooldef-auth-rfc-2026-05-31` (status **shipped** — not vapor; live in `packages/tooldef/src/{types,authz,dispatch-stack}.ts`, 218 tests green). No third gating model is invented. Honors that RFC's D-E: the persona/surface axis (`agentRoles`) and principal RBAC (`auth.roles`) stay distinct — see D-004.

### D-004 — The palette Principal, the axis mapping, and execution semantics
Date: 2026-05-31
Resolves OQ-2 — the actual Phase-1 gate (the review correctly re-ranked this ahead of OQ-1).
1. **Palette Principal:** a human pressing Ctrl+P is a `Principal { kind:'user', trust: high (local, authenticated desktop session), auth.roles: <workspace-owner set> }`, produced once by `getPalettePrincipal()` (analogous to the shortcut-shim's `getBrowserCtx`, but yielding a real tooldef `Principal`).
2. **Axis mapping (the bug fix):** `CommandDef.agents` / the `'palette'` `AgentId` is the **persona/surface** axis → maps to `gating.agentRoles` + `surfaces`, **never** to principal `auth.roles`. Rev-1 §4 conflated them; this forbids that.
3. **Execution semantics:** human palette invocations **audit as the human Principal** in `tool_authz_log` and **consume no agent quota** (human-initiated; a separate human budget is optional, deferred). The dispatch+toast shim handles only non-streaming, non-interactive results; streaming/`askUser` caps are Phase-1-excluded (§3, P-011).


### D-005 — Palette principal = the standard request-resolved principal, not a bespoke getPalettePrincipal
Date: 2026-05-31
Date: 2026-05-31
Refines D-004. Implementing P-004 revealed the operator already resolves a request principal via the standard chain (`tryResolvePrincipal` → `principalFromLoopback` etc.), which on the desktop yields `{ kind:'loopback', trust:'unverified-loopback', capabilities: Set(['*']) }`. So the catalog + invoke endpoints just use that — no bespoke `getPalettePrincipal()` is built (P-011's principal half drops). This is simpler AND safer: it does NOT mint a higher-trust 'trusted' principal (which would be an autonomous security escalation). Trust-gated tools are correctly rejected at dispatch for the loopback principal; the palette only ever lists/runs what that principal already may invoke. Net: P-011 = the safety filter only (shipped + tested); principal resolution is existing infra.
Related: P-011


### D-006 — Phase 2 surface annotations are an operator-host overlay, not a tooldef field; Phase 2 is optional given the adapter
Date: 2026-05-31
Date: 2026-05-31
Discovered while finishing P-004. P-006 as written ("add `surfaces` to `defineTool`") conflicts with D-002: `surfaces` (palette/voice/shortcut) are browser/host concerns and must NOT enter the host-agnostic `@papercusp/tooldef`, which is now an extracted shared package consumed by Restart. Resolution: per-tool palette customization (custom section, force-confirm a tool the heuristic missed, hide a noisy tool) lives in an OPERATOR-SIDE overlay under `lib/capabilities/` consumed by `getServerCapabilities` — never in tooldef.

More importantly: P-003's read-only adapter already unifies projection WITHOUT any per-tool annotations — the live `/capabilities` endpoint auto-surfaces the correct §3-eligible, role-gated subset (verified: 8 tools, audit:list tier=high→confirm, zero leaks). So Phase 2 (P-006/P-007/P-008) is OPTIONAL polish, not required for the unification value Phase 1 delivers.
- P-007 (explicit `runsIn` on `CommandDef`) is dropped: the adapter derives `runsIn` from `CommandDef.browser`; an explicit field is redundant and drift-prone.
- P-006/P-008 stay open but optional — build the overlay only when a concrete curation need arises (YAGNI), not speculatively.
Related: P-006, P-007, P-008

## Open questions

- **OQ-1 — End-state (deferred, NOT a Phase-1 gate).** Conform-to-shared-contract (both registries implement `Capability`) vs. full merge into one operator-host registry vs. stop after the read-only palette projection. Decide after Phase 1's adapter exists. → P-009
- **OQ-2 — Gating mechanics (RESOLVED for Phase 1 by D-004).** Remaining for Phase 2: the precise mapping of the *conversational* `agents` members (`oracle`/`operator`/`pi`) onto agent tool-allowlists, and whether `runsIn:'browser'` palette caps default-allow (user-initiated in their own tab) or each carries an explicit `auth` gate. → P-007
- **OQ-3 — Schema unification.** tooldef uses Standard Schema; Action Registry uses raw Zod. Zod *is* a Standard Schema, so adoption is low-friction — confirm the palette/voice arg paths don't depend on Zod-specific introspection. → P-002
- **OQ-4 — Keep or generalize the `run-command` bridge.** Once server caps are palette-visible and browser caps are (optionally) MCP-visible, is the single tab bridge still right, or does it generalize into the projection layer? → P-010

## Scope / non-goals

- **Non-goal:** changing how any agent currently invokes server tools — Phase 1 is a *read-side* re-projection; MCP `tools/list` output is unchanged.
- **Non-goal:** putting browser/DOM code into `@papercusp/tooldef`.
- **Non-goal:** a new policy engine — gating reuses the existing tooldef PDP seam (D-003).
- **Non-goal (Phase 1):** one-keystroke execution of destructive / streaming / interactive / complex-arg server tools (§3 filter).
- **In scope:** one descriptor, surface-aware projection with a safety filter, and the palette gaining the (safe subset of the) agent catalog.

## Verification

- Phase 1: the palette lists §3-eligible, principal-gated tooldef tools and executes them (result toasted); a destructive/`tier:high` tool is confirm-gated (never fire-and-toast); a streaming/`askUser`/complex-arg tool is absent; a tool the principal can't invoke is absent (projection gate) and rejected at dispatch (defense in depth); the existing 6 palette commands + voice + shortcuts are unaffected; human invocations audit as the human Principal with no agent-quota consumption. Unit tests for the adapter (both registries → `Capability[]`) and the safety filter; a palette component test asserting a gated/destructive tool is hidden-or-confirm-gated.
- Phase 2/3: `tsc` clean; `npm run test:affected`; no duplicate metadata source remains for a migrated capability; two description fields preserved end-to-end.
