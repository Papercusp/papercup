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

## Layer 2 (FIRST — owner directive): permanent, stable signed URLs — NO time-based re-minting
The highest-leverage fix and the owner's explicit ask. Two parts:
- **2a — permanent URLs.** `signSpawnParams` / `verifySpawnParams` support a sentinel
  `exp=0` = "never expires": sign with `exp=0` (still inside the HMAC, so role-escalation is
  still blocked), and verify skips ONLY the time check when `exp===0` (keeps the sig check).
  Role/MCP URLs mint permanent by default. Owner has accepted the replay-window trade
  (loopback-only + per-spawn 0700 dirs remain; key-rotation is still the revocation lever).
- **2b — stop re-minting on restart.** The spawn REUSES an existing `.mcp.json` URL when it's
  still signature-valid (now always, since permanent) instead of writing a fresh one. Result:
  the project MCP config is byte-identical across restarts → Claude Code never re-approves →
  its own reconnect re-attaches with no human `/mcp`.
- Tests: spawn-signing `exp=0` accept + never-expire; existing 24h path still works; the
  reuse-not-remint path.

## Layer 1: approval stickiness (so a reconnect never stalls at "pending approval")
- **Done (box level):** `enableAllProjectMcpServers: true` in `~/.claude/settings.json`.
- **Durable:** the spawn writes `enableAllProjectMcpServers: true` into each spawned session's
  settings.json (the launch spec currently writes NO MCP-approval setting — the gap), so it's
  self-contained per session and not reliant on the box-level file.

## Layer 3: always-up MCP gateway (the "invisible restart" guarantee)
A thin persistent local relay in front of `:3070/api/mcp` that a deploy does NOT restart. It
survives the operator bounce and transparently re-initializes the upstream MCP session when
`:3070` returns, so the client's connection to the gateway never drops. This is the only design
that makes a restart fully invisible regardless of the client. Bigger lift (a small persistent
process + upstream session re-init + `.mcp.json` points at the gateway port). Scoped here;
implemented after 1–2 land (which alone should remove the manual step in practice).

## Layer 4: safety-net watchdog
A process-level watchdog (same pattern as the git-sync-stall-watchdog) that detects sessions
whose `mcp__papercusp*` tools have vanished and flags/nudges a reconnect — so no agent ever
silently works tool-less after a deploy. Cheap; ships alongside.

## Sequence
2a → 2b → 1-durable → (verify: a simulated restart no longer changes `.mcp.json`) → 4 → 3.
Layer 2 is the core; 1-durable hardens it; 3 is the belt-and-suspenders guarantee.
