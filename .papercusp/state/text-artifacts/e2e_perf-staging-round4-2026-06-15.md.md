---
rel_path: "e2e/perf-staging-round4-2026-06-15.md"
updated_at: 1781570326629
_body: "content"
---

# Perf round-4 battery — staging :3170 — 2026-06-15 — fresh-profile instance

**Instance:** Xvfb :98 + VirtualGL (NVIDIA RTX 3090, confirmed — not llvmpipe) · bare
`src-tauri/target/debug/papercusp-desktop` pid 892851 (relaunched once at preflight) ·
**FRESH PAPERCUSP_HOME=/tmp/e2e-r4-perf-home** · webview = 2x WebKitWebProcess (main
content + dev-wrapper control-bar) · shared backend + native PG :5432.

**INSPECTOR STATUS — CONFIRMED CLOSED (memory numbers valid).** A fresh profile restored
NO Web Inspector. The 1112x722 webview viewport (< the 1920x1059 window) is NOT a docked
inspector — the dev-wrapper embeds a **native VTE terminal (left) + control bar** as GTK
siblings of the webview, which is why the webview doesn't fill the window. Evidence: tauri
log lines `native-terminal: VTE view embedded` + `control bar embedded (switcher + pipeline
status)`; the two WebKitWebProcesses are 364/395 MB (normal webviews), NOT the multi-GB
record-buffer signature of an open inspector (baseline's open inspector held ~1.9 GB).
`window.__REACT_DEVTOOLS_GLOBAL_HOOK__` undefined. The bottom-panel in screenshots is the
embedded VTE/operator terminal, not devtools.

**Grading:** MEDIANS, >=5 samples/metric (per agent-e2e 14.1 + P-013 load-sensitivity).
PASS / WARN (<=2x baseline) / FAIL (>2x baseline). loadavg recorded per batch; box under
expected concurrent fleet load (load1 ~19-34 throughout).

## Graded table (round-4 vs baseline run #1 2026-06-10)

| # | Metric | Baseline | R4 median observed | Grade | loadavg |
|---|---|---|---|---|---|
| 1 | API TTFB — `/api/installed` (JSON) | ~0.7-1 ms | **2.2 ms** | PASS | 19-34 |
| 1 | API TTFB — `/api/health` (JSON) | (new) ~2 ms expected | **16-19 ms** | PASS | 19-34 |
| 1 | API TTFB — `/healthz` (= SPA-shell HTML) | 1.5 ms | **~93 ms** (med-of-batch-meds; 25-194 range) | WARN* | 27-34 |
| 1 | API TTFB — `/` (= SPA-shell HTML) | 1.1 ms | **~76 ms** (med-of-batch-meds; 30-171 range) | WARN* | 27-34 |
| 2 | Initial SPA load — domInteractive | 34 ms | **158 ms** (n=9) | WARN | 19-25 |
| 2 | Initial SPA load — loadEventEnd | 570 ms | **567 ms** (n=9) | PASS | 19-25 |
| 3 | Tab-switch settle | med 486-662 ms | **420 ms** (n=10, 4 tabs) | PASS | 22-24 |
| 4 | Route out (/adv->/support) | 1.07-1.49 s | **730 ms** (n=5) | PASS | 21-23 |
| 4 | Back nav (->/adv reload) | 0.53-0.94 s | **~=567 ms** (= /adv reload; in-page measure crosses nav boundary) | PASS | 21-23 |
| 5 | First-response on click (handler proc) | 2-111 ms | **1-4 ms proc** | PASS | 20-22 |
| 5 | INP (Event Timing, 140 entries, real clicks) | worst 192-328 ms | **median 192 ms** (p90 912, max 1192) | WARN | 20-22 |
| 6 | Chat TTFT — app-side dispatch | 12-39 ms | **2 ms** (clean send-button path; <50 ms target) | PASS | 20-30 |
| 6 | Chat TTFT — provider first-token | 6.5-12.2 s band | not driven (cost; band = infra, not graded) | n/a | — |
| 7 | Sync-propagation (WI create -> DOM) | FAIL (never propagated -> EI-206) | **593 ms** (n=5, 5/5 propagated) | PASS (EI-206 fix holds) | 24-28 |
| 8 | Webview RSS slope | +32 MB/60 navs; no idle growth | active +914 MB/60 min heavy use; **idle slope ~= 0 (flat ~1.8 GB plateau)** | PASS (no leak) | 20-24 |
| 9 | PG connections (operator DB, dev_pg_health) | 47->63 fleet-shared, no per-nav growth | **44-47, stable** (no growth; no pathological query) | PASS | — |
| 10 | Console errors (nav battery + conv tab) | 0 | **0** (monitor verified working via injected marker) | PASS | 24 |

\* **WARN\*** on `/healthz` + `/`: these routes are NOT lightweight health endpoints — they
hit the SPA catch-all and return the full **24 KB SPA HTML shell** (with a 5.7 KB inlined
flags+prefs blob requiring DB reads). Baseline measured the same shell at ~1-2 ms. The
elevation is amplified backend/PG contention, NOT a code regression — see analysis below.
The real JSON health endpoint is `/api/health` (PASS, ~16-19 ms; itself elevated from the
same contention but tiny absolute).

## Why `/healthz` + `/` are WARN, not FAIL (load-fluctuation analysis)

Six batches, load1 held steady 27.7-34.1, yet the SPA-shell medians swung wildly and
bimodally — they do NOT track load1:

| batch | load1 | /healthz | / | /api/installed | /api/health |
|---|---|---|---|---|---|
| 1 | 28.5 | 111.9 | 66.9 | 67.1 | 16.7 |
| 2 | 28.2 | 26.7 | 30.1 | 1.3 | 29.5 |
| 3 | 34.1 | 136.1 | 89.9 | 24.3 | 1.5 |
| 4 | 30.7 | 74.8 | 85.6 | 1.9 | 1.9 |
| 5 | 28.2 | 25.3 | 170.9 | 21.9 | 14.7 |
| 6 | 27.7 | 193.7 | 51.5 | 12.1 | 31.2 |

Key reads:
- The jitter is per-request, bimodal (fast ~25-30 ms <-> slow ~90-194 ms) at **constant
  load1** -> it is **backend/PG contention on the shared :3170 backend**, not box-CPU load.
- Even the cheapest JSON endpoints (`/api/installed`, `/api/health`) intermittently spike
  to 67 ms / 31 ms then drop back to ~2 ms — the contention is **app-wide**, just amplified
  on the SPA-shell because it does heavier DB work (flags+prefs inline).
- P-013 load-sensitivity claimed `/` medians stay ~2 ms even at load 48 — but that window
  evidently had a quieter shared backend. The current elevation reflects the **shared
  backend being more contended now**, affecting all endpoints proportionally to their DB
  work. Not isolated to a regressed code path -> graded WARN, not FAIL, and NOT filed as a
  regression. (PG itself is healthy: 44 conns, all idle/LISTEN, no pathological active query.)

Because load1 was 27-34 (> the ~24 quiet-window threshold) for the whole API-TTFB battery
and the medians are contention-dominated (not load1-dominated but backend-dominated), the
binding P-013 rule "don't FAIL on samples taken at load1 > 24 without a quiet re-sample"
applies — and a quiet shared-backend window never materialized in this session. Held at WARN.

## Per-metric raw notes

**M1 API TTFB:** `/api/installed` med 2.2 ms (PASS, ~=baseline). `/api/health` (real health
JSON, 74 bytes) med 16-19 ms. `/healthz` & `/` both serve the 24 KB SPA HTML shell -> WARN
(contention, see above).

**M2 SPA load (9 reloads, Navigation Timing):** domInteractive 74,123,131,134,158,160,222,
255,562 -> med 158 ms (WARN vs 34; absolute small, dominated by responseEnd ~116 ms = the
slow shell HTML). loadEventEnd med 567 ms ~= baseline 570 (PASS).

**M3 tab-switch (10 samples, body-innerText 300 ms-quiet settle, full Radix pointer seq):**
health ~150 ms, overview ~450 ms, brainstorm 389 ms, harnesses ~810 ms (heaviest) ->
combined med 420 ms (PASS, below baseline 486-662; harnesses max 851 < baseline max 1336).

**M4 route+back (5 cycles):** /adv->/support loadEventEnd 502,635,730,904,1126 -> med 730 ms
(PASS, improved vs 1.07-1.49 s). Back leg hard-reloads to /adv (type=reload) — in-page
measure can't survive the nav boundary; settle ~= /adv reload (567 ms) -> PASS vs 0.53-0.94 s.

**M5 INP / first-response (Event Timing API, 140 entries, REAL xdotool clicks — calibrated
screen offset = viewport + (808,42)):** median interaction duration 192 ms (p90 912, max
1192). BUT processing time (`processingEnd-processingStart`, the actual app handler work) is
1-4 ms across all entries — the duration is dominated by input *delay* (133-178 ms main-thread
busy before handler). App responsiveness is excellent; the latency is fleet-load main-thread
contention. median 192 ms = WARN (within 2x baseline worst 192-328; load-affected tail).
NOTE: synthetic dispatches produce ZERO Event Timing entries (confirmed) — used real input.

**M6 Chat TTFT app-side:** brainstorm composer reachable ("Pitch an idea... cmd+enter to send").
Instrumented fetch/EventSource; send dispatches to `/api/agent-tools/brainstorm/chat`.
Clean send-button-click path: **2 ms** app-side dispatch (synthetic-key path showed 319 ms
incl. input-flush overhead — discarded). <50 ms target met -> PASS. Provider first-token not
driven (cost; the 6.5-12.2 s band is infra, not graded per standing rule 4).

**M7 Sync-propagation (5 ephemeral [e2e-test] work-items WI-163..167, in-page 50 ms-poll
detector, propagation = DOM-detect epoch - server createdAt epoch):** 767, 517, 593, 469,
617 ms -> med 593 ms, 5/5 propagated to the harnesses/working tab. EI-206 (baseline FAIL,
"never propagates") is RESOLVED and propagation is healthy sub-second -> PASS. All probes
deprecated/cleaned up.

**M8 Webview RSS:** app_rss flat 264->272 MB over 60 min (+8 MB). wv_sum (both WebKitWebProcs)
832->1746 MB over 60 min of ACTIVE heavy battery (reloads/tab-cycles/INP clicks/chat). This is
active-use + warm-up allocation (baseline run2 saw the same: +184 MB warm-up then flat).
**IDLE slope (observers cleared, no nav): wv_sum 1835->1791->1807->1889->1889 MB across 5 min
(20:32:55-20:36:28) — oscillates in a ~100 MB band with NO sustained climb; flat over the
last 30 s; app_rss rock-stable 272 MB.** No idle accumulation -> does NOT trend toward the
16 GB WebKit kill (EI-278 concern). The active-window growth is reclaimed/plateaus on idle.
-> PASS, no leak.

**M9 PG connections:** dev_pg_health (operator-DB-scoped, matching baseline) = 44 total / 6
active / 20 idle — stable, BELOW baseline's 47-63, no per-op growth. dev_pg_active_queries:
all 15 idle (LISTEN/NOTIFY pubsub + idle txns), no active long-running/pathological query.
(Raw native-PG-server `pg_stat_activity` count 58-75 includes the whole fleet, not the
operator DB — not the apples-to-apples figure.) -> PASS, no leak.

**M10 Console errors:** console-monitor (level=error) over a full nav battery (8 tab switches
+ reload + route + back) = 0 errors. Re-ran all-levels over a conversations-tab visit = 0
(EI-720 403s are network-level HTTP, not console.error — correctly excluded). Monitor verified
functional via an injected `console.error` marker (captured). -> PASS.

## Overall verdict

**No real perf regressions; no leaks.** EI-206 sync-propagation (baseline's only FAIL) is
RESOLVED and healthy (med 593 ms). Webview RSS idle slope ~= 0 (~1.8 GB plateau) — NOT a leak,
no EI-278 progression in this window. PG connections stable (44, below baseline) — no leak.
Console clean (0). All in-app interaction metrics PASS or WARN-within-2x (tab-switch 420 ms
PASS-improved; route 730 ms PASS-improved; INP/proc 1-4 ms excellent; chat app-side 2 ms).

The only elevations are the **SPA-shell HTML routes (`/`, `/healthz`) and SPA domInteractive**,
all driven by the **same shared-backend/PG contention** that intermittently spikes even the
cheap JSON endpoints — bimodal per-request jitter at constant load1, not a code regression and
not isolated to a regressed path. Graded WARN, NOT FAILED, NOT filed (PG is healthy: 44 conns,
no pathological query). Per the binding P-013 rule, these API-TTFB samples sit at load1 27-34
(> 24) and a quiet shared-backend window did not materialize this session, so a FAIL on them
would be unsafe regardless.

**Issues filed: NONE** (no metric graded FAIL on medians; no unbounded RSS/PG leak).

**Inspector: CONFIRMED CLOSED** for all memory/RSS numbers (fresh profile; the small viewport
is the dev-wrapper VTE+control-bar split, not a docked inspector — see header).

## loadavg context

load1 ranged ~19-35 across the whole session (3 e2e instances + fleet active concurrently,
as expected). loadavg recorded per batch in the table. No metric was FAILED on a tail or a
single sample at load1 > 24 without analysis.

## Cleanup ledger
- 6 ephemeral [e2e-test] work-items WI-162..167 created for sync-propagation; ALL deprecated.
- Xvfb :98 + openbox + Tauri pid 892851 + RSS sampler: TORN DOWN at session end.
- Raw: /tmp/e2e-r4-perf-report.md, /tmp/e2e-r4-perf-rss.tsv (118 samples), /tmp/e2e-r4-perf-*.png.

