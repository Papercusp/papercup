---
rel_path: "e2e/func-staging-su24719-2026-06-10.md"
updated_at: 1781088270231
_body: "content"
---

# Impersonation E2E — consolidated session report — 2026-06-10 — su-24719 (+ takeover of bb772/026d2 lanes)
Plan: app-impersonation-e2e-perf-testing-2026-06-10 · Target: staging :3170 (D-008) · sidecar SHA 424517b5 · SPA footer ef69a8f0 · dedicated Tauri bare debug binary pid 3951158, bridge :38451, DISPLAY :92 (Xvfb+VirtualGL RTX 3090, real-pointer/key driving via xdotool, webview screen offset +810/+50) · viewport 1112x1055 · loadavg 13–20 · Executors: su-bb772 (P-006, P-007 start), su-026d2 (P-012..P-014, artifact e2e/perf-staging-baseline-2026-06-10.md), su-24719 (P-005, P-007 finish, P-008..P-011, P-015, Phase 5, this report).

Flags snapshot (defaults): oracle/testing/design/harness-phases/cloudflare-publish/rust-port-ui/inbox-durable-escalations/improvement-auto-implement OFF · video/voice-channels, the-hive, blueprint-aware-settings, prompt-studio, hive-agent-tabs ON. Dark-by-flag = expected, not FAIL.
Console-error allowlist: EMPTY — zero [ERROR] across the whole session (all executors). One transient [WARN] "[Sync] SSE failed — falling back to POLLING" (test-env artifact; raw EventSource from same webview: 1 open/0 err/13 msgs in 8s).

## §13 coverage checklist (consolidated; current-build mapping)
[ /]                PASS — / redirects to /adv mission control; h1 "Harnesses"; header CTAs resolve (Support/Settings/DEV/Comb/GitHub). Legacy home w/ wordmark: N/A-RETIRED.
[ /harness*]        N/A-RETIRED → current /adv?tab=harnesses + /harness/<slug> projects view. Unknown slug → themed 404 PASS.
[ /adv tabs]        PASS ×14 (bb772 P-006: 6 all-mode + 8 harness-scope, zero console errors; harness pick strip 6→12).
[ /adv — features]  list PASS (20 rows papercup; filters; live-update ≤30s on API create). Row→?sel→Detail PASS for F-*; FAIL for WI-* → EI-229. R-reset full flow PASS (confirm+toast+backend). steer/chat → P-019 (bb772).
[ /adv — issues]    PASS — filters→?ifilter (nuqs), graceful empty state, J/K hints. No create affordance (by design; creation via agents/MCP).
[ /adv — inbox]     Panel healthy (filters→?istatus, ?expand preview) but view-switch FAIL → EI-224 (?plan shadows view=inbox).
[ /adv — ⌘K]        PASS — opens, fuzzy-filters, executes, Esc closes (bb772 + my re-verify). FAIL: "Go to Marketplace" entry → retired route 404 → EI-221.
[ Keyboard]         PASS — / J ↵ R in features panel (real keystrokes; bb772's env-INCONCLUSIVE resolved as driving fidelity), Esc closes palette/notifications/oracle dock. FAIL: Esc doesn't close WorkspaceSwitcher → EI-231.
[ /marketplace*]    N/A-RETIRED → /cupboard: facets PASS, ?q search PASS (server-side), detail PASS, unknown-id graceful error, Back PASS. Raw error copy + no inline retry → EI-215. Fork = mutation, not exercised.
[ /snapshots]       N/A-RETIRED (snapshot system retired 2026-06-09).
[ /settings/*]      PASS ×18 sections mount w/ real content. Saves: profile Save FULL PASS on the isolated stack (Phase 5) — toast + PG persistence (EI-238: toast copy references retired profile.json). Publishing/Rotate/Reset-cache still unexercised (no publish creds on iso stack; low value). oracle+publishing flag-gating verified BOTH ways (dark→404; oracle flag on→renders).
[ /support]         PASS — FAQ accordion, AI-assistant budget UI, links, Chatwoot lazy-loads on click.
[ /login /signup]   PASS-as-authed (redirect /adv). §12.5 logged-out matrix: N/A-DOC-STALE — verified on the isolated stack (fresh profile + fresh DB): the desktop product has NO login wall; it boots straight to local-user mode ("U | User"); sign-in is a setup-wizard step (agent credentials), not an app auth gate.
[ /setup]           PASS — first-run redirect to /setup fires on a fresh profile; "Start setup" → wizard with nuqs ?step= routing, 11 steps, live environment probes (essentials auto-✓, account steps !). Playbook §11.3 copy is doc-stale.
[ /docs]            N/A-RETIRED in-app — docs link is external; engineering docs live at :3070/internal/docs.
[ /pi]              PASS — ?harness=papercup mounts dockview+terminal, PI session spawns; chromeless by design; missing-param inline error exact per §12.7.
[ /installed/*]     harnesses PASS (9 rows) · plugins PASS (2 cards) · kpis WAS-FAIL → EI-220 FIXED by su-24719 (all-kpis.ts → live registry; verified live :3170 harnesses 0→16; resolved).
[ Header]           PASS — links, version, theme switcher, WorkspaceSwitcher (opens, lists 6 workspaces, outside-click close; Esc gap EI-231), SessionIndicator.
[ Empty states]     PASS — features, issues, Detail, deploy-accounts, user/memory; Cupboard LISTINGS 0 has EI-215 caveat.
[ Error states]     /pi missing param PASS · unknown harness 404 PASS · unknown cupboard id graceful PASS · oracle API 404-when-dark PASS · oracle malformed body → 400 {"error":"messages required"} EXACT per §12.7 PASS (Phase 5) · API-down fault injection → EI-239 (Phase 5) · settings-500 NOT COVERED (needs server-side fault patching; lowest-value residue).
[ Oracle dock]      Flag OFF → gating HOLDS (dock absent, API 404). Flag ON (Phase 5, iso stack via PAPERCUSP_FLAG_PAPERCUSP_ORACLE=1): dock mounts, FAB opens it (?oracle=true nuqs), composer accepts input, send renders YOU/ORACLE turns, error path shows "⚠ Oracle not provisioned…" exactly per spec, Esc closes, TutorialButton appears, /settings/oracle renders (prompt+memory textarea). dispatchToAgent → P-019 (bb772, shared staging). Full PASS within iso limits.
[ Auth states]      N/A-DOC-STALE (see /login row).
[ Phases/addpl/dept/banners/modals-internals] NOT COVERED — flag-dark (harness-phases OFF), retired, or pipeline-state-dependent. Residue for a future session if wanted.

## Performance
API TTFB ≪1s PASS · SPA load 570ms PASS · tab settle ~650ms med (watch) · INP worst 328ms PASS · PG conns stable PASS · RSS clean · sync-propagation FAIL → EI-206 · TTFT app-side 12–39ms, first token 6.5/8.8s WARN (provider-side) · Shell boot warm-profile: median 2.8s worst 4.7s (5 samples) · Shell boot FRESH-profile (Phase 5, iso): bridge 0.5s, DOM 2.1s — webview profile cache is NOT a boot factor · Isolated operator cold boot (empty→serving): ~13s.

## Phase 5 — deferred legs (owner-approved, executed 2026-06-10 ~05:00–06:00Z)
- P-016 EI-220 FIX SHIPPED: all-kpis.ts reads loadHarnessRegistry() (live workspace-PG registry); verified live on :3170 (harnesses 0→16); EI-220 resolved. Residue on the issue: Projects card + parents panel still read the legacy pots table (honest zeros).
- P-017 isolated stack STOOD UP (recipe + 3 env traps in plan D-012): db papercusp_e2e_su24719 migrated 000→215 via the embedded runner (max:1 client; superuser CREATE EXTENSION vector/pgcrypto/uuid-ossp needed), hono host :3270 from the staging tree, fresh HOME=/tmp/e2e-iso-home. Traps: getOrgPg reads HARNESS_DATABASE_URL (DATABASE_URL alone silently leaks to the shared DB — verify isolation with /api/installed projects=0); getKnownRoles needs PAPERCUSP_HARNESS_DIR under a fresh HOME (else fail-closed boot refusal); pin PATH to nvm node22.
- P-018 battery: fresh-profile cold start 2.1s · first-run /setup redirect + wizard PASS · auth matrix N/A-DOC-STALE · profile save PASS → EI-238 (stale toast copy; storage is PG operator_user_profile) · fault injection → EI-239 (no offline indicator in-SPA; full reload strands webview on raw WebKit error page, Ctrl+R dead, dev-wrapper-only recovery — production builds have NO recovery path) · oracle full pass (above).
- P-019 (agent-path smoke): claimed + run by su-bb772 on shared staging e2e-imp-sync1 (≤2 LLM calls). Result lands in their note on the item.

## Issues filed (cumulative)
EI-206 (major, 026d2, open): harness-list never live-updates — narrowed: features-list DOES live-update; that query's invalidation specifically (+POLLING caveat). EI-215 (minor, open): Cupboard raw error copy. EI-216 (change, open): bridge synthetic input fidelity; xdotool fallback. EI-220 (major, RESOLVED by su-24719): kpis legacy registry. EI-221 (minor, open): palette Go-to-Marketplace → 404. EI-224 (major, open): Inbox view shadowed by ?plan. EI-229 (major, open): Detail can't resolve WI-* ids (repro WI-94/e2e-imp-sync1, kept). EI-231 (nit, open): WorkspaceSwitcher ignores Esc. EI-238 (nit, open): profile-save toast names retired profile.json. EI-239 (major, open): operator-death UX — no offline indicator + stranded error page.

## Owner questions — answered by "continue with the deferred items" 2026-06-10; closing status
Q1 oracle pass → DONE on iso stack (env-override flip; shared flag untouched). Q2 smoke budget → P-019 running (bb772). Q3 isolation → built by hand (D-012), $0, torn down after. Q4 EI-220 → fixed. Q5 settings saves → profile done on iso; publishing/reset-cache remain the only unexercised saves (need publish creds / shared cache; lowest value).

## Evidence + cleanup ledger (final)
Evidence: /tmp/e2e-su24719/ (fault-dead-origin.png + oracle-dock-pass.png + ei229 bundle + boot/console logs); durable: e2e/bundles/ei229-wi94-detail-2026-06-10.md, this report, perf baseline artifact.
CLEANED: all three Phase-1-4 display stacks (:90/:91/:92) + apps + monitors + tokens; Phase 5 iso stack fully torn down (hono :3270 killed, Tauri+Xvfb/openbox :93 killed, DROP DATABASE papercusp_e2e_su24719, rm -rf /tmp/e2e-iso-home, stale tokens removed; :3270/:93 verified free).
LEFT ALIVE (reason): harness e2e-imp-sync1 + WI-94 (deprecated) — live repro for EI-206/EI-229; delete after those close.

## P-019 — agent-path smoke (su-8f376, brief 12, 2026-06-10 ~10:40Z) — PASS with 2 findings
Target staging :3170 · dedicated Tauri bare debug binary pid 1148338, bridge :41355, DISPLAY :91 (Xvfb+VirtualGL RTX 3090) · harness e2e-imp-sync1.

bb772's run had stalled with a persisted user turn and $0: root cause was REAL — EI-258: agent-chats messagesRoute called assembleRolePrompt WITHOUT projectDir, so the orchestrator fell back to workspace-blind lookupProjectDir (curl :3055 default → legacy ~/.restart-harness-projects.json) and threw "not registered in any known registry" for any live-registry-only harness. FIXED (routes/agent-chats/index.ts: resolve projectDirForSlug before assembly, clean 404 when absent, pass projectDir; regression test messages-project-dir.test.ts 2/2 green; tsc clean), staging restarted, retried live.

RESULT: chat daab06d2 (worker · WI-94) — user send via dock chat composer → SSE stream → assistant turn exactly "pong". 9 tok in / 77 out / 3¢ = exactly 1 LLM call (budget: the 1 reserve smoke; the +1 contingency unused). UI reflects the turn (transcript renders; conversations tab also shows it read-only). Evidence: /tmp/e2e-su8f376/shot5-pong.png + chat JSON via GET agent-chats/daab06d2.

Findings:
- EI-258 (major, RESOLVED): registry-blind prompt assembly on the chat send path — the EI-220 class, now mirrored to buildRoleLaunchSpec step 0.
- EI-259 (major, OPEN): the chat dispatch records NO spawned_agents row (shim ctx, spawn_id 'agent_chats-*' never registered) — chat-driven agent runs are invisible to intel:spawn_tree / fleet observability. The item's "verify spawn is tracked" leg fails BY DESIGN today.
- UX note (recorded on the plan ## Now): with the legacy Features tab retiring, there is currently NO user-reachable affordance that opens a chat composer — conversations tab is a read-only transcript browser; dock chat panels open only via OPEN_CHAT_EVENT (programmatic). Worth a decision when the features→work-items port settles.

Mutations ledger: +1 feature F-E2E-SMOKE-P019 (tagged e2e-imp; chat path ended up using existing WI-94 chat — feature kept as Detail/peek test datum; delete with the harness) · +2 user turns + 1 assistant turn on chat daab06d2 · staging API restarted once (fix pickup). :91 stack torn down after evidence capture. Harness e2e-imp-sync1 + WI-94 still LEFT ALIVE for EI-206/EI-229 repro per the prior ledger.
