---
rel_path: "e2e/perf-staging-run2-2026-06-10.md"
updated_at: 1781144970043
_body: "content"
---

# Perf run #2 (first regression-graded run) — staging :3170 — 2026-06-11 ~02:15–02:30Z — su-0feaf
Plan: app-impersonation-e2e-round2-2026-06-10 P-009/P-010 · Baseline: papercup:e2e/perf-staging-baseline-2026-06-10.md (run #1, su-026d2744) · Grading per predecessor rule: PASS / WARN ≤2× baseline / FAIL.

Conditions: staging :3170 RESTARTED 22:12:29 EDT, all battery legs ran 22:18–22:27 EDT against the new process (no leg spans the restart) · tree was 65a1a70ac at session preflight, 9e0200d63 by battery end (git-sync churn; SPA is watch-built) · FLAG DEFAULTS FLIPPED ON mid-session (oracle, harness-phases, design, testing, inbox-durable-escalations, improvement-auto-implement now true, source=defaults) — battery ran with MORE surfaces enabled than run #1 · dev build, Xvfb :94 + VirtualGL RTX 3090, bare debug binary pid 88077, webview 89394 · WebKit inspector OPEN throughout (EI-180; close button unresponsive to synthetic clicks — multiple attempts) · loadavg 10–21/128 · driving: synthetic 5-event pointer sequences for tabs; real xdotool clicks for the INP leg; settle = last DOM-text change before a 300ms quiet window (≥400ms floor, 8s cap).

## Graded table (run #2 vs run #1 baseline)
| Metric | Baseline (run #1) | Run #2 | Grade |
|---|---|---|---|
| API TTFB hot endpoints (5×ea) | medians 1–5ms; / ~20ms | /healthz 1.5ms · /api/installed 0.7ms · / 1.1ms (one cold 24.5ms outlier) | PASS (improved) |
| Initial SPA load (5 reloads) | domInteractive 34ms, load 570ms | domInteractive med 56ms, load med 332ms (315–377) | PASS (load −42%; domInteractive 1.6× but trivial absolute) |
| Tab switch settle | med 486–662ms, max 1336 (10 samples) | 10-sample med 670ms max 1541; n=120 med ~532ms p90 984 max 1371 | PASS (at baseline; large-n well inside) |
| Route link out (3×) | med 1.07–1.49s | /adv→/support loadEventEnd med 416ms | PASS (improved; small n) |
| Back nav (3×) | med 0.53–0.94s | /support→/adv med 529ms | PASS |
| First-response on click | 2–111ms med | NOT COMPARABLE — this run proxied first DOM-text change (med ~293ms), coarser than run #1's method | n/a (method note) |
| INP (Event Timing, real clicks) | 132 entries, worst 328ms | 66 entries over 9 real tab clicks, worst 192ms | PASS. NOTE: synthetic dispatches produce ZERO Event Timing entries — INP legs MUST use real input |
| Chat TTFT (operator-converse SSE, 2 smokes) | app-side 12–39ms; first token 6.5s/8.8s | app-side 17/34ms; first token 12.2s/8.0s (costs $0.25 cold / $0.013 cached) | app PASS · provider WARN — see P-010 reclassification below |
| Sync propagation | FAIL → EI-206 | not re-measured (EI-206 open; creating a harness just to reconfirm wasn't justified) | PENDING-FIX carryover |
| Memory slope (webview 89394) | +32MB/60 navs (inspector CLOSED) | round 1 +184MB/60 navs, round 2 −8MB/60 navs → steady-state ≈0; app proc 280→281MB stable | PASS on steady-state. Confound: inspector OPEN (its instrumentation lives in the inspected process); round-1 number is warm-up allocation, not comparable to baseline |
| PG connections | no per-nav growth | 39→43 total across whole battery (fleet-shared box), no per-nav growth | PASS |
| Console errors | 0, empty allowlist | 0 app-level across ~140 navs + all legs | PASS |

## P-010 resolution — TTFT WARN reclassified provider/infra
4 measurements across two runs (6.5, 8.8, 8.0, 12.2s) with app-side consistently <50ms: the latency is provider-side (operator brain cold prompt vs cache visible in cost: $0.25 vs $0.013). Per the plan item: reclassified as provider/infra, NOT an app regression; baseline band set to 6.5–12.2s; surfaced once to the owner in the session summary — future runs grade against the band without re-warning.

## P-011 soak (started, running)
Idle-soak sampler live since ~02:28Z: /tmp/e2e-r2-soak.sh → /tmp/e2e-r2-soak.tsv, 5-min samples of webview/inspector-wv/app/staging-node RSS + PG conns + loadavg. First sample: webview 785MB, INSPECTOR-WEBVIEW 1.15GB (15 min after boot — prime EI-278 suspect/confounder), app 287MB, staging node 1.96GB, pg 62. Coordinated with EI-278's assignee (su-111be, msg mq8vpauh): nav-driven growth ruled out (warm-up then flat); idle accumulation is the hypothesis to watch. The :94 stack is LEFT ALIVE deliberately for the soak.

## Notable environment findings
- Flag-defaults flip mid-session (six flags → ON): preflight's "re-snapshot flags per test block" rule is load-bearing — the Oracle tab appearing was correct gating, not a leak.
- Inspector (EI-180) unclosable via synthetic clicks in the dev-wrapper; plan memory legs around it (slope + steady-state, not absolutes).
- Staging restarts are frequent (2 observed in ~40 min across sessions 1–2); always reconstruct the restart timeline before grading.

Raw: /tmp/e2e-r2-ttft{1,2}.log, /tmp/e2e-r2-su0feaf/*.png, soak TSV accumulating.
