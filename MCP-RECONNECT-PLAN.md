# Plan: agents' MCP auto-reconnects across an operator (`:3070`) restart

**Owner:** su-16121ed1 · **Date:** 2026-07-01 · **Mode:** AUTO (implement start→finish)

## Problem
A `:3070` restart (every deploy) drops each Claude Code session's long-lived HTTP-MCP
connection. Two things then keep it dark instead of auto-recovering:
1. The spawn **re-mints `.mcp.json` with a fresh signed URL** on every restart → Claude Code
   sees a *changed* project MCP config → demands **re-approval** → "pending approval" → the
   `mcp__papercusp*` tools vanish from the in-process registry (and subagents inherit empty).
2. The signed URL carries a **24h `exp`** (`spawn-signing.ts`), so even without a restart it
   dies daily and must be re-minted — same failure on a timer.

The server, URL, token, and network are all fine (curl proves it). The break is purely the
client binding + config churn. We can't change Claude Code's client reconnect behavior
(Anthropic's), but we CAN remove every reason it needs to re-approve/re-mint, and front the
transport so a restart never drops the socket.

---

## STATUS (2026-07-01): all four layers implemented + tested

### Layer 2 — permanent, stable signed URLs — NO time-based re-minting ✅ DONE + committed
- **2a — permanent URLs.** `signSpawnParams` / `verifySpawnParams` (operator `spawn-signing.ts`)
  + the orchestrator's signer (`spawn-mcp.ts`) support a sentinel `exp=0` = "never expires":
  sign with `exp=0` (still inside the HMAC, so role-escalation is still blocked), verify skips
  ONLY the time check when `exp===0`. Permanent by default. 12/12 spawn-signing tests; the
  role-escalation rewrite still fails (`invalid_signature`). Revocation is now key-rotation.
- **2b — subsumed by Layer 1.** Once approval keys to the server NAME (Layer 1) and the URL never
  expires (2a), a re-minted URL no longer triggers re-approval — so a separate "reuse the exact
  URL" change is unnecessary. The churn is neutralized at the approval layer.

### Layer 1 — approval stickiness ✅ DONE (live + durable)
- Live (box): `enableAllProjectMcpServers: true` in `~/.claude/settings.json`.
- Durable: `install-standalone-mcp.sh` writes `enableAllProjectMcpServers: true` on every install,
  so a re-install / token-rotation can't wipe it. Approval keys to the server name (`papercusp`),
  not the per-restart URL → a restart's re-mint is transparent; the client re-attaches with no `/mcp`.

### Layer 3 — always-up MCP gateway ✅ the gateway ALREADY EXISTS; this ACTIVATES + fully wires it
The "invisible restart" guarantee did NOT need building — `apps/operator/lib/mcp-proxy/proxy.ts`
(`:9071 → :3070`, systemd `papercup-mcp-proxy.service`, `Restart=always`, runs from the INTEGRATION
tree so a deploy never restarts IT) already implements it. Because `/api/mcp` is **stateless
streamable-HTTP** (no `Mcp-Session-Id` registry — confirmed), the proxy needs NO session remapping;
it just retries a refused upstream across the restart window. It was DEAD WEIGHT, though —
`PAPERCUSP_MCP_PROXY_BASE` was unset, so every `.mcp.json` still pointed at `:3070` directly.
Two changes activate it:
- **3A (code, repo-durable):** `resolveSpawnOperatorBase` (`spawn-mcp.ts`) now honors
  `PAPERCUSP_MCP_PROXY_BASE` — closing the SPAWN-path gap so fleet bees route through `:9071` too
  (the console + role paths already did, via `resolveAgentMcpBaseUrl`). Opt-in: unset ⇒ unchanged.
  New tests assert proxy-wins-over-host-defaults, explicit-operatorUrl-still-wins, unset-is-noop.
- **3B (activation, box-local):** `80-mcp-proxy-base.conf` systemd drop-ins on `papercup-dev-api`
  AND `papercup-bg-host` set `PAPERCUSP_MCP_PROXY_BASE=http://127.0.0.1:9071`. Staged via
  `daemon-reload`; take effect on each service's next restart. Proxy verified healthy
  (`:9071/api/health` → 200, forwarding to `:3070`).

### Layer 4 — safety-net watchdog ✅ BUILT + tested
`packages/operator-core/lib/system-health/mcp-dark-watchdog.ts` — a process-level sweep (same family
as the git-sync/green stall watchdogs, wired in `dbos/bootstrap.ts`) that detects a spawned bee
working DARK after a restart. The signal is robust, not a guess: `coord_presence.heartbeat_at` is
TOOL-CALL-COUPLED (dark MCP ⇒ frozen) while `spawned_agents.heartbeat_at` is the deploy-surviving
SUPERVISOR beat (process alive) and `last_output_at` proves it's actively generating. A bee that is
alive + generating but whose presence beat predates the restart (past a grace window) is working
tool-less → per-owner escalation + owner notify + fleet broadcast (reaches the HEALTHY peers/Queen,
who can relaunch it — the dark bee can't read its own inbox). Recovery clears idempotently.
Kill-switch `PAPERCUSP_MCP_DARK_WATCHDOG='0'`. 9/9 unit tests on the pure verdict.

---

## Activation (what makes it LIVE)
- **bg-host runs from THIS (integration) tree**, so a `papercup-bg-host` restart loads Layers
  1/2/3A/4 code + its proxy-base env directly (no release deploy needed). bg-host is the spawner
  (writes bee `.mcp.json`), the signer, and where the watchdogs run — so this is the primary
  activation. It reclaims in-flight background agents (Restart=always + EI-85 relaunch), so it's a
  deliberate step.
- **dev-api (`:3070`) runs the release checkout**, so its release-side code + proxy-base env apply
  on the next **deploy** (commit → green checkpoint → dev-api restart). dev-api is the proxy TARGET,
  not the spawner, so this is secondary.
- Note: a deploy/restart itself causes ONE more reconnect blip; from then on restarts are handled.
