---
title: OMP profile system — per-profile tool gating and installer profiles
slug: omp-profile-system-2026-05-24
status: shipped
created: 2026-05-24
updated: 2026-05-24
owner: pandawamble@gmail.com
related:
  - apps/operator/docs/plans/playbook-audience-neutral-rewrite-2026-05-23.md
  - apps/operator/docs/plans/omp-power-user-bundle-2026-05-20.md
  - apps/operator/docs/plans/per-harness-plans-and-docs-2026-05-23.md
---

## Now

**State:** COMPLETE. All 13 items done across 4 commits: `67d1c92a` (types + gate + ~113 tags), `b85d4739` (installer + wrapper), `be37a8a2` (agent-bundle + power URL), `99c66d28` (37/37 profile-gate tests). Power profile filters ~150 Group A tools; engineer profile sees all. Installer, bundle route, and test suite all wired.

**Next:** No further action required. Plan shipped.

# OMP profile system

## §1 Why

The catalog audit (2026-05-22) identified three tool groups in `papercusp-su`:

- **Group A (~150 tools)** — Papercusp-only: `harness:*`, `operator:*`, `features:*`, `issues:*`, `agents:*`, `audit:*`, `experts:*`, deployment routes, plugin management, etc. These do nothing useful for a power-engineer working on a non-Papercusp harness.
- **Group B (~42 tools)** — Genuinely generic: `coord:*`, `locks:*`, `fetch_plus`, `firecrawl.*`, `gitnexus.*`, `repomix.pack`, `hindsight:recall`. Useful to any developer agent regardless of harness.
- **Group C (~43 tools)** — Papercusp-wired but per-harness-portable: `plans:*`, `docs:*`, `memory:*`, `search:*`, `tasks:*`, `artifacts:*`, `agent_chats:*`, `ui:*`, `chat:*`. Useful once per-harness portability is landed (done as of `per-harness-plans-and-docs-2026-05-23`).

Surfacing 150 no-op Group A tools to a power-engineer session:
- Clutters `tools/list`, making the relevant tools harder to find.
- Creates confusion when tools silently fail or return empty (workspace-clamp blocks cross-workspace calls).
- Wastes LLM context on tool descriptions that don't apply.

The power-user playbook (`papercusp-su-power.tools.md`) is already written; it describes only Group B + Group C. The gap is that `papercusp-su` still *surfaces* all tools regardless of the caller's profile.

## §2 Scope

- **Profile gating** — `papercusp-su` at `?profile=power` (or `Authorization: Bearer <power-user-token>`) filters its `tools/list` response to Group B + Group C only. Group A tools are not listed and not callable from that profile.
- **Installer profile flag** — `install-standalone-mcp.sh --profile=engineer|power` (default `engineer`) picks which playbook to install and which `mcp_url` to write into `mcp.json` (with or without `?profile=power`). **SHIPPED** (`b85d4739`).
- **`omp-su` wrapper** — bakes the profile-specific playbook path. **SHIPPED** (`b85d4739`).
- **`/api/agent-bundle` route** — updated to serve `papercusp-su-power.tools.md` as `toolsmd` when the caller has a power-user token.

**Not in scope:**
- A UI for switching profiles mid-session. Session-bound; relaunch to switch.
- New profiles beyond `engineer` and `power` (v1 ships exactly two).
- Per-tool fine-grained gating within a profile (future: role-based filtering is already a gateway; profile gating is a second axis on top).

## §3 Design

### 3.1 Tool-group tagging

Each `defineTool` call gains an optional `profile` field:

```ts
defineTool({
  name: 'harness:get',
  profile: 'engineer',  // omit = 'all' (visible to every profile)
  // ...
})
```

- `profile: 'engineer'` — Group A. Hidden from `?profile=power`.
- omitted / `'all'` — Group B + C. Visible to every profile.

The MCP dispatcher's `tools/list` handler filters by profile before returning. `tools/call` similarly rejects Group A calls when `ctx.profile === 'power'`.

### 3.2 Profile resolution

Priority order (highest wins):
1. Token type — a power-user access token (`type: 'power-user'`) always implies `power` profile.
2. URL param — `?profile=power` when `isSuperuser` (engineer testing the power view).
3. Default — `engineer` (today's behavior, all tools visible).

Set on `ctx.profile: 'engineer' | 'power'`.

### 3.3 Installer flag (SHIPPED)

`install-standalone-mcp.sh --profile=engineer|power` shipped in `b85d4739`. Default `engineer`. Power profile writes `power-collaborator.md` as the playbook dest and the omp-su wrapper bakes in that path.

The remaining installer gap (appending `&profile=power` to the MCP URL in `mcp.json`) is gated on P-004 — need the server gate working before pointing clients at it.

### 3.4 Group A tagging scope

~150 tools need `profile: 'engineer'` added. The catalog:

- `harness:*` (10 tools) — engineer
- `operator:*` (8 tools) — engineer
- `features:*` (7 tools) — engineer
- `issues:*` (2 tools) — engineer
- `agents:*` (3 tools) — engineer
- `audit:*` (1 tool) — engineer
- `experts:*` (5 tools) — engineer
- `pending_events:*` (1 tool) — engineer
- `notifications:*` (1 tool) — engineer
- `snapshots:*` (2 tools) — engineer
- `flags:*` (3 tools) — engineer
- `plugins:*` (3 tools) — engineer
- `roles:*` (3 tools) — engineer
- `hooks:*` (1 tool) — engineer
- Desktop/backup/process routes (8 tools) — engineer
- `plans:launch` / `plans:resume` / `plans:promote` — engineer (write-side)
- `cross_harness:*` (6 tools) — engineer (power users use harness-scoped variants)
- `operator:scan` / `operator:converse` / `operator:delegate` — engineer

Group B + C (visible to both profiles) are everything else.

This is a mechanical tag sweep — no behavior changes, just metadata.

## §4 Items

### Phase 1 — core gate

- **P-001** `done` Ratify the three-part design: (a) `profile` field on `defineTool`, (b) `tools/list` filter in dispatcher, (c) `ctx.profile` resolution. Auto-ratified per user mandate.
- **P-002** `done` Add `profile?: 'engineer' | 'all'` to `ToolDefinitionInput` + `ProjectedTool`. (`67d1c92a`)
- **P-003** `done` Extend `UnifiedToolContext.profile`; resolve from power-user token, `?profile=power` SU param, or default `'engineer'`. (`67d1c92a`)
- **P-004** `done` Filter `tools/list` + reject `tools/call` for out-of-profile tools in `_mcp-handler.ts`; `listMcpProjections(role, profile)`. (`67d1c92a`)
- **P-005** `done` Tagged ~113 Group A tools with `profile: 'engineer'`. (`67d1c92a`)

### Phase 2 — installer + wrapper

- **P-006** `done` Extend `install-standalone-mcp.sh` with `--profile=engineer|power` per §3.3. (shipped `b85d4739`)
- **P-007** `done` Update `omp-su` wrapper template to bake profile-specific playbook path. (shipped `b85d4739`)
- **P-008** `done` Append `&profile=power` to MCP URL in `mcp.json` when `--profile=power`. (`be37a8a2`)
- **P-009** `done` Update `/api/agent-bundle` to serve `papercusp-su-power.tools.md` when caller has power-user token. (`be37a8a2`)

### Phase 3 — verification

- **P-010** `done` Test: power-user token → `tools/list` returns only Group B + C. (`99c66d28`)
- **P-011** `done` Test: SU caller with `?profile=power` → same filtered list. (`99c66d28`)
- **P-012** `done` Test: engineer profile → all tools visible (no regression). (`99c66d28`)
- **P-013** `done` Confirmed `playbook-audience-neutral-rewrite-2026-05-23` P-010 + P-011 already `done` (shipped `b85d4739`).

## §5 Dependencies

- **Depends on:** `playbook-audience-neutral-rewrite-2026-05-23` (playbook files already split — done).
- **Depends on:** `per-harness-plans-and-docs-2026-05-23` (Group C generalization — done).
- **Unblocks:** `playbook-audience-neutral-rewrite-2026-05-23` full Phase 2 completion.

## Decisions

_(none yet — appended as `### D-NNN — title` when P-001 is ratified.)_
