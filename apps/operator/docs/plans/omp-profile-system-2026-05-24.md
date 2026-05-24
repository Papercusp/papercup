---
title: OMP profile system — MCP-server-side tool gating for engineer vs power profiles
slug: omp-profile-system-2026-05-24
status: draft
created: 2026-05-24
updated: 2026-05-24
owner: pandawamble@gmail.com
related:
  - apps/operator/docs/plans/playbook-audience-neutral-rewrite-2026-05-23.md
  - apps/operator/docs/plans/desktop-app-install-integration-2026-05-23.md
  - apps/operator/docs/plans/per-harness-plans-and-docs-2026-05-23.md
---

## Now

**State:** Draft. Dependency for Phase 2 of `playbook-audience-neutral-rewrite-2026-05-23` (P-010/P-011 install-script work already shipped; this plan handles the MCP-server-side tool filtering that makes the power profile actually see a different tool surface).

**Next:** Ratify D-001 (profile param mechanism) and D-002 (tool group definitions) before starting P-001.

# OMP profile system

## §1 Why

`install-standalone-mcp.sh --profile=power` now ships the power-engineer playbook. But the MCP server at `/api/mcp?superuser=1` still exposes all 238 tools regardless of profile. A power-engineer session gets the right *instructions* but still sees 150+ Papercusp-internal tools (`harness:*`, `operator:*`, `experts:*`, …) that don't apply to their work.

The profile system gates the MCP tool surface server-side so `?profile=power` returns only Group B + Group C tools, and the power-engineer session isn't cluttered with irrelevant capabilities.

## §2 Tool groups (from 2026-05-22 catalog audit)

| Group | Count | Description | Power profile? |
|-------|-------|-------------|----------------|
| A | ~150 | Papercusp-only: `harness:*`, `operator:*`, `experts:*`, `agents:*`, `features:*`, `issues:*`, `audit:*`, scans, notifications, endorsements, `design-phase:*` | No |
| B | ~42  | Genuinely generic: `coord:*`, `locks:*`, `fetch_plus`, `firecrawl.*`, `gitnexus.*`, `repomix.pack`, `hindsight:recall` | Yes |
| C | ~43  | Contested middle — generic concept, Papercusp-wired: `plans:*` (per-harness after per-harness plan), `docs:*` (with project root), `memory:*`, `search:*`, `tasks:*`, `artifacts:*`, `goals:*`, `messages:*` | Yes (contingent on per-harness portability) |

## §3 Design decisions (needs-human)

### D-001 — How to signal profile to the MCP server

- **(a)** **Query param: `?profile=power`**. Orthogonal to `?superuser=1`; URL remains self-contained. The install script already bakes the full URL into `~/.omp/agent/mcp.json` — adding `&profile=power` is a single-character change to the Python merge. **Recommended**.
- **(b)** Custom HTTP header `X-Papercusp-Profile: power`. More correct REST semantics; but OMP MCP config has no header-merging UI — harder for users to configure manually.
- **(c)** Separate MCP endpoint: `/api/mcp/power?superuser=1`. Cleaner URL; doubles the surface; requires duplicating the transport registration.

### D-002 — Where profile filtering lives in the dispatch stack

- **(a)** **`tool-projection.ts` `listTools()` + `callTool()` gating on `ctx.profile`**. Single enforcement point; all transport (HTTP/MCP/IPC) enforces consistently. **Recommended**.
- **(b)** MCP transport layer only (`mcp-projection.ts`). Simpler; but HTTP callers bypass and IPC callers bypass — inconsistent.
- **(c)** Tool registry tag: each `defineTool` carries a `profiles: ['engineer','power']` field; `listTools` filters by it. More declarative; adds a field to every tool definition.

### D-003 — Group C tool gating strategy

- **(a)** **Opt-in: Group C tools gate on `ctx.profile === 'power'` AND the tool's generalization work (per-harness portability) being landed**. Today's unported tools stay Group A until ported; the per-harness plan already covers most. **Recommended**.
- **(b)** Expose all of Group C now (even Papercusp-wired) for power profile. Simpler; but a `plans:*` tool that assumes `papercup` slug confuses a power user on a different harness.

## §4 Phase 1 — query-param profile signal + listTools filter

- **P-001** `todo` Ratify D-001 (query param), D-002 (tool-projection), D-003 (opt-in Group C).
- **P-002** `todo` Add `profile?: 'engineer' | 'power'` to `DispatchCtx` in `tool-projection.ts`; plumb from `?profile=` query param in `http-projection.ts` and `mcp-projection.ts`.
- **P-003** `todo` `listTools()` in `tool-projection.ts`: when `ctx.profile === 'power'`, filter to tools tagged `group: 'B' | 'C'`; drop Group A tools from the returned list.
- **P-004** `todo` `callTool()` in `tool-projection.ts`: return `tool_not_found` when profile is `power` and the called tool is Group A (prevents bypassing `listTools` by direct name call).
- **P-005** `todo` Tag all tool definitions with `group: 'A' | 'B' | 'C'` in `defineTool({ group })`. Default = `'A'` (Papercusp-engineer-only) so new tools are safe by default.
- **P-006** `todo` Update `install-standalone-mcp.sh --profile=power` to append `&profile=power` to the MCP URL baked into `mcp.json`.
- **P-007** `todo` Tests: `listTools` returns B+C for power, all for engineer; `callTool` rejects Group A for power.

## §5 Phase 2 — Group C tool-by-tool generalization audit

- **P-008** `todo` Audit each Group C tool against the per-harness portability work. Tools that are already harness-context-aware (post `per-harness-plans-and-docs`) get tagged `group: 'C'`; tools still Papercusp-wired remain `group: 'A'` until fixed.
- **P-009** `todo` Port any remaining Group C tools that have a clear per-harness generalization (small: `tasks:*`, `artifacts:*`, `goals:*`).
- **P-010** `todo` Update `papercusp-su-power.tools.md` to document only the tools actually in Group B+C.

## §6 Dependencies

- Depends on: `per-harness-plans-and-docs-2026-05-23` (SHIPPED) for Group C harness-context portability.
- Depends on: `playbook-audience-neutral-rewrite-2026-05-23` (P-010/P-011 shipped) for installer profile support.
- Blocks: Phase 2 full-split completion in `playbook-audience-neutral-rewrite-2026-05-23`.

## Decisions

_(empty — to be filled as items are ratified)_
