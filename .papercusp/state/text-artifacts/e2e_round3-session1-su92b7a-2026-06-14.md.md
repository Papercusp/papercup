---
rel_path: "e2e/round3-session1-su92b7a-2026-06-14.md"
updated_at: 1781483834377
_body: "content"
---

# Impersonation E2E round 3 — session 1 report — su-92b7a — 2026-06-14

**Plan:** app-impersonation-e2e-round3-2026-06-14 (continuation of deleted session d40f8784, which left no plan/report — only setup-gotcha memories).
**Target:** staging :3170, branch `staging` HEAD **99fbd625a**. Isolated Tauri on Xvfb **:96** (pid 3723074, bridge :37615) vs staging :3170. Owner's live window untouched.
**Flags (source=defaults):** papercusp-testing **OFF** (Oracle/composer dark = expected, skipped per task); grid-column-filters / the-hive / hive-from-github-url / harness-phases / design **ON**.
**Console-error allowlist:** EMPTY — 0 [ERROR] tolerance. Held: **0 console errors** across all flows this session.
**Box:** load1 ~17–20 on 128 cores (~14% util → median-valid per baseline grading rule 1).

## Coverage checklist (PASS / FAIL / N/A + evidence)

| Item | Leg | Verdict | Evidence |
|---|---|---|---|
| P-001 | Preflight + isolated instance | PASS | Instance up :96/pid 3723074 vs :3170@99fbd625a; SPA loaded; console baseline clean; owner window untouched |
| P-005 | Column filters — bar renders | PASS | ColumnFilterBar on WorkItems(120) + AdvAgents; "Add filter…" Select + 10 cols |
| P-005 | Engine via URL (`wif`/`faf`) | PASS | wif=state:passed → "State: passed" chip + Clear-all; deprecated F-SHEET filtered out of view |
| P-005 | Clear all (real click) | PASS | Pointer-sequence click → removes chip + `wif` param |
| P-005 | **Boolean editor (P-020 "never-live" gap)** | **PASS — gap closed** | faf=live:true → chip; click chip opened editor (bypasses Radix-Select wall via P-020 chip-reopen); True/False aria-pressed matched; click False flipped buttons+chip("Live: false")+URL(faf=live:false) |
| P-005 | Filtered row COUNT | N/A-method | canvas/glide grid: no DOM rows, no aria-rowcount; header "(120)"=unfiltered total. Covered by grid-core 49/49 + e2e adv-work-items-filter.spec.ts |
| P-005 | +Add-filter Radix Select click-flow | N/A-method | synthetic Xvfb input wall (P-019); covered by the committed Playwright e2e |
| P-004 | EI-301 doc prune | PASS | agent-e2e.mdx: ":::note[Retired surfaces — do NOT e2e these]" L1246; §13 mirrors live ADV_TABS L1212; §15.5 React-19 input gotcha L1457 |
| P-002 | EI-239 offline/recovery | PASS (code) | connectivity.ts (useSyncConnectivity), OfflineIndicator mounted __root.tsx L45/238, Rust install_load_failure_recovery at 3 window paths incl. production L961/1405/1865. Live socat repro done at fix-time (su-6c28e). Fresh iso-rig repro = optional follow-up |
| P-007 | Comb / hive browse | PASS (read-only) | Hives tab: "LOCAL HIVES · 1/2 RUNNING" (papercup-hive running, sb-devboard-hive stopped) + "P2P SWARM · 1 JOINED · 1 LIVE". Mutations (Start/Stop/join/publish) NOT touched — papercup-hive is the LIVE fleet hive |
| P-008 | hive-from-GitHub-URL | PASS | "New" → dialog modes New hive / Standalone / Search GitHub (+ into-hive); GitHub search input accepts "papercusp" (via React-19 __reactProps$ onChange, §15.5) → LIVE result papercupai/papercusp-blueprint-roundtrip-p112. Create/join = mutation, not exercised |
| P-006 | pui Plans status board | N/A-modality (dropped) | Rust pui TUI binary (~/.cargo/bin/pui, j/k nav, cargo test -p pui 507/0) — terminal surface, NOT desktop-SPA webview. Out of desktop-impersonation scope |
| P-003 | EI-259 chat-spawn-tracking | PASS (code + live-DB) | chat-spawn-tracking.ts → recordSpawnPg, wired messagesRoute L309-311; harness_shared.spawned_agents has 8 agent_chats% rows status=done incl. LIVE papercup chat → tracked in production. No fresh LLM smoke (already live-verified round-2). spawn_tree=N/A-NO-TOOLS |

## Perf battery (P-009) — graded vs perf-staging-baseline-2026-06-10 (MEDIANS, ≥5 samples)

| Metric | Round-3 | Baseline | Grade |
|---|---|---|---|
| API TTFB /api/health (5×) | median 1.0ms | 1–5ms | PASS |
| API TTFB /api/flags (5×) | median 1.1ms | 1–5ms | PASS |
| API TTFB /api/harness/all/kpis (5×) | median 8.3ms | ~20ms | PASS (better) |
| Initial SPA load | domInteractive 83ms, loadEventEnd 424ms | 34ms / 570ms | PASS (loadEventEnd better; domInteractive single-sample, excellent absolute) |
| Webview RSS | 277 MB | (baseline inspector artifact retracted) | PASS (no leak) |
| PG connections | 40 total / 4 active | 47→63 fleet-shared | PASS (no growth) |
| Console errors | 0 | 0 | PASS |

**Perf residual (focused real-input follow-up):** INP / tab-switch / route-nav / back-nav settle / first-response — NOT measurable via bridge-synthetic events (Event Timing API records only REAL input; settle metrics need multi-sample xdotool driving). Chat-TTFT deferred (LLM spend + provider-band rule 4). Sync-propagation (ex-EI-206 FAIL) RESOLVED at fix-time (mig 222); no code changes to interaction paths suggest regression.

## Filed issues
**None** — every tested surface PASSED. No app bugs found this session.

## Methodology findings (for agent-e2e / future rounds)
1. **Canvas (glide) grids aren't row-countable via the bridge** — no DOM rows, no aria-rowcount; panel header counts are the UNFILTERED total. Verify grid row-effects via the committed Playwright e2e (real Chromium DOM) + grid-core unit tests; the bridge confirms bar/chip/URL/clear wiring + (via the chip-reopen path) the editor UIs.
2. **Boolean/enum/text editor UIs are reachable WITHOUT the Radix Select** — set the filter by URL param, then click the resulting chip (plain button + P-020-fixed Popover) to open its editor. This bypasses the Radix-Select synthetic-input wall and is how P-005 closed the P-020 boolean-editor gap live.
3. **INP / Event Timing not measurable via synthetic dispatchEvent** — needs real xdotool/native input. Same family as the Radix-Select wall.
4. **React-19 controlled inputs**: native value-set + change silently fails; drive via the element's `__reactProps$` onChange expando (agent-e2e §15.5) — confirmed working on the GitHub search input.

## Batched owner questions
1. **EI-239 fresh live repro** — the offline/recovery fix is confirmed in-tree (3 install points incl. production) + was live-verified via socat at fix-time. Want a fresh round-3 iso-rig operator-death repro (~45 min stand-up), or is the in-tree + fix-time-live verification sufficient?
2. **Mutation legs** (Comb join/publish, hive-from-URL create, column-filter Add-Select click-flow, INP/settle latency) need either a tagged scratch hive/iso stack or real-input (xdotool) driving. Worth a dedicated iso/real-input sub-session, or leave to the committed Playwright e2e + unit coverage?
3. **pui Plans board** is a TUI surface (cargo test -p pui 507/0) — out of desktop-webview impersonation. Want a separate TUI-driving pass, or treat cargo coverage as sufficient?

## Cleanup ledger
- Isolated instance (Xvfb :96, Tauri pid 3723074, bridge token, /tmp/e2e-r3-su92b7a-*) — **KEPT WARM** pending session continuation / the perf real-input follow-up. To be torn down at session end (P-011).
- No mutations performed (all UI driving read-only; no scratch harness/hive created; shared webview profile + shared PG untouched). Nothing to revert.

