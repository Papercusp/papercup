---
rel_path: "e2e/perf-staging-baseline-2026-06-10.md"
updated_at: 1781191326497
_body: "content"
---

# Perf baseline (run #1, FINAL) — staging :3170 — 2026-06-10 — su-026d2744
Conditions: SPA+API build bb92f2cd · staging tree 65e530aeb at launch · dedicated Tauri (Xvfb :91 + VirtualGL/RTX3090, bare target/debug binary pid 3102387 — tauri-dev watcher unusable under fleet src-tauri churn) · shared backend + native PG :5432 (plan D-001) · loadavg 12–36 on 128 cores · dev build → regressions are the signal, not absolutes (D-004: run #1 = baseline; grade later runs PASS / WARN ≤2× / FAIL vs these numbers).

## STANDING GRADING RULES (adopted by the owner 2026-06-11, from P-013 — load-sensitivity characterization)
Source: papercup:e2e/perf-load-sensitivity-2026-06-11.md (90-min sampler, load1 9.5–48.6, n=42/endpoint).
1. **Grade on MEDIANS (≥5 samples) at any load.** Medians proved load-insensitive on this box (≤0.2ms shift quiet→loadavg 48). A median-based PASS/WARN/FAIL is trustworthy regardless of fleet load — no loadavg gate needed.
2. **Never grade tails or single samples under load.** p90/p95/max degrade up to ~25× under heavy load (worst single samples 200–260ms on 1–2ms endpoints). Any tail-based or single-sample FAIL taken at load1 > ~24 must be re-sampled in a quieter window before filing.
3. **Record loadavg per sample** (the batteries already do) so grades are auditable against this rule.
4. TTFT-provider band: 6.5–12.2s is the accepted provider/infra band (P-010 reclassification) — grade app-side TTFT (<50ms) only; do not re-warn on provider latency inside the band.

## Verdicts vs starting values
| Metric | Result | Grade |
|---|---|---|
| API TTFB hot endpoints (5×ea) | medians 1–5ms; / ~20ms (cold outlier 316ms) | PASS |
| Initial SPA load | domInteractive 34ms, load 570ms | PASS |
| Tab switch (settle, 10 valid samples/leg r2+r3) | med 486–662ms, max 1336ms | PASS (watch ~650ms) |
| Route link out (settle) | med 1.07–1.49s, max 2.62s | PASS |
| Back nav (settle) | med 0.53–0.94s | PASS |
| First-response on any click | 2–111ms med | PASS |
| INP (Event Timing, no longtask in WebKitGTK) | 132 entries ≥16ms, worst 328ms | PASS |
| Chat TTFT (operator-converse SSE, 2 LLM smokes) | app-side 12–39ms; first token 6.5s / 8.8s | WARN (vs 5s; within 2×) — superseded by standing rule 4 |
| Sync propagation (write→open-dashboard DOM) | NEVER propagates for harness-create (remount works) | FAIL → EI-206 (RESOLVED 2026-06-11, mig 222) |
| Memory slope | +32MB / 60 navs after inspector closed; no idle growth issue | PASS |
| PG connections | 47→63 across whole session (fleet-shared; no per-nav growth over 180 navs) | PASS |
| Console errors | 0 across all flows (15-min monitor + window hooks); allowlist empty | PASS |

## Key findings & retraction
- EI-206 (major): harness list on /adv?tab=harnesses never live-updates on harness:create; API + remount-refetch fine → missing notifySyncInvalidate / not on useSyncQuery. (RESOLVED 2026-06-11 — harnessProjects.lite sync query + mig 222 trigger.)
- RETRACTED leak: WebKit inspector (restored OPEN from the SHARED webview profile) held ~1.9GB of record buffers — RSS 2690→819MB on closing it. Not an app leak.
- Desktop operator chat is the native VTE terminal; web OperatorChatSidebar deliberately dark (papercusp-testing flag off, native-terminal-desktop D-017/D-019). ?conv=operator is a read-only history view BY DESIGN. My instance's VTE shows "There is no active session!" — session-liveness check belongs to the functionality lane.
- Incidental PASSes: add-harness modal Esc-close + scroll-lock release; ?tab=/?lsc= nuqs updates; / redirects to /adv.

## Tester gotchas (→ agent-e2e doc)
1. Radix tabs need pointerdown→mousedown→pointerup→mouseup→click — plain .click()/bridge click silently no-ops (tab looks clicked, nothing happens).
2. Close the shared-profile-restored Web Inspector before ANY memory/perf measurement.
3. Launch the bare target/debug binary, not `tauri dev` (fleet edits to src-tauri kill/rebuild the app mid-test); Wayland guard env -u WAYLAND_DISPLAY GDK_BACKEND=x11 DISPLAY=:9X vglrun -d egl0.
4. tauri-agent-tools screenshot verb wants sway/grim here — use DISPLAY=:9X import -window <wid>.
5. operator-converse trigger enum: user_message|quiet_wait_resume|open_canvas|user_says_ready|user_welcomed|continue.

## Raw data
/tmp/e2e-perf-su026d2/{nav.tsv,session.md,*.png} · 180 nav legs, 0 non-ok · TTFT timelines in session.md

## Cleanup ledger (pending)
harness e2e-imp-sync1 (PG + /tmp/e2e-imp-su026d2) · 2 [e2e-test] operator conversations · Xvfb :91 stack + app pid 3102387 (kept while testing continues)
(Resolved 2026-06-11: e2e-imp-sync1 + WI-94 deleted per round-2 P-016 once EI-206+EI-229 closed.)
