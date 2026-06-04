---
title: SP1 — Extract @papercusp/operator-core + `papercusp serve` (headless, UI-decoupled)
slug: operator-core-headless-serve-2026-06-04
status: active
created: 2026-06-04
updated: 2026-06-04
owner: aviynw3@gmail.com
---

# SP1 — Extract @papercusp/operator-core + `papercusp serve` (headless, UI-decoupled)

## Now

**State:** Autonomous loop, iteration 2 done. **C1+C3 written**: `apps/operator/bin/serve.ts` (additive headless orchestrator — in-process `startEmbeddedPostgresServer({dbSqlDir})`, sets `HARNESS_ADMIN_DATABASE_URL` before importing bootstrap/handler, writes `embedded-pg.json` {url,...} + `operator.json` {httpUrl,port,token,pid,...}, `runBootstrap()`+`serve()` with `PAPERCUSP_SERVE_UI=0`, O_EXCL pidfile cold-start lock + `--ensure` reuse-or-start + SIGINT/SIGTERM cleanup; helpers exported + entry-guarded for tests). **C2 written**: `host-handler.ts:78` SPA mount gated behind `PAPERCUSP_SERVE_UI` (default `'1'`/on → desktop untouched). Added `serve` npm script. All transpile-clean (esbuild). NOT yet runtime-tested. NOTE: a full boot must NOT run against the live native PG (`runBootstrap` starts background tickers that mutate the shared DB) — C6 will isolate via embedded-pg on a temp HOME + alt ports, or fall back to unit tests of the exported helpers if embedded-pg binaries are absent on this box.

**Next:** C6 — write + run tests: Vitest unit tests of serve.ts exported helpers (pidAlive, readOperatorDiscovery/writeJsonAtomic round-trip, acquire/releaseColdStartLock, readToken) on a temp HOME; integration boot gated on embedded-pg availability. Then move to the SP-TUI `apps/tui` crate.

## Background — the roadmap this belongs to

This is **SP1**, the keystone of a larger goal: **run the full Papercusp substrate from a vanilla Claude Code session, with no Tauri desktop, ultimately distributed publicly as a Claude Code plugin.** In that end-state the Tauri desktop, the web SPA, and a new Claude Code plugin are all just *clients* of one shared headless backend.

The full roadmap (decided in the same session; not all in scope here):

- **SP1 (this plan)** — Extract a headless, standalone-runnable operator core (`papercusp serve`): owns its own embedded Postgres + lifecycle, serves no UI when headless, writes a discovery file. Desktop becomes an embedder. *Audience-independent — identical for every distribution tier, which is why it is first.*
- **SP2** — Auth redesign for multi-user/public: drop `?superuser=1` as the default, per-user scoped tokens, enforced gating, loopback-bind by default. *Required before public.*
- **SP3** — The Claude Code plugin package: `.mcp.json` (http + `headersHelper`), `PreToolUse` lock hook, `SessionStart` bootstrap + identity, playbook skill, `/papercusp:attach` command, role subagents. *This is literally "psu → plugin."*
- **SP4** — Cross-platform packaging + distribution + trust: embedded PG across mac/linux/win via npm per-platform `optionalDependencies` (esbuild/napi pattern), marketplace repo, community→official submission, documented consent story.
- **SP5** — UI client = the ratatui terminal workbench (`tui-workbench-ratatui-2026-06-04`). The browser SPA / Tauri GUI demote to optional/fallback.

Sequence: SP1 → (SP2 ∥ SP3) → SP4; SP5 (the TUI) builds on SP1.

## Problem — where backend and UI are coupled today

At the **code** level the backend is *mostly* decoupled — `lib/agent-tools/**`, `lib/endpoint-route/**`, `lib/harness/**` carry **zero React imports**, and the SPA talks to the backend purely over HTTP — but **not 100%** (audit 2026-06-04): `apps/operator/lib/` has **~19 files importing from `app/`** (backend→UI back-edges), including a real runtime coupler `lib/chat-cards/AskChoiceCardEntry.tsx:13` (value-imports a React component) and several `.tsx` files living under `lib/` (`PluginReactTab.tsx`, `flag-hooks.tsx`, `router-compat/*.tsx`), plus shared types parked under `app/` (e.g. `app/harness/issues/types`, imported by backend routes `lib/endpoint-route/routes/harness/{issues,prs}.ts`). And `app/**` is **live** (operator-vite imports it via the `@/app` alias + `next/*` compat shims), with the **`finish-next-removal-2026-06-01`** refactor actively reworking that same seam.

The three **packaging/process seams** that actually couple backend+UI:

1. **Asset serving** — the API host itself serves the built SPA (`apps/operator/bin/host-handler.ts:78` mounts `spaRoutes` from `host-spa.ts`, verified). One process/port serves both `/api/*` and the UI.
2. **Process/bundle** — the Tauri Rust (`papercusp-desktop/src-tauri/src/main.rs:181-192`, spawn site `:1266-1306`) spawns embedded Postgres + the Node operator sidecar and owns the whole bootstrap; there is no "just the backend" distributable.
3. **Discovery** — clients resolve the backend via `~/.papercusp/embedded-pg.json` + `~/.papercusp/superuser-token`.

**Latent bug confirmed during the audit:** *nothing* writes `~/.papercusp/embedded-pg.json`. The package doc-comment (`embedded-postgres-server/src/index.js:22-24`) says "the desktop's Rust main writes it" — but Rust doesn't (the only `.papercusp/*.json` Rust writes is `endpoint-ipc.json`). Precise failure mode: the **desktop still works** because Rust injects `HARNESS_ADMIN_DATABASE_URL` into the sidecar env (`main.rs:734-737`) and `getHarnessAdminUrl()` reads that first; the **broken path** is an *external* operator trying to share a running desktop's DB via the (never-written) file, which silently falls back to `localhost:5432` (`embedded-pg-discovery.ts` — resolver call `:31-35`, `NATIVE_FALLBACK` literal `:20`). Having `serve` own this write closes the gap.

## Goals

- `papercusp serve` boots the entire operator headlessly on a clean machine: starts & owns embedded Postgres in-process (migrations applied by the package's own runner), runs `runBootstrap()`, serves `/api/*` + `/api/mcp`, and **serves no UI when headless**.
- `serve` writes `~/.papercusp/operator.json` (`{ httpUrl, port, token, pid, startedAt, version }`) and (fixing the gap) `~/.papercusp/embedded-pg.json`.
- `serve --ensure` is an idempotent singleton entrypoint: start if not running, else print discovery and exit 0. Safe for the future plugin `SessionStart` hook to call every session.
- The operator core is **independently runnable** with no UI dependency in the headless path. (Becoming its own `packages/operator-core` package is **C4, deferred** — see Decision A.)
- The Tauri desktop is refactored to run/embed `serve` rather than owning PG + sidecar spawn. (**C5, deferred.**)

## Non-goals (explicitly deferred)

- Auth redesign / dropping superuser-by-default → **SP2**. SP1 keeps the current loopback + superuser-token model; `operator.json` references the existing `~/.papercusp/superuser-token`.
- The Claude Code plugin itself → **SP3**.
- npm publishing + multi-platform PG binary packaging → **SP4**.
- The physical package carve (C4) and the desktop embedder (C5) → deferred within SP1 (see Now / Decision A).

## Target architecture

```
                +------------------------------------------------+
                |  operator core - `papercusp serve` (headless)  |
                |  - Hono API + /api/mcp  (endpoint-system)      |
                |  - embedded Postgres (Node-managed, in-proc)   |
                |  - auth: current superuser token (SP2 reworks) |
                |  - singleton; writes ~/.papercusp/operator.json|
                +-----------------------+------------------------+
                  HTTP / SSE / MCP / IPC | (no UI when headless)
        +-----------------------+--------+----------------------+
   +----v-------------+  +------v---------+  +-----------------v-+
   | Claude Code      |  | Tauri desktop  |  | ratatui TUI (SP5) |
   | PLUGIN  (SP3)    |  | (embeds serve) |  | `pui`             |
   +------------------+  +----------------+  +-------------------+
```

## Design decisions

### A · Full physical package extraction — target end-state, but DEFERRED (resequenced 2026-06-04)
The end-state is still a clean `packages/operator-core` (no UI dep) with `apps/operator` demoted to the UI package — *not* a permanent facade. **But the carve (C4) is deferred, not done now.** Audit reality: it is ~1,564 `@/`-alias import sites across ~780 files (+ ~454 files referencing `apps/operator`), it must first **cut ~19 `lib/`→`app/` back-edges** (move shared types like `app/harness/issues/types` into a neutral location; relocate `lib/chat-cards/AskChoiceCardEntry.tsx`), and it **collides with the in-flight `finish-next-removal-2026-06-01`** rework of the same `app/`↔`lib/` `next/*`-shim seam. Doing both at once = a guaranteed multi-hour breakage of the live `:3070` host the whole fleet uses. **Judgment call (autonomous run):** sequence the carve *after* `finish-next-removal` lands; deliver the *functional* decoupling first via C1–C3 (which need no move).

### B · `serve` owns embedded Postgres, in-process
Call `startEmbeddedPostgresServer()` (a real library export — `embedded-postgres-server/src/index.js:89`) **in-process** from `serve`: pick port (**default 5532**, override `PAPERCUSP_PG_PORT`) → ensure `PAPERCUSP_PG_DATA_DIR` (default `~/.papercusp/embedded-pg-data`) → start → TCP-ready probe → **write `embedded-pg.json`** → `runBootstrap()`. **Migrations are applied by the package's own `migration-runner.js` when `PAPERCUSP_PG_SQL_DIR`/`dbSqlDir` is passed** — `serve` just forwards the SQL dir, not a separate migrate step. One process tree, one clean shutdown. To attach an **external** PG instead: `PAPERCUSP_USE_EMBEDDED_PG=0` + set both `HARNESS_DATABASE_URL` (app) and `HARNESS_ADMIN_DATABASE_URL` (admin) — the operator reads the admin var first via `getHarnessAdminUrl()`.

### C · Cold-start singleton via OS flock; DB locks for runtime only
The DB-backed named resource locks (`dev-server`, the `dev:restart` drain protocol in `lib/agent-tools/dev/restart.ts` — verified) need the DB *up*, so they cannot guard cold start (chicken/egg). Use an OS `flock` on `~/.papercusp/operator.lock` + a pid/health check for the startup race; keep the named resource locks for *runtime* drain/restart/migrate. `serve --ensure` checks `operator.json` (pid alive + `/health` OK) → reuse; else acquire flock → start. Two concurrent `serve --ensure` calls converge on one backend.

### D · New `~/.papercusp/operator.json` discovery file
`{ httpUrl, port, token, pid, startedAt, version }`, written atomically by `serve` after the host is listening, invalidated on shutdown. Sits alongside `embedded-pg.json` (PG) and `endpoint-ipc.json` (IPC socket — which already has a real writer `writeEndpointIpcDiscovery`, the template `serve` follows). This is the file the SP3 plugin's `headersHelper` reads for MCP url + bearer. SP1 populates `token` from `~/.papercusp/superuser-token`.

### E · SPA serving is gated; default ON to preserve the desktop
Gate the `spaRoutes` mount (`host-handler.ts:78`) behind a flag (`PAPERCUSP_SERVE_UI`, **default `'1'`/on**). The **desktop's webview consumes `spaRoutes` as its content source**, so default-on keeps the running desktop/dev box untouched; `serve` (the new headless entry) sets `PAPERCUSP_SERVE_UI=0` to drop the UI. This is *not* a browser-webapp revival — the retired thing is *browsing the SPA standalone*; the desktop consuming it is the supported path. Verified clean: `/api/*` terminates at `host-handler.ts:73` before the SPA catch-all, the only shared middleware is a benign `compress()` at `:41`, and the API→shell data flows (`window.__PAPERCUSP_WS__` `host-spa.ts:119`, `__PAPERCUSP_FLAGS__` `:143` with async fallback `flags/src/client.ts:27-29,51`) are one-way; cross-origin-friendly CORS (`host-cors.ts:26-38`) confirms no co-serving assumption. The dead idea is the old SP5 "browser SPA for plugin users" — moot now that SP5 is the TUI.

### F · Desktop becomes an embedder (DEFERRED — C5, riskiest, last)
Replace the Rust embedded-PG spawn + sidecar spawn (`main.rs:181-192`, `:1266-1306`) with: spawn `papercusp serve --ensure` → read `operator.json` → point the webview at it. PG port selection, ready-check, and the `embedded-pg.json` write move out of Rust into `serve`. Rust retains webview, IPC client, custom `papercusp://` protocol, window management, PTY, workspace `HOME` isolation, update checker. Deferred because it is sensitive Rust + needs live Tauri/Xvfb verification (a supervised window).

## Implementation plan

**Active batch (additive, safe to do now):**
1. **C1 — `apps/operator/bin/serve.ts` (headless orchestrator).** In-process `startEmbeddedPostgresServer({ dbSqlDir })` → write `embedded-pg.json` → `runBootstrap()` → `serve()` on the resolved port with `PAPERCUSP_SERVE_UI=0`. A *new file*, imported by nothing in the live host → cannot break the running operator.
2. **C2 — SPA opt-in (default-on).** Gate `spaRoutes` at `host-handler.ts:78` behind `PAPERCUSP_SERVE_UI` (default `'1'`); `serve` sets it `0` (Decision E). One small, behavior-preserving conditional.
3. **C3 — `operator.json` + singleton.** Atomic discovery writer (D), `flock` cold-start guard + pid/health reuse, `serve --ensure` (C).
4. **C6 — Tests.** Isolated boot on a temp `HOME` + alternate ports (so it never collides with the live `:3070`/native PG): PG starts, migrations apply, `/health` + `/api/mcp` reachable, `operator.json` + `embedded-pg.json` written, `--ensure` dedups to one backend, clean shutdown invalidates discovery + releases flock. Plus a `PAPERCUSP_SERVE_UI=0` returns-404-on-UI / 200-on-`/api/*` check.

**Deferred batch (needs a supervised window / sequencing):**
5. **C4 — Full package carve** → after `finish-next-removal-2026-06-01` (Decision A).
6. **C5 — Desktop embedder refactor** → after C4; live-Tauri verification (Decision F).

## Testing

Per the repo's four canonical homes (`CLAUDE.md`). The dev box runs **native PG on :5432** and the live operator on **:3070**, so all `serve` tests MUST use a temp `HOME` + alternate `PAPERCUSP_PG_PORT`/`PAPERCUSP_HONO_PORT` + temp `PAPERCUSP_PG_DATA_DIR` to avoid colliding with either. (Embedded-pg binaries may need provisioning on the dev box — if unavailable, C6 falls back to `PAPERCUSP_USE_EMBEDDED_PG=0` against a throwaway test PG schema, and the embedded-pg path is verified under the desktop/CI.) `npm run test:affected` green before close.

## Risks & mitigations

- **C4 megadiff vs the fleet AND `finish-next-removal`.** ~1,564 `@/` import sites, ~454 files referencing `apps/operator`, ~19 `lib/`→`app/` back-edges, all over a *live* `app/**` mid-refactor. Mitigation: **deferred** (Decision A) — do it after next-removal, under a held multi-file lock + codemod, in a supervised window. Not attempted in the autonomous run.
- **In-process PG lifecycle leaks.** A crashed `serve` could orphan a postmaster. Mitigate: flock + pidfile + a startup sweep that reaps a stale postmaster on the data dir.
- **Embedded-pg binary availability on the dev box.** The native-PG dev box may lack the embedded-pg binaries. Mitigate: C6 dual-path (embedded where available; external-PG fallback otherwise); embedded path validated under desktop/CI.
- **C2 touches the live host file.** Mitigate: default-on conditional = zero behavior change for the desktop; verified `/api/*` is unaffected.
- **C5 desktop regressions.** Sensitive Rust + custom protocol. Mitigate: deferred to a supervised, Xvfb-gated window.

## Decisions

### Audit 2026-06-04 — spec corrected against source; C4 resequenced
2026-06-04 — A source-level audit (4 parallel verifiers + personal re-checks) found: (1) **FALSE** — PG port default is **5532**, not 15432 (`embedded-postgres-server/src/index.js:91`); fixed in Decision B. (2) **OVERSTATED** — "code-level already decoupled" is only mostly true; ~19 `lib/`→`app/` back-edges + `.tsx` under `lib/` + shared types in `app/`; fixed in Problem + Decision A. (3) **BLIND SPOT** — C4 collides with the in-flight `finish-next-removal-2026-06-01`; **resequenced** so C1–C3 (functional decoupling, additive) ship first and C4 (carve) waits for next-removal. (4) Tightened: migrations are applied by the embedded-pg package's runner (pass `dbSqlDir`, no separate step); external-PG needs both `HARNESS_DATABASE_URL` + `HARNESS_ADMIN_DATABASE_URL`; the latent `embedded-pg.json` bug doesn't break the desktop (env injection `main.rs:734-737`) but breaks the external-operator-sharing-DB path. Everything else in the spec was CONFIRMED against source.

### Full physical extraction is the target — but sequenced after next-removal (supersedes "now")
2026-06-04 — Supersedes the earlier "full physical extraction now (not a facade)" decision. The clean `packages/operator-core` split remains the target end-state (no permanent facade), but the audit surfaced an active `finish-next-removal-2026-06-01` refactor of the same `app/`↔`lib/` seam; carving simultaneously would break the live host for the fleet for hours. So the *functional* decoupling lands first (C1–C3, additive, no move), and the carve (C4) is sequenced after next-removal under a supervised window. This is the bold-but-not-reckless reading of "do it right": right end-state, safe order.

### Goal: Papercusp in vanilla Claude Code, public distribution
2026-06-04 — End-state: the full Papercusp substrate from a plain Claude Code session, no Tauri desktop, distributed publicly as a Claude Code plugin. Desktop becomes one client among several. SP1 (decoupling) is audience-independent, so it is first.

### Decompose into SP1–SP5; SP1 first
2026-06-04 — Public distribution makes this a multi-subsystem product: SP1 (core), SP2 (auth), SP3 (plugin), SP4 (packaging), SP5 (the ratatui TUI = the UI client). SP1 is the keystone every other SP depends on.

### Session model flips to launch-then-attach
2026-06-04 — A plugin loads *into* a running session; it cannot run psu's picker, mint the tracked session pre-launch, or exec with `--append-system-prompt`. So (SP3) the plugin's `SessionStart` hook registers the session + injects the playbook, and `/papercusp:attach` scopes to a harness lazily. This shapes what SP1's `operator.json` must expose.

### Bundle-everything-in-plugin rejected
2026-06-04 — Plugins are git-cloned read-only with no install-time execution, so "plugin spawns everything" would require committing per-platform PG binaries to the marketplace git and would still need singleton discovery (per-session spawns fragment coord/locks/PG). Instead: a thin plugin whose `SessionStart` ensures a singleton `serve`. This is why SP1 must produce `serve --ensure` + `operator.json`.

### Cold-start singleton uses OS flock, not DB locks
2026-06-04 — DB-backed named resource locks need the DB up and cannot guard cold start. Use an OS flock + pid/health check for the startup race; reserve the named resource locks (and the `dev:restart` drain protocol) for runtime restart/migrate.
