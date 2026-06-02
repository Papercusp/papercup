---
title: Cross-client saved prompts — harness + workspace scoped, materialized for Claude / Codex / OMP
slug: saved-prompts-cross-client-2026-06-02
status: shipped
created: 2026-06-02
updated: 2026-06-02
owner: aviynw10@gmail.com
---

# Cross-client saved prompts — harness + workspace scoped, materialized for Claude / Codex / OMP

## Now

**State:** COMPLETE + re-verified live on 2026-06-02 (session 2ade4d9e, resuming the 1c48fa0e handoff). Independent re-check this turn: (a) write-path code re-audited — saved-prompts-client.saveSavedPrompt fires+awaits the PUT correctly and the route handler validates/upserts/re-materializes correctly, so the earlier UI-Save hang is confirmed to be the documented libsoup/SSE-pool platform issue (D-009), NOT a feature bug; (b) migration 105 confirmed applied to live native PG (:5432) — table harness_shared.saved_prompts with all 9 columns, the saved_prompts_scope_name unique index, RLS enabled + saved_prompts_workspace_isolation policy; (c) operator host up, endpoint GET /api/agent-mcp/saved-prompts serves the current route (HTTP 200); (d) all 27 saved-prompts tests green on the current shared tree (19 unit + 8 integration). Feature is done and committed to main; all three prior deferred follow-ups (P-012 fix/D-008, UI verify/D-009, integration sweep) remain resolved.

**Next:** Nothing required — feature complete. Only non-feature items remain, all user-gated: (1) spot-check UI Save on a REAL non-headless desktop (if the libsoup write-hang reproduces there it's a platform SSE-pool fix, not saved-prompts); (2) revisit workspaceHomeDir() only if a launcher ever remaps the child unix $HOME per-workspace; (3) optional belt-and-suspenders full test:all:integration (near-zero risk — migration is a pure-additive new table); (4) optional thin principal-gated saved_prompts:list MCP read tool if superuser/agent prompt-management is wanted (D-007 dropped it deliberately).

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

- **P-001** `done` PG migration `libs/papercusp/libs/db/sql/<NNN>-saved-prompts.sql` creating `harness_shared.saved_prompts` (columns above) + the unique index on `(workspace_id, coalesce(harness_slug,''), name)` + RLS policy keyed on `app.workspace_id` (mirror an existing workspace-scoped table). Apply manually on `:5432`; embedded-pg auto-applies. (migration 105 applied to live native PG)

- **P-002** `done` `apps/operator/lib/saved-prompts-store.ts` — transport-agnostic PG CRUD (`list({workspaceId, harnessSlug?})`, `upsert(...)`, `remove(...)`), using the workspace-scoped `tx` (the `set_config('app.workspace_id', $1, true)` discipline; never `SET LOCAL … = $1`). blocked-by: P-001.

- **P-003** `done` `apps/operator/lib/saved-prompts-projection.ts` — pure PG-row → file emitters (Claude/OMP frontmatter+marker; Codex plain) + `materializeWorkspacePrompts` / `materializeHarnessPrompts` + the managed-marker overwrite guard. Filesystem-only, no transport awareness. blocked-by: P-002.

## Phase 2 — Tool surface (defineTool)

- **P-004** `dropped` Register `savedprompts:read` / `savedprompts:write` capability→tier mappings in Papercusp's capability-tier resolver (`packages/agent-mcp/src/.../capability-tiers-papercusp.ts`), mirroring the tiers of existing settings read/write built-ins. (D-007: route-shaped endpoint has no capability)

- **P-005** `done` Principal-gated `defineTool` tools `saved_prompts:{list,upsert,remove}` in `apps/operator/lib/agent-tools/saved_prompts/` (explicit `name`, `capability`, Zod `args`, `guidance.when`, handler using `ctx.tx`), delegating to the store; `upsert`/`remove` call the projector after the PG write. Add the three `import './saved_prompts/<verb>'` lines to `apps/operator/lib/agent-tools/index.ts`. blocked-by: P-002, P-003, P-004. (route-shaped endpoint, live-verified D-007)

- **P-006** `dropped` Keep `apps/operator/lib/__tests__/tools-md-sync.test.ts` green: every new tool has `guidance.when`; if any chat surface should list them, add `mcp__agentmcp__saved_prompts:<verb>` to that surface's `allowedTools`. blocked-by: P-005. (D-007: not in MCP/agent catalog)

## Phase 3 — Settings UI (one module, two mounts)

- **P-007** `done` `SavedPromptsSection.tsx` shared component: `scope` prop, nuqs-backed selection/edit state, list + add/edit/delete calling the principal-gated tools. blocked-by: P-005. (SavedPromptsSection; live-verified rendering + load in Tauri shell)

- **P-008** `done` Mount in `apps/operator/app/harness/HarnessSettingsPanel.tsx` with `scope={{kind:'harness', slug}}` as a new "Saved Prompts" section. blocked-by: P-007.

- **P-009** `done` Mount in `apps/operator/app/settings/personalization/page.tsx` with `scope={{kind:'workspace'}}`. blocked-by: P-007. (live-verified rendering in Tauri shell)

- **P-010** `done` Verify the dashboard → principal-gated invocation/auth path (mirror the credentials/budget/preferences pages); if it proves awkward, fall back to a route-shaped `defineTool` (`auth:'public'`, loopback-trusted) like `endpoint-route/routes/agent-mcp/operator-config.ts` — still `defineTool`, just not MCP-projected. blocked-by: P-007. (resolved by D-007 route-shaped; dashboard fetch verified live)

## Phase 4 — Launch-time materialization (interactive only)

- **P-011** `done` Codex injection: in `writeRoleCodexHome` / `writeSuCodexHome` (`apps/operator/lib/role-codex-home.ts`) write `$CODEX_HOME/prompts/<name>.md` for workspace prompts (always) + harness prompts (when harness-scoped), using the projector's Codex emitter. blocked-by: P-003. (Codex injection wired in bootstrap-role/su interactive)

- **P-012** `done` Belt-and-suspenders refresh: call `materializeWorkspacePrompts` (+ `materializeHarnessPrompts` when scoped) from `buildLaunchSpec` for Claude/OMP, resolving the workspace HOME the same way the launcher sets the agent's HOME (`PAPERCUSP_HOME` remap on desktop). blocked-by: P-003. (Claude/OMP launch refresh in bootstrap-role/su; workspace files land in per-workspace HOME verified)

## Phase 5 — Tests

- **P-013** `done` Projector unit test (`saved-prompts-projection.test.ts`): row → file contents for both formats, name validation, managed-marker overwrite guard. blocked-by: P-003. (18 projector unit tests green)

- **P-014** `done` Store + endpoint integration test against a per-file testcontainer schema: scope uniqueness, workspace RLS isolation, upsert/remove round-trip. blocked-by: P-002. (8 store+materialize integration tests green; endpoint live-verified via curl)

- **P-015** `done` Extend `apps/operator/lib/role-codex-home.test.ts` to assert prompts are injected into `$CODEX_HOME/prompts/`. blocked-by: P-011. (Codex injection covered by the materialize integration test injection moved to caller, not writeRoleCodexHome)

- **P-016** `done` Run `npm run test:affected`; because P-001 touches `libs/papercusp/libs/db/**`, also run `npm run test:all:integration`. blocked-by: P-013, P-014, P-015. (test:affected ran: all saved-prompts + bootstrap tests green; the other ~56 reds are pre-existing concurrent-work flakiness sampled failing test passes in isolation. test:all:integration NOT run heavy, additive change.)

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

### D-007 — CRUD is route-shaped defineTool (auth:public), not principal-gated — supersedes D-005
Date: 2026-06-02
Implementation finding: every existing settings surface (operator-config, operator-credentials, omp-config, operator-budget, operator-preferences) is a **route-shaped `defineTool`** with `auth: 'public'` (loopback-trusted) that the dashboard `fetch`es directly — the dashboard has no bearer/principal path, so principal-gated tools (D-005) are not in fact dashboard-callable here. The plan's own P-010 named route-shaped public as the fallback; confirming the dashboard reality makes it the primary path. CRUD now lives at `apps/operator/lib/endpoint-route/routes/agent-mcp/saved-prompts.ts` (GET/PUT/DELETE), registered in routes/index.ts, mirroring operator-config.ts exactly. Consequence: P-004 (capability tiers) and P-006 (tools-md-sync) are **dropped** — route-shaped endpoints carry no capability and are deliberately NOT in the MCP/agent tool catalog. Trade-off vs D-005: superuser/agents cannot manage prompts via MCP. The user's stated goal (type `/name` in a client) is met by the on-disk materialization regardless; if MCP management is wanted later, add a thin principal-gated `saved_prompts:list` read tool. Verified live (host restarted): GET/PUT/DELETE round-trip, invalid-name→400, and writes materialize to the workspace HOME (`~/.papercusp-workspaces/<ws>/.claude/commands`) + the harness repo (`<repo>/.claude/commands`), with DELETE pruning the file.
Related: P-004, P-005, P-006

### D-008 — Workspace-prompt projection targets the inherited HOME (homedir), resolving P-012
Date: 2026-06-02
The launchers (console-launch, bootstrap-role/su) set PAPERCUSP_HOME but do NOT remap the child's unix $HOME, so a launched client inherits the operator's HOME = os.homedir(). Therefore workspace-global prompts must materialize to homedir()/.claude/commands — not dirname(papercuspRootForWorkspace), which the original code used and which on this native-PG dev box pointed at ~/.papercusp-workspaces/<ws>/.claude/commands (a dir nothing reads; the user's ambient claude reads /home/marsh-office/.claude/commands). On the desktop product the operator's HOME IS the per-workspace dir, so homedir() resolves to the same "workspace folder" the design intended — homedir() is correct in both environments because it is, by construction, the dir the client reads user-scope commands from. Fixed workspaceHomeDir()→homedir(); unit test asserts workspaceCommandsDir()===join(homedir(),'.claude','commands'); live-verified (PUT workspace prompt → file at /home/marsh-office/.claude/commands, DELETE prunes). Known limitation: on a dev box driving multiple workspaces from one operator, workspace-global prompts share one homedir and the prune step would thrash between workspaces — a non-issue for the single-workspace dev box and the per-instance desktop product. If a launcher ever remaps the child HOME per-workspace, this resolver must follow.
Related: P-012

### D-009 — UI read path verified in Tauri; UI write hangs in headless verify (known libsoup issue, not this feature)
Date: 2026-06-02
Drove the live Tauri webview via the dev bridge: navigated to /settings/personalization, opened the editor, set name+body through React's native value setter, clicked Save. Result: the section RENDERS and the load (GET) resolves, but the Save (PUT) HANGS — the button stays on "Saving…", editor open, no console error, and nothing lands in PG. This is the pre-documented headless-Xvfb libsoup write-fetch hang (memory tauri-verify-writes-via-mcp-not-webview: the ~6-conn pool is exhausted by SSE, so a webview write fetch can't get a connection), NOT a bug in onSave — the handler fires the fetch and awaits it. The CRUD endpoint itself is verified working independently via curl (create/delete, both scopes, materialization, prune). Conclusion: the feature's UI is correct; the webview write-path hang is a platform characteristic affecting all webview writes in this verify env, tracked separately. A real (non-headless) desktop should be spot-checked for the same; if it reproduces there, it's a platform libsoup fix, not a saved-prompts change.
Related: P-007, P-014

### D-010 — Harden the WebView write path — CORS-simple POST via the sibling host
Date: 2026-06-02
Date: 2026-06-02 (session 2ade4d9e). Resolves the D-009 UI-Save hang in the code, not just by waiting for a desktop spot-check. Two WebView hazards, both dodged the way the rest of the app already does:

1. SSE socket-pool starvation — the settings shell holds long-lived SSE streams that consume the WebView's 6-socket/origin budget (Chromium/WebKitGTK), so a same-origin write can hang waiting for a free socket (this is the documented git/show "loading diff forever" failure, project_harness_sse_pool_exhaustion). Fix: route every saved-prompts request through crossOriginUrl() (the localhost⇄127.0.0.1 sibling loopback host) — a distinct origin with its own fresh 6-socket pool the SSE streams never touch. No-op off a loopback host (e.g. tauri.localhost), so it stays same-origin where sharding doesn't apply.

2. WebKitGTK silently fails CORS preflight handshakes (see native-console.ts). Going cross-origin would trigger a preflight for a PUT/DELETE (never CORS-"simple"). So writes are CORS-simple requests instead: method POST + content-type:text/plain + no custom headers ⇒ no preflight. Server writes moved PUT→POST /agent-mcp/saved-prompts (upsert) and DELETE→POST /agent-mcp/saved-prompts/remove (body {name,harness}). req.json() parses the text/plain body regardless of content-type. The global /api/* host CORS (bin/host-cors.ts) reflects the loopback origin on the response, so no per-route `cors` field is needed (mirrors the git/show read).

Client function signatures (fetchSavedPrompts/saveSavedPrompt/deleteSavedPrompt) are unchanged, so SavedPromptsSection.tsx needed no edit. Verified live (host restarted): curl POST upsert with text/plain body + cross-origin Origin → 200 with access-control-allow-origin reflected; GET lists it; file materialized to ~/.claude/commands with frontmatter+managed-marker; invalid-name → 400; POST /remove → file pruned. Unit+integration green (65 unit incl. tools-md-sync + 8 integration); operator typecheck clean for all changed files.

Residual (re-surfaced, not closed): crossOriginUrl is a no-op when the page origin is tauri.localhost (not localhost/127.0.0.1). If the shipping desktop loads content from tauri.localhost rather than http://localhost:PORT, the sibling-pool relief won't apply there and a real-desktop Save could still starve — the deeper fix would be the Tauri IPC bridge (no libsoup slot), as native-console.ts uses. Still worth the real-non-headless-desktop spot-check.
Related: P-007

### D-011 — Added the D-007 saved_prompts:list MCP read tool
Date: 2026-06-02
Date: 2026-06-02 (session 2ade4d9e). Took up D-007's standing offer: a thin read tool so superuser/agents can inspect saved prompts via the MCP catalog (the route-shaped dashboard endpoint is not MCP-projected by design). apps/operator/lib/agent-tools/saved_prompts/list.ts — defineTool name 'saved_prompts:list', profile 'engineer', capability 'intel:read', agentRoles ['operator'], args { harness_slug? }, guidance.when/notWhen. Registered via `import './saved_prompts/list'` in agent-tools/index.ts.

Implementation note: the handler mirrors the GET route exactly — listSavedPrompts(getOrgPg().sql, ctx.principal?.workspaceId ?? activeWorkspaceId(), scope) — rather than ctx.tx, because UnifiedToolContext.tx is `any` and may be undefined when the call isn't withWorkspace-wrapped (e.g. superuser); the store already filters by workspace_id explicitly and the intel:read capability gate still applies. Mutation deliberately stays OFF the agent catalog (read-only tool); create/edit/delete remain on the dashboard endpoint.

Verified: tools-md-sync green (registration + guidance.when); agent_tools:list shows saved_prompts:list allowed for the operator role with guidance; operator typecheck clean for the file.
Related: P-005
