---
rel_path: "e2e/round2-session3-su0feaf-2026-06-10.md"
updated_at: 1781147128686
_body: "content"
---

# Impersonation E2E round 2 — session 3 report — 2026-06-11 (~02:45–03:25Z) — su-0feaf
Plan: app-impersonation-e2e-round2-2026-06-10, iso-stack lane (P-006/P-007) + soak continuation (P-011). NOTE: native MCP client broken since the ~02:35Z :3070 deploy (HTTP 426 on every call, EI-123 class) — all MCP writes this session via raw JSON-RPC curl to :3170 (helper /tmp/e2e-r2-mcp-helper.sh; needs ?client=<sid>).

## What was built (and torn down)
D-012 recipe re-validated with amendments: iso DB papercusp_e2e_su0feaf created + 114/114 migrations applied 0-fail via the embedded runner (max:1 client; top-level await needs an async IIFE under tsx -e; node trap morphed: nvm has NO v22 anymore, linuxbrew node is now v25.9.0 — migrations ran fine under 25). Iso hono :3270 healthy ~20s, PG isolation verified (projects=[]). Fault proxy :3271 (settings/profile → 500, toggleable). Fresh-HOME Tauri on :95.

## THE FINDING — EI-296 (major): the iso rig is NOT isolated for UI testing
The dev-wrapper routes ALL webview /api traffic to its selected build target (SELECTED_API_PORT; IPC-first, HTTP fallback) — page origin is IRRELEVANT. Fresh HOME → default :3070 (SHARED green). The persisted-target file validates against a fixed allowlist (3055/3070/3170) → no custom port; the standalone hono host exposes NO endpoint-ipc socket → unreachable via discovery either. Observed live: the SPA rendered from the iso origin while /api reads returned SHARED workspace data, and a Save click POSTed against shared :3070 — NEAR-MISS shared mutation (verified harmless: profile updated_at unchanged at 2026-06-10T04:01). Retroactive caveat recorded on EI-296: predecessor P-018's iso-stack UI results (profile save) likely also ran against a shared operator.

## Leg outcomes
P-007 settings-500: BLOCKED-TOOLING — HTTP fault proxies cannot reach the desktop /api path; needs operator-side env-gated fault middleware → EI-297 (change) filed. The proxy rig itself verified correct (direct curl through :3271 → 500 both GET/POST). EI-239 retest: still pending-fix.
P-006: publishing Save/Rotate/Reset-cache = N/A-NO-CREDS on the fresh iso DB (GET /api/deploy/accounts → not_found; /api/settings/api-keys, /api/publish/credentials, /api/keys → 404). Cupboard Fork + UI saves: BLOCKED by EI-296 (no isolated UI mutation surface exists).
P-011: soak continuing on the :94 instance (~50 min): webview 785→811MB idle (slope ~30MB/hr with GC bounce), inspector-wv oscillating 0.9–1.4GB, staging-node RSS sawtooth 1.0–2.0GB (restarts/watchdog recycles visible — sampler v2 resolves the staging pid dynamically after the hardcoded-pid lesson).

## Issues ledger
Filed: EI-296 (bug, major — iso rig silently targets shared :3070), EI-297 (change — operator-side fault injection for e2e). No mutations to shared state (near-miss verified harmless). 

## Cleanup ledger
Torn down + verified: :95 Tauri (1075219) + Xvfb/openbox (:95 freed), iso hono (:3270 down), fault proxy (:3271 down), DROP DATABASE papercusp_e2e_su0feaf, rm /tmp/e2e-iso-home-r2 + pid/token files. SETSID LESSON: pid files captured the setsid wrapper, not the child — kill by listening-port pid (ss -tlnp) at teardown. LEFT ALIVE (deliberate): :94 soak stack (app 88077) + sampler (pid file /tmp/e2e-r2-soak.pid) + /tmp/e2e-r2-ttft{1,2}.log + helper scripts; e2e-imp-sync1 + WI-94 (EI-206 repro); 2 tagged conversations e2e-imp-r2-ttft-1/-2.

## Residue
P-005 (§13 phase rows + seeded state, harness-phases now ON on staging), P-012 (prod-build pass), P-013 (stretch), P-003 (EI-290), P-007/P-006 unblock on EI-296/EI-297, P-008 pending-fix sweep, P-011 harvest after hours of soak.
