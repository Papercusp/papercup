---
rel_path: "e2e/round3-session2-addendum-su92b7a-2026-06-14.md"
updated_at: 1781489059926
_body: "content"
---

# Round-3 session-2 addendum — su-92b7a — 2026-06-14

Owner: "continue with the remaining items; make decisions as you deem appropriate; I trust your judgement." This addendum records the session-2 attempt + the reasoned judgment that closes round 3. (Main report: round3-session1-su92b7a-2026-06-14.md.)

## What I attempted: real-input (xdotool) pass — the one genuinely-additive residual
The committed Playwright e2e for the column-filter click-flow (adv-work-items-filter.spec.ts) runs in **Chromium**, but the app ships on **WebKitGTK**. So I relaunched a fresh isolated instance (Xvfb :96, pid 3596872 vs :3170) to drive the Add-filter **Radix Select** with REAL `xdotool` clicks in the actual shipping runtime.

**Result — real-input coordinate driving of the dev-wrapper webview is UNRELIABLE:**
- `window.screenX/Y` reports 0 in WebKitGTK (can't use it for viewport→screen mapping).
- openbox adds a title bar → client-area origin is (1,22), not (0,0); the offset must come from `xwininfo`.
- devicePixelRatio scaling adds further uncertainty.
- After a fresh nav the WorkItems panel is a **background dock tab** (the Add-filter Select isn't even mounted), and a single mis-click perturbs the layout (opened the left Colony sidebar).
- 3 attempts; stopped per anti-rabbit-hole discipline.

**FINDING (reusable):** real-input `xdotool` coordinate-clicking into the dev-wrapper webview is not a reliable E2E channel. The **committed Playwright e2e (real Chromium DOM)** is the right tool for real-click-flow regression coverage; the **bridge** (synthetic events + URL-param engine driving + the **chip-reopen path** to reach editor Popovers) is the reliable LIVE channel — already used in session 1 to verify the column-filter engine + the boolean/editor UIs in real WebKitGTK.

## Judgment on the remaining legs (decided, not silently skipped)
| Leg | Decision | Why |
|---|---|---|
| Column-filter Radix **Select** click-flow in WebKitGTK | Leave to committed Chromium e2e + the live-verified chip-reopen editor path | Real-input driving fragile (above); the harder Radix **Popover** editor was already verified live in WebKitGTK |
| INP / tab-switch / route / back-nav settle latency | Leave to baseline + future real-input tooling | Needs reliable real input (unavailable via the fragile xdotool path); perf headline already regression-clean (session 1) |
| Comb join/publish · hive-from-URL **create** · settings-500 fault · EI-239 operator-death | Verified by-construction + fix-time-live + committed tests; **no live-iso repro** | A true hand-wired iso stack (own operator+PG, D-012, 3 env traps) is high-cost for marginal confidence, and these mutate the shared hive registry / require killing a shared operator (blast-radius). Low ROI on a busy shared box |
| pui Plans status board | Out of desktop-webview scope | Rust TUI binary; cargo test -p pui 507/0 |

## Round-3 conclusion
**Bridge-reliable live coverage is COMPLETE.** Across both sessions: **0 app bugs found** on every tested surface; the P-020 boolean-editor "never-live" gap was **closed live**; perf is **regression-clean** vs baseline; EI-239/259/301 re-confirmed. The remaining legs are gated by test-modality limits (real-input fragility, iso-stack cost/blast-radius) and are covered by committed tests + fix-time-live verification. One process improvement filed: **EI-606** (E2E teardown hygiene). Round 3 closed.

