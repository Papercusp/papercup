---
title: Cross-client saved prompts — harness + workspace scoped, materialized for Claude / Codex / OMP
slug: saved-prompts-cross-client-2026-06-02
status: draft
created: 2026-06-02
updated: 2026-06-02
owner: aviynw10@gmail.com
---

# Cross-client saved prompts — harness + workspace scoped, materialized for Claude / Codex / OMP

## Now

**State:** Design approved via brainstorming (2026-06-01); plan drafted, no code yet. The four forks are locked (see Decisions): PG is the canonical store and the on-disk command files are a deterministic projection (D-001); the Claude command format is the shared surface for Claude **and** OMP, with Codex the only second format (D-002); harness-scoped prompt files are committed to the harness repo (D-003); only interactive sessions consume these — no orchestrator/autonomous-spawn changes (D-004); CRUD is exposed as principal-gated `defineTool` tools, not bespoke REST (D-005).

**Next:** Human reviews this plan. On approval, execute Phase 1 (PG table + store + projector) before any UI.

## Background

The user wants a "saved prompts" feature: a reusable-prompt module that appears in **both** the per-harness settings page and the global **Personalization** settings page (the same module, different scope). Harness-scoped prompts should live in the harness folder; workspace-scoped (global) prompts in the workspace folder. The prompts must be invokable as `/name` slash commands inside all three coding-agent clients Papercusp launches: **Claude Code, Codex, and OMP**.

Exploration of the codebase (2026-06-01) established the constraints this design fits:

- **Three clients, already unified** through `buildLaunchSpec` (`apps/operator/lib/role-launch-spec.ts`). Prompt + MCP reach each client differently:
  - **Claude / OMP** — via CLI flags; slash commands are read from disk at `~/.claude/commands/<name>.md` (user scope) and `<repo>/.claude/commands/<name>.md` (project scope).
  - **Codex** — no per-launch prompt/MCP flags. The repo already materializes a **fresh, ephemeral per-session `$CODEX_HOME`** (`apps/operator/lib/role-codex-home.ts`: `writeRoleCodexHome` / `writeSuCodexHome`) holding `AGENTS.md` + `config.toml`. Codex custom prompts live in `$CODEX_HOME/prompts/<name>.md`.
- **OMP reads Claude command files natively.** `omp config list` shows `commands.enableClaudeUser = true`, `commands.enableClaudeProject = true`, `recipe.enabled = true`. So writing Claude-format command files means Claude Code **and** OMP both pick them up — no separate OMP format. OMP's config dir is `~/.omp/agent/`.
- **"Harness folder" = the harness's registered repo dir**; **"workspace folder" = the workspace HOME** (in the desktop build `$HOME` is remapped to the workspace dir, so `~/.claude/commands` *is* the workspace folder). The user's folder intuition maps cleanly onto both client surfaces.
- **Storage policy here is "Postgres by default"** and explicitly warns against the "file is primary, PG is a best-effort mirror that drifts" anti-pattern. Hence PG-canonical + deterministic projection, not files-canonical.
- **The tool/endpoint system** is built on `defineTool` (`libs/generic/tooldef`). Its **principal-gated** shape (the default) is documented as the home for "settings reads/writes, credentials, budget, **preferences**" — dashboard- and superuser-callable, not spawn-URL-agent-callable. That is exactly this feature's posture.

## Architecture

### Data model — one PG table (canonical)

`harness_shared.saved_prompts` (migration `libs/papercusp/libs/db/sql/<NNN>-saved-prompts.sql`):

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `workspace_id` | text not null | RLS-scoped |
| `harness_slug` | text null | NULL ⇒ workspace-global; a slug ⇒ harness-scoped |
| `name` | text not null | the slash command; validated `^[a-z0-9][a-z0-9-]*$` → `/name` |
| `body` | text not null | prompt markdown (supports `$ARGUMENTS`, `$1`…`$9`) |
| `description` | text null | shown in pickers + frontmatter |
| `arg_hint` | text null | maps to Claude `argument-hint` |
| `created_at` / `updated_at` | timestamptz | |

Unique on `(workspace_id, coalesce(harness_slug,''), name)`. Auto-applies under embedded-pg's migration runner; on this native `:5432` dev box it is applied manually (`psql "$DATABASE_URL" -f`).

### Projector — pure fn, PG row → on-disk files

`apps/operator/lib/saved-prompts-projection.ts`. Two emitters (because Claude + OMP share one format):

- **Claude/OMP** → `.claude/commands/<name>.md`: frontmatter (`description`, `argument-hint`) + body. First body line carries a managed marker `<!-- papercusp:managed -->`; the projector **refuses to overwrite a same-named file lacking the marker** (warns instead) so a hand-authored command is never clobbered (D-006).
- **Codex** → `prompts/<name>.md`: plain body (Codex takes the filename as the command name).

Materializers: `materializeWorkspacePrompts(workspaceId)` → the workspace HOME's `.claude/commands/`; `materializeHarnessPrompts(workspaceId, slug)` → `<harness repo>/.claude/commands/` (committed — D-003). The projector is filesystem-only (no transport awareness) so it is reusable from both the CRUD handlers and the launch path.

### Tool surface — principal-gated `defineTool` (D-005)

Three tools in `apps/operator/lib/agent-tools/saved_prompts/` (explicit `name`, since the dir is `agent-tools`, not `tools`, so name-derivation will not fire):

- `saved_prompts:list` — read capability; lists rows for a scope (`{ harnessSlug? }`).
- `saved_prompts:upsert` — write capability; upserts a row, then re-materializes the affected scope.
- `saved_prompts:remove` — write capability; deletes a row, then unlinks the projected file(s).

Each is principal-gated (handler gets `ctx.tx`, the workspace-scoped/RLS transaction, + `ctx.principal`), self-registers via `export default defineTool({...})` + an `import './saved_prompts/<verb>'` line in `apps/operator/lib/agent-tools/index.ts`, and carries `guidance.when`. They auto-project to **both** the MCP catalog (superuser/engineer can manage prompts) and the HTTP endpoint at `/api/agent-tools/saved_prompts/<verb>`. The transport-agnostic PG CRUD lives in `apps/operator/lib/saved-prompts-store.ts` so the handlers stay thin.

### Settings module — one component, two mounts

`SavedPromptsSection.tsx` (shared), prop `scope: { kind: 'workspace' } | { kind: 'harness'; slug: string }`. List + add/edit (name, description, arg-hint, body editor) + delete. Selection / edit-open state lives in **nuqs** (`?prompt=<name>`, `?promptEdit=1`) per the repo's nuqs rule. The dashboard invokes the principal-gated tools the same way the credentials/budget/preferences settings pages call their built-ins.

- Harness mount → `apps/operator/app/harness/HarnessSettingsPanel.tsx`, `scope={{kind:'harness', slug}}`.
- Global mount → `apps/operator/app/settings/personalization/page.tsx`, `scope={{kind:'workspace'}}`.

### Launch-time materialization (interactive only — D-004)

- **Codex** (ephemeral per-session home): inside `writeRoleCodexHome` / `writeSuCodexHome`, after building the home, write workspace prompts (always) + harness prompts (when the session is harness-scoped) into `$CODEX_HOME/prompts/`.
- **Claude / OMP**: files are already on disk (materialized on save); `buildLaunchSpec` does a belt-and-suspenders `materialize*` refresh so a session is never stale. Workspace HOME is resolved the way the launcher sets the agent's HOME (desktop `PAPERCUSP_HOME` remap), not raw `homedir()`.
- **No orchestrator / autonomous-spawn changes.**

## Phase 1 — Data + core (no UI)

- **P-001** `todo` PG migration `libs/papercusp/libs/db/sql/<NNN>-saved-prompts.sql` creating `harness_shared.saved_prompts` (columns above) + the unique index on `(workspace_id, coalesce(harness_slug,''), name)` + RLS policy keyed on `app.workspace_id` (mirror an existing workspace-scoped table). Apply manually on `:5432`; embedded-pg auto-applies.

- **P-002** `todo` `apps/operator/lib/saved-prompts-store.ts` — transport-agnostic PG CRUD (`list({workspaceId, harnessSlug?})`, `upsert(...)`, `remove(...)`), using the workspace-scoped `tx` (the `set_config('app.workspace_id', $1, true)` discipline; never `SET LOCAL … = $1`). blocked-by: P-001.

- **P-003** `todo` `apps/operator/lib/saved-prompts-projection.ts` — pure PG-row → file emitters (Claude/OMP frontmatter+marker; Codex plain) + `materializeWorkspacePrompts` / `materializeHarnessPrompts` + the managed-marker overwrite guard. Filesystem-only, no transport awareness. blocked-by: P-002.

## Phase 2 — Tool surface (defineTool)

- **P-004** `todo` Register `savedprompts:read` / `savedprompts:write` capability→tier mappings in Papercusp's capability-tier resolver (`packages/agent-mcp/src/.../capability-tiers-papercusp.ts`), mirroring the tiers of existing settings read/write built-ins.

- **P-005** `todo` Principal-gated `defineTool` tools `saved_prompts:{list,upsert,remove}` in `apps/operator/lib/agent-tools/saved_prompts/` (explicit `name`, `capability`, Zod `args`, `guidance.when`, handler using `ctx.tx`), delegating to the store; `upsert`/`remove` call the projector after the PG write. Add the three `import './saved_prompts/<verb>'` lines to `apps/operator/lib/agent-tools/index.ts`. blocked-by: P-002, P-003, P-004.

- **P-006** `todo` Keep `apps/operator/lib/__tests__/tools-md-sync.test.ts` green: every new tool has `guidance.when`; if any chat surface should list them, add `mcp__agentmcp__saved_prompts:<verb>` to that surface's `allowedTools`. blocked-by: P-005.

## Phase 3 — Settings UI (one module, two mounts)

- **P-007** `todo` `SavedPromptsSection.tsx` shared component: `scope` prop, nuqs-backed selection/edit state, list + add/edit/delete calling the principal-gated tools. blocked-by: P-005.

- **P-008** `todo` Mount in `apps/operator/app/harness/HarnessSettingsPanel.tsx` with `scope={{kind:'harness', slug}}` as a new "Saved Prompts" section. blocked-by: P-007.

- **P-009** `todo` Mount in `apps/operator/app/settings/personalization/page.tsx` with `scope={{kind:'workspace'}}`. blocked-by: P-007.

- **P-010** `todo` Verify the dashboard → principal-gated invocation/auth path (mirror the credentials/budget/preferences pages); if it proves awkward, fall back to a route-shaped `defineTool` (`auth:'public'`, loopback-trusted) like `endpoint-route/routes/agent-mcp/operator-config.ts` — still `defineTool`, just not MCP-projected. blocked-by: P-007.

## Phase 4 — Launch-time materialization (interactive only)

- **P-011** `todo` Codex injection: in `writeRoleCodexHome` / `writeSuCodexHome` (`apps/operator/lib/role-codex-home.ts`) write `$CODEX_HOME/prompts/<name>.md` for workspace prompts (always) + harness prompts (when harness-scoped), using the projector's Codex emitter. blocked-by: P-003.

- **P-012** `todo` Belt-and-suspenders refresh: call `materializeWorkspacePrompts` (+ `materializeHarnessPrompts` when scoped) from `buildLaunchSpec` for Claude/OMP, resolving the workspace HOME the same way the launcher sets the agent's HOME (`PAPERCUSP_HOME` remap on desktop). blocked-by: P-003.

## Phase 5 — Tests

- **P-013** `todo` Projector unit test (`saved-prompts-projection.test.ts`): row → file contents for both formats, name validation, managed-marker overwrite guard. blocked-by: P-003.

- **P-014** `todo` Store + endpoint integration test against a per-file testcontainer schema: scope uniqueness, workspace RLS isolation, upsert/remove round-trip. blocked-by: P-002.

- **P-015** `todo` Extend `apps/operator/lib/role-codex-home.test.ts` to assert prompts are injected into `$CODEX_HOME/prompts/`. blocked-by: P-011.

- **P-016** `todo` Run `npm run test:affected`; because P-001 touches `libs/papercusp/libs/db/**`, also run `npm run test:all:integration`. blocked-by: P-013, P-014, P-015.

## Decisions

### D-001 — PG canonical, on-disk files are a projection
2026-06-01 — The canonical store is the `saved_prompts` PG table; the `.claude/commands/*.md` and Codex `prompts/*.md` files are a deterministic projection regenerated on write + at launch. Chosen over files-canonical because the repo's storage policy is "Postgres by default" and explicitly warns against "file is primary, PG drifts." PG-canonical also gives a single uniform read/write API for both settings surfaces, listing/search, and a future cross-device sync. The user's "harness folder / workspace folder" intent is preserved as the projection target.

### D-002 — Claude command format is the shared surface for Claude + OMP; Codex is the only second format
2026-06-01 — `omp config list` confirms OMP natively reads Claude user + project commands (`commands.enableClaudeUser/Project = true`). So one Claude-format emitter serves Claude Code and OMP; only Codex (no project scope, ephemeral per-session `$CODEX_HOME`) needs a second emitter writing `$CODEX_HOME/prompts/`. This collapses "support 3 clients" into 2 on-disk formats.

### D-003 — Commit harness-scoped command files to the harness repo
2026-06-01 — `<harness>/.claude/commands/*.md` is version-controlled and shared: teammates and ambient Claude/OMP in that repo get the prompts automatically. This is the value of project scope. Workspace-scoped prompts go to the workspace HOME instead.

### D-004 — Interactive sessions only
2026-06-01 — Saved prompts are an interactive convenience (a human typing `/name` in a psu session or ambient Claude/Codex/OMP). Autonomous pipeline workers do not type slash commands, so the orchestrator/autonomous-spawn path is untouched — a smaller, focused change.

### D-005 — CRUD via principal-gated defineTool, not REST and not agent-callable
2026-06-01 — The endpoint docs place "settings reads/writes / preferences" on the principal-gated `defineTool` shape, which projects to both the dashboard HTTP endpoint and the MCP catalog and is callable by the dashboard + superuser but not spawn-URL agents — matching D-004. Avoids a bespoke REST handler (user directive) and avoids exposing prompt mutation to role-scoped agents. Fallback if dashboard→principal auth is awkward: a route-shaped `auth:'public'` `defineTool` (loopback-trusted), still not hand-rolled REST.

### D-006 — Managed-marker overwrite guard
2026-06-01 — Projected files carry a `<!-- papercusp:managed -->` marker; the projector refuses to overwrite a same-named file that lacks the marker (warns instead), so a user's hand-authored `.claude/commands/<name>.md` is never clobbered. Deletes only remove files we own.
