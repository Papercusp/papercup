---
rel_path: "e2e/round2-session1-su0feaf-2026-06-10.md"
updated_at: 1781143810618
_body: "content"
---

# Impersonation E2E round 2 — session 1 report — 2026-06-11 (~01:50–02:10Z) — su-0feaf
Plan: app-impersonation-e2e-round2-2026-06-10 · Target: staging :3170 (carried-forward D-008) · staging tree 65a1a70ac (branch staging) · :3170 healthz OK · dedicated Tauri bare debug binary (built Jun 10 20:44) pid 3821651, bridge :37451, DISPLAY :94 (Xvfb+VirtualGL RTX 3090 — GL verified NVIDIA, not llvmpipe) · window 1880x1000, webview viewport 1089x675, webview offset ~(+791,+50) (inspector auto-docked per EI-180) · loadavg 12–13/128.

Flags snapshot (source=defaults): oracle/testing/design/harness-phases/cloudflare-publish/rust-port-ui/inbox-durable-escalations/improvement-auto-implement/inference-gateway OFF · video/voice-channels, the-hive, blueprint-aware-settings, prompt-studio, hive-agent-tabs, claude-cred-sync ON. (Two new keys vs run #1: inference-gateway, claude-cred-sync.)
Console-error allowlist: EMPTY held — 0 app-level console.error across the whole session. Network-layer connection-refused bursts + 1 unhandled promise rejection occurred during a peer's mid-session staging restart — classified deploy-window noise per plan rule; logged as EI-239 evidence, not FAIL.
UI naming flux noted: top-level tabs now Colony/Peers/Hives; harness-scope tabs overview/brainstorm/create/progress/frames/git/tests/docs/insights/conversations/learning/settings; cupboard branded "Comb"; app title "The Swarm" (known EI-230).

## Coverage this session
[P-001 preflight]   DONE — facts above. Gate finding: the features→work-items port HAS LANDED.
[P-002 work-items]  PASS — progress tab is the unified work-items surface (ID/KIND/TITLE/STATE/STAGE/ASSIGNEE/SEV/PRIO/RANK/PLAN). 58 DOM rows = exact backend count (57 + the just-created acceptance feature). Row click → ?sel=WI-97 → Detail renders full fields. EXACT EI-229 repro (?sel=WI-94 on e2e-imp-sync1) renders "Detail · WI-94" (state deprecated). EI-229 RESOLVED with evidence. Filter input: INCONCLUSIVE-DRIVING-FIDELITY (focuses, real XTEST keys don't register in the React controlled input — EI-216 reconfirmed with new routing facts commented there).
[P-003 steer leg]   BLOCKED — N/A-NO-AFFORDANCE: no steer/chat/peek action in the Detail pane, no chat/composer panel type in Add-panel (Agents/Contributors/Detail/Insights/Run log/Overview only), conversations tab read-only, dock chat opens only via OPEN_CHAT_EVENT. Filed EI-290 (change, major) — run #1's UX note is now a due decision since the port settled. EI-259 oracle leg pending-fix. Steer LLM budget unspent.
[P-004 VTE]         PASS — VTE auto-spawns a live Claude session at boot (run #1 saw "There is no active session!"); chat turn "Reply with exactly: pong" → "pong", ~4s (1 LLM call, the only one this session). Restart-recovery: covered incidentally — staging restarted mid-session (peer-confirmed); the VTE session survived (local process) and the webview soft-recovered without reload. Deliberate drain+restart NOT performed (would need the dev-server resource-lock drain protocol while peers were active on staging) — deferred.
[P-008 regression]  PARTIAL (item stays open) — EI-229 FIXED→resolved. EI-221 STILL BROKEN (palette → /marketplace themed 404; retarget to Comb — commented). EI-224 STILL BROKEN (?plan auto-set on create tab + shadows view=inbox; view param sets but content stays Plans; control without ?plan renders inbox — commented). EI-231 still-broken-with-caveat (switcher is now a wsSwitch=true PANEL; one real Esc didn't close it; outside-click does; focus-routing caveat recorded — commented). EI-206/215/238/239/259: pending-fix (no retest; EI-239 got fresh corroborating evidence — commented).
[P-014 large-data]  PASS — 12-tab sweep all render: work-items 58 rows, create tab loaded a 126KB-innerText plan doc (352 list items), docs 274 items, learning 151, insights 60 rows, git 23 rows. Zero console errors throughout. Subjective settle sub-second; instrumented timings deliberately left to P-009's battery.

## Issues ledger this session
Resolved: EI-229 (verified fixed, exact repro). Filed: EI-290 (steer/chat affordance unreachable post-port, change/major). Commented with fresh evidence: EI-221, EI-224, EI-231, EI-239, EI-216.

## Driving-method notes (for the next executor)
- Webview offset inside the dev-wrapper window ≈ (+791,+50); LEFT half is the live VTE — naive getBoundingClientRect clicks land in the terminal and type into the Claude session (clear with ctrl+u if it happens).
- Synthetic 5-event pointer sequence works for Radix tabs/rows/menus; React text inputs need real focus + real keys and STILL fail (EI-216) — use URL/nuqs navigation for filter-dependent legs.
- The auto-opened WebKit inspector (EI-180) eats ~280px height; close it before any perf/memory leg (perf gotcha #2).
- A staging restart mid-session produces connection-refused console bursts; samples spanning it are INCONCLUSIVE-and-rerun (none of this session's verdicts spanned it).

## Mutations ledger
+1 chat turn on MY instance's VTE Claude session (1 LLM call, ~cents). Stray "smoke"/Escape keystrokes went into the same VTE prompt (cleared with ctrl+u; session killed at cleanup). NO shared-state mutations: no flag flips, no storage wipes, no harness/work-item creates, persisted build-target switcher untouched.

## Cleanup ledger
Killed + freed at session end: Tauri pid 3821651, openbox, Xvfb :94, /tmp/e2e-r2-* pid/token/log files, bridge token /tmp/tauri-dev-bridge-3821651.token. Evidence retained: /tmp/e2e-r2-su0feaf/*.png (transient) + this report (durable). LEFT ALIVE: harness e2e-imp-sync1 + WI-94 — still the EI-206 live repro (EI-229 closed, but the fixture rule needs BOTH; delete when EI-206 closes).

## Residue for next sessions
P-005 (pipeline-state surfaces, needs seeded e2e-imp-* harness + iso stack for harness-phases flag), P-006 (cupboard Fork/publishing saves), P-007 (settings-500 + EI-239 retest, iso stack), P-009–P-013 (perf round 2: battery, TTFT, soak — coordinate with EI-278 assignee, prod-build pass, load-sensitivity), P-003 unblocks on EI-290, P-008 remaining issues pending-fix.
