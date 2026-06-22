# Why the MCP server 'keeps going down': it IS :3070, deploys restart it, and a bad swap crash-loops it
URL: /internal/docs/agent-insights/mcp-host-3070-deploy-restarts-and-verify-before-cutover

The papercusp-su MCP endpoint is served by :3070 (the green release checkout), so every deploy restarts it and a botched deploy (incomplete node_modules) used to MODULE_NOT_FOUND crash-loop it. The layered fix: a workspace-resolution gate + a pre-cutover boot preflight (verify-before-restart, zero-downtime abort) + an opt-in reconnecting local MCP proxy.

## What

Agents report "the MCP server keeps going down" — sessions lose their `papercusp-su`
tools, or come up toolless (`ToolSearch` empty). The instinct is "the server crashed."
Usually the **server is healthy**; what happened is `:3070` *restarted* (and sometimes
crash-looped), because the MCP control plane rides the deployable operator process.

## Why — MCP availability is coupled to :3070's restart cycle

The `papercusp-su` MCP endpoint is `http://localhost:3070/api/mcp`. **`:3070` =
`papercup-dev-api` = the GREEN release checkout** (`papercup-release`, pinned to `main`).
So:

* **Every deploy restarts `:3070`** (clean SIGTERM-drain). A native MCP client (Claude
  Code) drops its connection on that restart and does **not** re-run tool discovery — so
  a brief restart can strand a session toolless until a full *process* relaunch (not
  `/mcp` reconnect, not `--continue`, which preserve the empty catalog).
* **A botched deploy used to MODULE\_NOT\_FOUND crash-loop it.** The deploy swapped the
  git checkout but synced `node_modules` via a heuristic (`--node-modules auto`); when
  that mis-decided (documented: 2026-06-09 `@dnd-kit/core`, 2026-06-20
  `@papercusp/plugin-loader`), `:3070` restarted into new-code + stale node\_modules →
  `MODULE_NOT_FOUND` → `systemd Restart=always/5s` crash-loop. The only consistency check
  (`health`) ran **after** the irreversible restart, and the rollback re-ran the same
  heuristic, so it could leave the tree equally broken → "manual `--no-drain` recovery."

Diagnostic: `journalctl --user -u papercup-dev-api.service` — `MODULE_NOT_FOUND` lines +
SIGTERM-drain restarts, with **no** lag/RSS/watchdog signals, means deploy-coupled (not a
runtime crash). `dev:service_health` + `dev:pipeline_position --path <file>` show whether
`:3070` is up and where a change sits.

## The layered defenses (server side)

Three gates, source → cutover, all live in the deploy mechanics:

1. **Workspace-resolution gate** (`setup-release-checkout.sh`, EI-2118). After the
   node\_modules sync, if any `@papercusp/@papercup` workspace package resolves in the
   integration tree but **not** the release tree, the script **aborts non-zero before any
   restart**. Runs for all three callers (deploy, green-checkpoint, staging-sync). Pure
   shell; catches the recurring dangling-workspace-symlink class at the source.

2. **Pre-cutover boot preflight** (`deploy.ts` `executeDeploy` + `deploy-deps.ts`
   `realDeps.preflight`, plan `mcp-host-availability-resilience-2026-06-22` P-001). After
   the swap and **before** the live `:3070` restart, a child process imports the swapped
   checkout's side-effect-free `host-handler` module graph (`npx tsx -e`, mirroring the
   launch — no server/bootstrap/DB). A missing dep throws `MODULE_NOT_FOUND` *there*, so
   the deploy **aborts before cutover** — the old process keeps serving, **zero downtime**.
   This catches ALL deps (not just workspace pkgs), complementing gate (1). The deploy
   tracks `migrateRan`/`liveCutover`: a pre-cutover failure reverts the tree with no
   restart; the rollback path re-runs the preflight so it can't cut into a SECOND
   crash-loop (prev-won't-boot → skip restart + loud manual-recovery broadcast).

3. (Downstream) the green-checkpoint runs the test suite and `sync-staging-checkout` boots
   `:3170`, so a missing **non-workspace** dep on those paths surfaces as a test red /
   staging fault rather than silently shipping.

**The rule: never restart live `:3070` into a checkout that hasn't been proven to boot.**

## The client side — opt-in reconnecting proxy

Even a clean restart drops the client connection. `lib/mcp-proxy/proxy.ts` +
`bin/mcp-proxy.ts` (+ the `papercup-mcp-proxy.service` systemd unit) is an always-up local
proxy (`:9071 → :3070`) that **retries across a `:3070` restart window**, so the
client→proxy connection stays up and a `tools/call` issued mid-restart just waits a beat.
Safety invariant: it retries **only a refused/pre-connect upstream** (the call provably
never reached `:3070`) — never a post-connect error — so a non-idempotent `tools/call` is
never double-applied. **Opt-in**: nothing connects until `~/.claude.json` is repointed
`:3070`→`:9071` (a fleet-wide attended cutover — see `apps/operator/scripts/systemd/README.md`).
The per-call `scripts/su-mcp.ts` / `scripts/mcp-call.mjs` wrappers are the manual fallback
when a session's client has already dropped.

## TL;DR for the next agent

"MCP is down" almost always = `:3070` restarted (deploy) or crash-looped (bad swap),
not a server crash. The crash-loop class is now gated (verify-before-cutover); for a
dropped *client*, fully relaunch the session (`/mcp` reconnect won't repopulate tools) or
drive tools via `scripts/su-mcp.ts` until it reconnects.
