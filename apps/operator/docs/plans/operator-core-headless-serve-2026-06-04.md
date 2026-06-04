---
title: SP1 — Extract @papercusp/operator-core + `papercusp serve` (headless, UI-decoupled)
slug: operator-core-headless-serve-2026-06-04
status: draft
created: 2026-06-04
updated: 2026-06-04
owner: aviynw3@gmail.com
---

# SP1 — Extract @papercusp/operator-core + `papercusp serve` (headless, UI-decoupled)

## Now

**State:** Design spec drafted from a brainstorming session (2026-06-04). All major forks decided (see Decisions). Awaiting human review of this spec before it is broken into formal plan items.

**Next:** Human reviews this spec → on approval, convert the "Implementation plan" below into tracked plan items (`plans:add-item`) and start C1 (`bin/serve.ts`).

## Background — the roadmap this belongs to

This is **SP1**, the keystone of a larger goal: **run the full Papercusp substrate from a vanilla Claude Code session, with no Tauri desktop, ultimately distributed publicly as a Claude Code plugin.** In that end-state the Tauri desktop, the web SPA, and a new Claude Code plugin are all just *clients* of one shared headless backend.

The full roadmap (decided in the same session; not all in scope here):

- **SP1 (this plan)** — Extract `@papercusp/operator-core` runnable as `papercusp serve`: headless, owns its own embedded Postgres + lifecycle, serves no UI by default, writes a discovery file. Desktop becomes an embedder. *Audience-independent — identical for every distribution tier, which is why it is first.*
- **SP2** — Auth redesign for multi-user/public: drop `?superuser=1` as the default, per-user scoped tokens, enforced gating, loopback-bind by default. *Required before public.*
- **SP3** — The Claude Code plugin package: `.mcp.json` (http + `headersHelper`), `PreToolUse` lock hook, `SessionStart` bootstrap + identity, playbook skill, `/papercusp:attach` command, role subagents. *This is literally "psu → plugin."*
- **SP4** — Cross-platform packaging + distribution + trust: embedded PG across mac/linux/win via npm per-platform `optionalDependencies` (esbuild/napi pattern, **not** committed to the plugin git), marketplace repo, community→official submission, documented consent story.
- **SP5 (optional)** — UI as an optional client: decide what GUI public plugin users get (nothing / desktop as a separate download / a re-blessed browser SPA via `serve --ui`). Reopens the retired-webapp decision in the new headless context.

Sequence: SP1 → (SP2 ∥ SP3) → SP4; SP5 anytime after SP1.

## Problem — where backend and UI are coupled today

The backend is already cleanly decoupled at the **code** level: every tool is a `defineTool({ method, path, auth, handler })` projected onto HTTP / MCP / IPC / in-process; `lib/agent-tools/**` has zero React imports; the SPA talks to the backend purely over HTTP and only imports operator React *components* (never backend modules). The real coupling is at three **packaging/process seams**:

1. **Asset serving** — the API host itself serves the built SPA (`apps/operator/bin/host-handler.ts:78` mounts `spaRoutes` from `host-spa.ts`). One process/port serves both `/api/*` and the UI.
2. **Process/bundle** — the Tauri Rust (`papercusp-desktop/src-tauri/src/main.rs`) spawns embedded Postgres + the Node operator sidecar as children and owns the whole bootstrap; there is no "just the backend" distributable.
3. **Discovery** — clients resolve the backend via `~/.papercusp/embedded-pg.json` + `~/.papercusp/superuser-token`, written by the desktop/installer.

**Latent bug found during scoping:** nothing actually writes `~/.papercusp/embedded-pg.json` today. The Rust references it but the write is missing; PG discovery limps on the `HARNESS_ADMIN_DATABASE_URL` env + the `localhost:5432` fallback in `apps/operator/lib/embedded-pg-discovery.ts:31-35`. Having `serve` own this write closes a real gap.

## Goals

- `papercusp serve` boots the entire operator headlessly on a clean machine: starts & owns embedded Postgres in-process, runs migrations, runs `runBootstrap()`, serves `/api/*` + `/api/mcp`, and **serves no UI by default**.
- `serve` writes `~/.papercusp/operator.json` (`{ httpUrl, port, token, pid, startedAt, version }`) and (fixing the gap) `~/.papercusp/embedded-pg.json`.
- `serve --ensure` is an idempotent singleton entrypoint: start if not running, else print discovery and exit 0. Safe for the future plugin `SessionStart` hook to call on every session.
- `@papercusp/operator-core` is a standalone npm package with a `bin` (`papercusp`) and **no dependency on any React/UI code**; `apps/operator` becomes the UI package depending on the core.
- The Tauri desktop is refactored to run/embed `serve` rather than owning PG + sidecar spawn; Rust shrinks to webview + IPC client + window/protocol management.

## Non-goals (explicitly deferred)

- Auth redesign / dropping superuser-by-default → **SP2**. SP1 keeps the current loopback + superuser-token model unchanged; `operator.json` just references the existing token.
- The Claude Code plugin itself → **SP3**.
- npm publishing + multi-platform PG binary packaging → **SP4**. SP1 makes the package *structurally* publishable and runnable via `tsx`/local; cross-platform binary delivery is SP4.
- Deciding the public UI story / re-blessing the browser SPA → **SP5**. SP1 only adds the `--ui` *flag* (default off).

## Target architecture

```
                +------------------------------------------------+
                |  @papercusp/operator-core - `papercusp serve`  |
                |  - Hono API + /api/mcp  (endpoint-system)      |
                |  - embedded Postgres (Node-managed, in-proc)   |
                |  - auth: current superuser token (SP2 reworks) |
                |  - singleton; writes ~/.papercusp/operator.json|
                +-----------------------+------------------------+
                  HTTP / SSE / MCP / IPC | (zero UI knowledge)
        +-----------------------+--------+----------------------+
   +----v-------------+  +------v---------+  +-----------------v-+
   | Claude Code      |  | Tauri desktop  |  | Web SPA (opt)     |
   | PLUGIN  (SP3)    |  | (embeds serve) |  | `serve --ui` (SP5)|
   +------------------+  +----------------+  +-------------------+
```

## Design decisions

### A · Full physical package extraction (not a facade)
Move `bin/` + all backend `lib/**` into a new `packages/operator-core` package; rename `apps/operator` (currently `@papercusp/web`) to the UI package depending on `@papercusp/operator-core`; rewrite imports and the `operator-vite` `@` alias accordingly. Chosen over a facade because of the pre-alpha "do it right now, no half-measures" stance — we end at the clean state, accepting one large diff. Mitigate fleet-conflict risk by doing the move under a held multi-file lock and an import codemod in as few passes as possible.

### B · `serve` owns embedded Postgres, in-process
Reuse the existing `@papercusp/embedded-postgres-server` Node package (today spawned as a child by Rust) but drive it **in-process** from `serve`: pick port (default 15432, override `PAPERCUSP_PG_PORT`) → ensure `PAPERCUSP_PG_DATA_DIR` → start → TCP-ready probe → **write `embedded-pg.json`** → run `PAPERCUSP_PG_SQL_DIR` migrations → `runBootstrap()`. One process tree, one clean shutdown path. `PAPERCUSP_USE_EMBEDDED_PG=0` + `HARNESS_ADMIN_DATABASE_URL` lets `serve` attach to an external PG instead.

### C · Cold-start singleton via OS flock; DB locks for runtime only
The DB-backed named resource locks (`dev-server`, the `dev:restart` drain protocol in `lib/agent-tools/dev/restart.ts`) need the DB *up*, so they cannot guard cold start (chicken/egg). Use an OS `flock` on `~/.papercusp/operator.lock` + a pid/health check for the startup race; keep the named resource locks for *runtime* drain/restart/migrate. `serve --ensure` checks `operator.json` (pid alive + `/health` OK) → reuse; else acquire flock → start. Two concurrent `serve --ensure` calls converge on one backend.

### D · New `~/.papercusp/operator.json` discovery file
`{ httpUrl, port, token, pid, startedAt, version }`, written atomically by `serve` after the host is listening, removed/invalidated on shutdown. Sits alongside `embedded-pg.json` (PG) and `endpoint-ipc.json` (IPC socket). This is the single file the SP3 plugin's `headersHelper` will read for MCP url + bearer. SP1 populates `token` from the existing `~/.papercusp/superuser-token`.

### E · SPA serving is opt-in, default off
`serve` is headless by default. `serve --ui` (or `PAPERCUSP_SERVE_UI=1`) mounts `spaRoutes`; otherwise the catch-all returns 404. This is the literal "decouple backend from UI": the API host no longer has any UI responsibility unless explicitly asked. The API→SPA data flows are one-way (`api/flags/bootstrap`, `window.__PAPERCUSP_WS__`) and no API route assumes the SPA is co-served, so this is a clean conditional at `host-handler.ts:78`.

### F · Desktop becomes an embedder (riskiest, sequenced last)
Replace the Rust embedded-PG spawn + sidecar spawn (`main.rs` ~1235-1400) with: spawn `papercusp serve --ensure` (or run the core in the existing sidecar slot) → read `operator.json` → point the webview at it. PG port selection, ready-check, and the `embedded-pg.json` write all move out of Rust into the Node `serve` command. Rust retains webview, IPC client, custom `papercusp://` protocol, window management, PTY, workspace `HOME` isolation, update checker. Net: Rust shrinks substantially.

## Implementation plan (Phase 1 — to be converted to plan items on approval)

1. **C1 — `bin/serve.ts` orchestrator (headless).** Start embedded PG in-process (B) → write `embedded-pg.json` → run migrations → `runBootstrap()` → `host.listen`. No SPA. Foundation for everything else.
2. **C2 — SPA opt-in.** Gate `spaRoutes` behind `--ui` / `PAPERCUSP_SERVE_UI` at `host-handler.ts:78` (E). *(after C1)*
3. **C3 — `operator.json` + singleton.** Atomic discovery writer (D), flock cold-start guard + pid/health reuse, `serve --ensure` (C). *(after C1)*
4. **C4 — Full package carve.** Create `packages/operator-core` (package.json with `bin`, tsconfig); move `bin/**` + backend `lib/**`; rename `apps/operator`→UI package; rewrite imports + the `operator-vite` `@` alias; bundle/resolve the migrations SQL dir for the package (A). *(after C1; largest diff — held lock + codemod)*
5. **C5 — Desktop embedder refactor.** Swap Rust PG+sidecar spawn for `serve --ensure` + `operator.json` read; trim moved responsibilities (F). *(after C3, C4; riskiest — may spin out if it grows)*
6. **C6 — Tests + verification.** See Testing. *(continuous; gating before close)*

## Testing

Per the repo's four canonical homes (`CLAUDE.md`):
- **Vitest / integration:** `serve` boots on a *clean* `HOME` (temp dir) — PG starts, migrations apply, `/health` + `/api/mcp` reachable over HTTP; `operator.json` + `embedded-pg.json` written with correct fields; `serve --ensure` twice yields one backend (singleton dedup); clean shutdown removes/invalidates discovery + releases flock.
- **`serve --ui`** mounts the SPA; default `serve` returns 404 on UI routes but 200 on `/api/*`.
- **Cargo + manual Tauri (`/internal/docs/testing/agent-e2e`, dedicated Xvfb `DISPLAY=:99` instance):** the desktop still launches, reaches the embedded backend, and renders the operator after the embedder refactor (C5). Never drive the user's live `:0` window.
- **`npm run test:affected`** green before close.

## Risks & mitigations

- **C4 megadiff vs the running fleet.** Largest risk. Mitigate: hold a multi-file `locks:acquire` across the move, drive it with a mechanical import codemod, land in as few passes as possible, announce via `coord:declare-intent`.
- **In-process PG lifecycle leaks.** A crashed `serve` could orphan a postmaster. Mitigate: flock + pidfile, and a startup sweep that adopts or reaps a stale postmaster on the data dir.
- **Migrations SQL dir resolution in a published package.** `PAPERCUSP_PG_SQL_DIR` is path-based today. Mitigate: bundle migrations into the package and resolve relative to the package root.
- **C5 desktop regressions.** The Rust path is sensitive (focus-steal rules, custom protocol). Mitigate: sequence last, behind a dedicated-Xvfb e2e gate; allow it to spin out into its own follow-on plan if it grows beyond a clean swap.

## Decisions

### Goal: Papercusp in vanilla Claude Code, public distribution
2026-06-04 — The end-state is using the full Papercusp substrate from a plain Claude Code session with no Tauri desktop, distributed publicly as a Claude Code plugin. The desktop becomes one client among several. Public is the destination; the build order is unchanged by it because SP1 (decoupling) is audience-independent.

### Decompose into SP1–SP5; SP1 first
2026-06-04 — Public distribution makes this a multi-subsystem product, decomposed into SP1 (core), SP2 (auth), SP3 (plugin), SP4 (packaging/distribution), SP5 (optional UI). SP1 is the keystone every other SP depends on and is identical for every audience, so it is specced and built first.

### Session model flips to launch-then-attach
2026-06-04 — A plugin loads *into* a running session; it cannot run psu's picker, mint the tracked session pre-launch, or exec with `--append-system-prompt`. So (in SP3) the plugin's `SessionStart` hook registers the session + injects the playbook, and `/papercusp:attach` scopes to a harness lazily. psu's *installer* job becomes the plugin; psu's *launcher* job dissolves into hooks + an attach command. Recorded here because it shapes what SP1's discovery file must expose.

### Bundle-everything-in-plugin rejected
2026-06-04 — Plugins are git-cloned read-only with no install-time execution, so a "plugin spawns everything" model would require committing per-platform PG binaries to the marketplace git and would still need singleton discovery (per-session spawns fragment coord/locks/PG — the whole value). Instead: a thin plugin whose `SessionStart` ensures a singleton `serve` (npx-delivered or bundled bin), which sidesteps the read-only constraint and auto-updates. This is why SP1 must produce an idempotent `serve --ensure` + discovery file.

### Full physical extraction now (not a facade)
2026-06-04 — Per the pre-alpha "do it right now, no half-measures" stance, SP1 physically moves backend code into `packages/operator-core` and demotes `apps/operator` to the UI package, rather than shipping a facade entrypoint and deferring the move. Accept one large diff; mitigate fleet conflict with a held lock + codemod.

### Cold-start singleton uses OS flock, not DB locks
2026-06-04 — DB-backed named resource locks need the DB up and cannot guard cold start. Use an OS flock + pid/health check for the startup race; reserve the named resource locks (and the `dev:restart` drain protocol) for runtime restart/migrate coordination.
