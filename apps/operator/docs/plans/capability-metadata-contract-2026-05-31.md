---
title: One capability-metadata contract — unify palette/voice/shortcut commands with the agent (MCP) tool catalog
slug: capability-metadata-contract-2026-05-31
status: draft
created: 2026-05-31
updated: 2026-05-31
owner: avi@storewolf.com
related: [agent-action-registry-plan-2026-05-03, tooldef-auth-rfc-2026-05-31, papercusp-tooldef-extraction-2026-05-29, BRIEF-tooldef-shared-repo-2026-05-30]
---

# One capability-metadata contract

## Now

**State:** DRAFT for human review. Proposes a single declarative **`Capability`** descriptor that the command palette, voice, keyboard shortcuts **and** the agent/MCP catalog all project from — unifying at the **metadata + projection** layer, *not* by merging the two definition systems (a hard merge would re-couple the host-agnostic `@papercusp/tooldef` to the browser/DOM, the opposite of where the shared-repo extraction `papercusp-tooldef-extraction-2026-05-29` is heading). Grounded in current code: two separate registries exist today — the **Action Registry** (`apps/operator/lib/commands/`, 41 commands/queries, only 6 in the palette) and the **tooldef/endpoint system** (`packages/tooldef` + `apps/operator/lib/agent-tools/`, ~96 MCP tools). They share no definition substrate; the only seam is the single `/api/agent-mcp/run-command` bridge endpoint.

**Next:** human ratifies the direction (P-001 gate) — specifically OQ-1 (final end-state: conform-to-shared-contract vs. full merge vs. leave-separate) and the gating-reconciliation call (OQ-2). Resolving P-001 unblocks Phase 1, whose headline payoff (P-004: the palette surfaces the whole agent tool catalog) is achievable read-only without touching either registry's definitions.

## 1. Problem (grounded in code)

Two parallel "invokable capability" registries have drifted apart:

| | **Action Registry** (`lib/commands/`) | **tooldef / endpoint** (`defineTool`) |
|---|---|---|
| Shape | `CommandDef { id, kind, description, schema (zod), agents: AgentId[], browser: required\|optional\|none, concurrent, tier: reflexive\|delegation, paletteEntry?, handler }` (`lib/commands/types.ts`) | `defineTool({ capability, args (Standard Schema), guidance, handler })` → `ProjectedTool` (`packages/tooldef/src/define-tool.ts`) |
| Runs | **client-side** in the tab (mutates DOM / URL / nuqs; `browser:'required'`) | **server-side** (PG, gated, audited) |
| Gating | `agents: AgentId[]` allowlist + `browser` gate | 8-gate dispatch stack: signature → default-deny → role-allowlist → capability → role-requirement → harness → quota → authorize → timeout (`dispatch-stack.ts`; see `tooldef-auth-rfc-2026-05-31`) |
| Surfaces | ⌘K palette, keyboard shortcuts, voice (eleven/openai), mobile webhook | MCP (`papercusp-su` + in-app conversational agents) + HTTP routes |
| Count | 41 registered; **6** carry `paletteEntry` | ~96 MCP tools (~190 `defineTool` call sites incl. routes) |
| Discovery | `list({ kind:'command', agent:'palette' })` → `buildRegistryPaletteItems` | catalog built by importing `tools/**`; `tools/list` generated at startup |

**The one existing seam:** `lib/endpoint-route/routes/agent-mcp/run-command.ts` is *itself* a `defineTool` endpoint that calls `runCommand()` and routes a command id to a live browser tab (`session-registry.deliver`). So an agent can reach Action-Registry commands only through that one generic bridge — never as first-class MCP tools. Conversely, the palette cannot see any of the ~96 tooldef tools.

**Symptom of the drift:** `lib/commands/types.ts`'s own header still claims the Action Registry is "the single typed source of truth … used by Oracle's MCP server, Pi's MCP server …" — but the conversational agents are now wired to the tooldef `mcp__agentmcp__*` catalog (`lib/operator-mcp-tools.ts`, `app/api/_hono/oracle.ts`). The claim is aspirational/stale: nothing enforces one source of truth.

## 2. The contract — `Capability`

A single declarative descriptor. Identity, docs, schema, gating, and a **`runsIn` execution discriminator** that lets one record feed every surface without pretending a browser command can run server-side:

```ts
interface Capability {
  id: string;                       // stable, namespaced: 'group:verb' (e.g. 'nav:settings', 'features:get')
  title: string;                    // human label (palette / voice)
  description: string;              // model-facing + palette subtitle (today: guidance.when on tooldef side)
  keywords?: string;                // palette fuzzy-search hints
  args: StandardSchemaV1;           // arg schema — Zod is a Standard Schema, so both sides reconcile (OQ-3)

  runsIn: 'server' | 'browser';     // THE discriminator. browser = reflexive UI (DOM/nuqs/session-bound);
                                    // server = dispatch-stack handler. Generalizes today's `browser` field.

  // Which surfaces this capability appears on. Defaults derived from runsIn
  // (server → mcp; browser → palette+voice+shortcut) but explicit-overridable.
  surfaces?: {
    palette?: { section: string; icon?: string };
    voice?: boolean;
    shortcut?: string;              // registry shortcut id (lib/shortcut-registry.ts)
    mcp?: boolean;                  // exposed to agents as a first-class tool
  };

  gating: CapabilityGate;           // ONE gate model — see §4 (reuses the tooldef Principal/roles/auth)
  tier: 'low' | 'med' | 'high';     // RISK tier (capability-tiers.ts), distinct from plan-item importance
}
```

Handlers are **not** unified — they're execution-context-specific and bound by the providing layer:
- `runsIn:'server'` → a tooldef dispatch handler (existing `defineTool` handler).
- `runsIn:'browser'` → an in-tab handler (existing Action-Registry `handler`), OR for a server capability surfaced in the palette, a thin "dispatch + toast result" shim.

This is the crux: **unify the descriptor + the projection; keep two execution providers.** The descriptor is the contract; `runsIn` says who can execute it and via which path.

## 3. Projection model (surface-aware)

One catalog of `Capability` records; each surface selects + binds its own subset:

- **MCP / agents** — select `surfaces.mcp` (default: all `runsIn:'server'`, plus `runsIn:'browser'` ones explicitly opted-in, which dispatch via the existing `run-command` tab bridge). Gated by the dispatch stack. *No change to how agents see server tools today — this is the same projection, just reading the unified descriptor.*
- **Command palette** — select `surfaces.palette`. **Both** `runsIn` kinds appear: browser ones run their in-tab handler; server ones run via a `dispatch + toast` shim (reusing the agent dispatch path). This is the headline win — Ctrl+P becomes a real command surface over *everything* the current principal may invoke, Linear/Raycast/VS-Code-style, instead of 6 nav entries.
- **Voice / shortcuts** — select `surfaces.voice` / `surfaces.shortcut`; unchanged execution, now reading the same descriptor.

Gating is enforced **per surface at projection time** (a tool the principal can't invoke never appears in their palette), and again at dispatch (defense in depth).

## 4. Gating reconciliation

The two systems gate differently; the contract must pick one model. Recommendation: **reuse the tooldef auth model** just shipped in `tooldef-auth-rfc-2026-05-31` (Principal + `roles` (RBAC) + `capabilities` + `trust` + the `authorize` PDP hook), and express the Action Registry's `agents: AgentId[]` allowlist as a `roles`/`capabilities` requirement. That RFC already flagged the exact reconciliation needed here (its decision D-E: principal RBAC `roles` vs. the agent-persona `tool.roles` axis are distinct and must stay distinct). `CapabilityGate` = the tooldef requirement shape; the browser-execution provider enforces the same gate before running an in-tab handler. Open: OQ-2 below.

## 5. Phasing (strictly additive)

Nothing is ripped out on day one. Each phase is independently shippable and reversible.

## Phase 1 — Read-only projection unification (high value, low risk)

- **P-001** `needs-human` Ratify direction before building: approve §2 contract shape + the "unify projection, keep two execution providers" stance, and pick OQ-1's end-state. importance: high
- **P-002** `todo` Define the `Capability` descriptor type. Host-agnostic core in `@papercusp/tooldef` (id/title/description/keywords/args/runsIn/gating/tier); browser-only surface annotations (`surfaces.palette/voice/shortcut`) as an operator-host extension type. blocked-by: P-001 → D-002
- **P-003** `todo` Build a read-only adapter that projects BOTH existing registries into `Capability[]`: tooldef catalog → `runsIn:'server'`; `lib/commands` defs → `runsIn:'browser'` (map `paletteEntry`→`surfaces.palette`, `browser`→`runsIn`). No definitions move. blocked-by: P-002
- **P-004** `todo` Palette surfaces the agent tool catalog: extend `GlobalCommandPalette`/`buildRegistryPaletteItems` to read the unified `Capability[]`, list the principal-gated, browser-safe (no-arg / simple-arg) subset of tooldef tools, execute via the agent dispatch path + toast the result. blocked-by: P-003
- **P-005** `todo` Verify: gating is honored at projection (a tool the principal can't invoke is absent from the palette); no regression to the existing 6 palette commands, voice, or shortcuts. blocked-by: P-004

## Phase 2 — Authoring convergence (opt-in annotations)

- **P-006** `todo` Add optional `surfaces` annotations to `defineTool` (so a server tool opts into the palette/voice in its own definition, replacing the read-only mapping for migrated tools). blocked-by: P-001
- **P-007** `todo` Add `runsIn` + a `gating` field expressible in tooldef terms to Action-Registry `CommandDef` (reconcile `agents: AgentId[]` → roles/capabilities per §4). blocked-by: P-001 → D-003
- **P-008** `todo` Collapse the parallel description/keyword metadata (`paletteEntry` vs `guidance`) onto the single descriptor's fields. blocked-by: P-006, P-007

## Phase 3 — One substrate (decision-gated)

- **P-009** `needs-human` Decide the end-state for browser-reflexive commands: (a) keep `lib/commands` as a registered **browser-execution provider** that conforms to the shared `Capability` contract, or (b) fold them into a single registry in the operator host. importance: high → D-001, OQ-1
- **P-010** `todo` Execute the chosen end-state; delete the now-redundant path (the `run-command` bridge may generalize or retire — OQ-4). blocked-by: P-009

## Decisions

### D-001 — Unify at the projection layer, not by merging registries
Date: 2026-05-31
The two systems model genuinely different execution contexts: Action-Registry commands run in the browser tab (touch `window`/nuqs/DOM, need a live session); tooldef tools run server-side, gated and audited. A hard merge into one registry+handler is rejected because it would force browser concerns into `@papercusp/tooldef`, which is being deliberately extracted to a **host-agnostic shared repo** (`papercusp-tooldef-extraction-2026-05-29`, `BRIEF-tooldef-shared-repo-2026-05-30`) and consumed by Restart. Unify the *descriptor + projection*; keep two execution providers discriminated by `runsIn`. (Recommendation pending P-001 ratification.)

### D-002 — Contract core is host-agnostic; browser specifics are operator-host annotations
Date: 2026-05-31
The `Capability` core (id/title/description/keywords/args/runsIn/gating/tier) lives in `@papercusp/tooldef` so both hosts share it. Browser-only surface annotations (`surfaces.palette/voice/shortcut`) and the in-tab execution provider live in the operator host (`apps/operator/`), never in the shared package. This preserves the extraction goal: tooldef stays browser-free.

### D-003 — Reuse the shipped tooldef auth model as the single gate
Date: 2026-05-31
Rather than invent a third gating model, `CapabilityGate` = the tooldef Principal/roles/capabilities/trust + `authorize` hook from `tooldef-auth-rfc-2026-05-31`. The Action Registry's `agents: AgentId[]` allowlist is re-expressed as roles/capabilities. Honors that RFC's D-E (principal RBAC `roles` ≠ agent-persona `tool.roles` — keep both axes distinct). (Mechanics pending OQ-2.)

## Open questions

- **OQ-1 — End-state (the headline call).** Conform-to-shared-contract (keep two registries, both implement `Capability`) vs. full merge into one operator-host registry vs. leave separate and only do the read-only palette projection (Phase 1 only). Recommendation: ship Phase 1, then choose between conform (b) and merge after seeing the adapter. → P-001, P-009
- **OQ-2 — Gating reconciliation mechanics.** How exactly does `agents: ['palette','operator',…]` map onto principal `roles`/`capabilities`? Is there a default-allow for `runsIn:'browser'` palette commands (they're already user-initiated in the user's own tab) or must each carry an explicit gate? → §4, P-007
- **OQ-3 — Schema unification.** tooldef uses Standard Schema; Action Registry uses raw Zod. Zod *is* a Standard Schema, so adoption is low-friction — but confirm the palette/voice arg-prompting paths don't depend on Zod-specific introspection. → P-002
- **OQ-4 — Keep or generalize the `run-command` bridge.** Once server capabilities are palette-visible and browser capabilities are (optionally) MCP-visible, is the single `run-command` tab bridge still the right mechanism, or does it generalize into the projection layer? → P-010

## Scope / non-goals

- **Non-goal:** changing how any agent currently invokes server tools — Phase 1 is a *read-side* re-projection; the MCP `tools/list` output is unchanged.
- **Non-goal:** putting browser/DOM code into `@papercusp/tooldef`.
- **Non-goal:** a new policy engine — gating reuses the existing tooldef PDP seam (D-003).
- **In scope:** one descriptor, surface-aware projection, and the palette gaining the agent catalog.

## Verification

- Phase 1: the palette lists principal-gated tooldef tools and executes them (result toasted); the existing 6 commands + voice + shortcuts unaffected; a tool the principal can't invoke is absent from the palette (projection-time gate) and rejected at dispatch (defense in depth). Unit tests for the adapter (both registries → `Capability[]`); a palette component test asserting a gated tool is hidden.
- Phase 2/3: `tsc` clean; `npm run test:affected`; no duplicate metadata source remains for a migrated capability.
