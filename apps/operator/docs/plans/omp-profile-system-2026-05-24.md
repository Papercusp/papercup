---
title: OMP profile system — per-profile tool gating and installer profiles
slug: omp-profile-system-2026-05-24
status: draft
created: 2026-05-24
updated: 2026-05-24
owner: pandawamble@gmail.com
related:
  - apps/operator/docs/plans/playbook-audience-neutral-rewrite-2026-05-23.md
  - apps/operator/docs/plans/omp-power-user-bundle-2026-05-20.md
  - apps/operator/docs/plans/per-harness-plans-and-docs-2026-05-23.md
---

## Now

**State:** Draft. Unblocks Phase 2 of `playbook-audience-neutral-rewrite-2026-05-23` (P-010 / P-011). The playbook split is done (two `.tools.md` files exist); what's missing is (a) the MCP-server-side mechanism that surfaces only the right tool subset per profile, and (b) the installer `--profile=engineer|power` flag that picks which playbook to install.

**Next:** User ratifies P-001 (scope decision: which groups of tools are gated per profile, and where the gate lives — dispatcher vs. registrar vs. URL param).

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
- **Installer profile flag** — `install-standalone-mcp.sh --profile=engineer|power` (default `engineer`) picks which playbook to install as `~/.papercusp/engineer-collaborator.md` and which `mcp_url` to write into `mcp.json` (with or without `?profile=power`).
- **`omp-su` wrapper** — updated to read `PAPERCUSP_PROFILE` env var (default `engineer`); passes the right `--append-system-prompt` file.
- **`/api/agent-bundle` route** — updated to serve `papercusp-su-power.tools.md` as `toolsmd` when the caller has a power-user token (already inferred from token type; `?profile=` is belt-and-suspenders).

**Not in scope:**
- A UI for switching profiles mid-session. Session-bound; relaunch to switch.
- New profiles beyond `engineer` and `power` (v1 ships exactly two).
- Per-tool fine-grained gating within a profile (future: role-based filtering is already a gateway; profile gating is a second axis on top).
- Porting the profile gate to the power-user token's dispatch path (the power-user token already implies `power` profile; the explicit `?profile=power` URL param is for the engineer/SU caller who wants the power view for testing).

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
- `profile: 'power'` — would mean "power only", not needed in v1.
- omitted / `'all'` — Group B + C. Visible to every profile.

The MCP dispatcher's `tools/list` handler filters by profile before returning. `tools/call` similarly rejects Group A calls when `ctx.profile === 'power'`.

### 3.2 Profile resolution

Priority order (highest wins):
1. Token type — a power-user access token (`type: 'power-user'`) always implies `power` profile.
2. URL param — `?profile=power` when `isSuperuser` (engineer testing the power view).
3. Default — `engineer` (today's behavior, all tools visible).

Set on `ctx.profile: 'engineer' | 'power'`.

### 3.3 Installer flag

```
install-standalone-mcp.sh [--profile=engineer|power]
```

- Default: `--profile=engineer` (today's behavior exactly; no change for existing installs).
- `--profile=power`: writes `papercusp-su-power.tools.md` to `~/.papercusp/engineer-collaborator.md` instead of `papercusp-su-engineer.tools.md`, and appends `&profile=power` to the `mcp_url` in `mcp.json`.
- Re-runs are idempotent per profile: same profile = token reused, playbook refreshed, no disruption.

### 3.4 `omp-su` wrapper update

```bash
PAPERCUSP_PROFILE="${PAPERCUSP_PROFILE:-engineer}"
PLAYBOOK="${HOME}/.papercusp/engineer-collaborator.md"
exec omp \
  --append-system-prompt "$PLAYBOOK" \
  -e "${HOME}/.papercusp/papercusp-coord.ts" \
  "$@"
```

The playbook file content already reflects the profile (installer chose which one to write there); the wrapper just passes it through. No change to the wrapper template is strictly needed — the installer's choice of content is the gate.

### 3.5 Group A tagging scope

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
- `plans:launch` / `plans:resume` / `plans:promote` — engineer (write-side, not safe for untrusted power users)
- `cross_harness:*` (6 tools) — engineer (power users use the harness-scoped variants)
- `operator:scan` / `operator:converse` / `operator:delegate` — engineer

Group B + C (visible to both profiles) are everything else.

This is a mechanical tag sweep — no behavior changes, just metadata.

## §4 Items

### Phase 1 — core gate

- **P-001** `needs-human` Ratify the three-part design: (a) `profile` field on `defineTool`, (b) `tools/list` filter in dispatcher, (c) `ctx.profile` resolution. See §3.1–3.2. Recommendation: proceed with design as written.
- **P-002** `todo` Add `profile?: 'engineer' | 'power' | 'all'` to `ToolDefinition` type. blocked-by: P-001
- **P-003** `todo` Extend dispatcher to resolve `ctx.profile` from token type + URL param. blocked-by: P-001
- **P-004** `todo` Filter `tools/list` + reject `tools/call` for out-of-profile tools. blocked-by: P-003
- **P-005** `todo` Tag all ~150 Group A tools with `profile: 'engineer'`. blocked-by: P-002

### Phase 2 — installer + wrapper

- **P-006** `todo` Extend `install-standalone-mcp.sh` with `--profile=engineer|power` per §3.3. blocked-by: P-004 (need to verify gate works before shipping install path)
- **P-007** `todo` Update `omp-su` wrapper template per §3.4. blocked-by: P-006
- **P-008** `todo` Update `/api/agent-bundle` to serve `papercusp-su-power.tools.md` when caller has power-user token. blocked-by: P-004

### Phase 3 — verification

- **P-009** `todo` Test: power-user token → `tools/list` returns only Group B + C (no Group A). blocked-by: P-005
- **P-010** `todo` Test: SU caller with `?profile=power` → same filtered list. blocked-by: P-005
- **P-011** `todo` Test: engineer profile → all tools visible (no regression). blocked-by: P-005
- **P-012** `todo` Flip `playbook-audience-neutral-rewrite-2026-05-23` P-010 / P-011 to `done` once above tests pass.

## §5 Dependencies

- **Depends on:** `playbook-audience-neutral-rewrite-2026-05-23` (playbook files already split — done).
- **Depends on:** `per-harness-plans-and-docs-2026-05-23` (Group C generalization — done).
- **Unblocks:** `playbook-audience-neutral-rewrite-2026-05-23` P-010 / P-011.

## Decisions

(none yet — appended as `### D-NNN — title` when P-001 is ratified.)
