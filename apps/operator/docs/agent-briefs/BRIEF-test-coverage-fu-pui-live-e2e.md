# BRIEF — Follow-up: pui live-UI e2e harness (the one structural TUI gap)

**Parent:** BRIEF-test-coverage-2026-06-04 (lead: su-5cf8c). **Readiness: COORDINATE + likely WAIT** — `apps/tui` is currently HOT (su-3854d on P-005a routes/tui + apps/tui, plus su-cdf6b / su-f49a5 active there, su-ad289 surveying the cluster). Do NOT start in apps/tui until that settles; **`coord:presence`-check + announce first**. The operator-side `/api/tui/*` route tests are a SEPARATE brief (`BRIEF-test-coverage-fu-tui-routes.md`) — this one is the *rendered-terminal* gap.

## Why this exists
`pui` (apps/tui) is exhaustively covered OFFLINE — 141 `#[cfg(test)]` tests: the reducer (`app.rs`), rendering over ratatui `TestBackend` (`ui.rs`), DTOs (`models.rs`), transports over fake servers (`framing/ipc/http/sse`), zellij argv (`mux/layout`). The **one thing those can't reach** is a *real rendered terminal driving real zellij + real spawn* end-to-end. `TESTING.md` flags this as the known live gap; the parent audit confirmed it. It's the last uncovered slice of the TUI.

## The approach — drive via the agent-control surface, NOT keystrokes
su-a6146's P12b shipped `tui:dispatch` / `tui:get_state` (the agent→pui control surface, mirroring `ui:dispatch`/`ui_intents`). **Build the harness on that**, not on pty keystroke injection: dispatch an intent to a live pui, read back its state, assert — a deterministic drive/assert loop. su-a6146 already verified the dispatch loop e2e over HTTP; this brief adds the *rendered-terminal* leg.

## Hard constraints (shared dev box — non-negotiable)
- **NEVER drive the user's live `:0` pui.** `n`/`g` keystrokes there spawn REAL agents; focus-stealing on the shared box is unacceptable. (memory: "No live keystroke-drive of pui", "Never steal focus during e2e".)
- Stand up your **OWN Xvfb-driven instance** on `DISPLAY=:99` with a **dedicated `PAPERCUSP_BRIDGE_PORT`** and (ideally) a **dedicated operator instance**, per `/internal/docs/testing/agent-e2e` (§ the Xvfb cookbook) — never the shared `:3070` if a dispatch could mutate live state.
- Prefer `tui:dispatch`/`tui:get_state` over xdotool keystrokes; if you must use xdotool, the `--window <WID>` form only (never `windowactivate`). (memory: "Own Xvfb for e2e".)

## Scenarios to cover (each an `#[ignore]`d live smoke or a standalone harness step)
1. **P12a persistence round-trip:** set a view-state/layout/crew via the live pui → restart the pui → assert it restored from `harness_shared.tui_*` (migration 138). The store layer is unit-tested; this proves the real restart path.
2. **P12b dispatch→render loop:** `tui:dispatch` a `get_state`/navigation intent → assert the rendered terminal reflects it (read `tui:get_state` + optionally an OCR/screenshot of the Xvfb framebuffer).
3. **Palette save/restore-layout/crew with real zellij:** the live `zellij dump-layout` / `zellij --layout` / `psu --resume` spawn parts su-a6146 explicitly deferred-to-supervised. These need the real zellij + a supervised session — the highest-risk, do last.

## Home + rules
- Canonical home: Cargo `#[ignore]`d live smokes in `apps/tui` (run via `cargo test -- --ignored`, NOT in the default offline `cargo test`/CI gate — matches the existing `ipc::live_ipc_smoke` pattern), OR a standalone harness script driven by `tui:dispatch`. Do NOT add live-server-dependent tests to the offline suite.
- Read first: `apps/tui/TESTING.md` (§ Live smokes), `/internal/docs/testing/agent-e2e`, the `tui:dispatch`/`tui:get_state` tool sources + su-a6146's P12b coord notes.
- This is the genuinely-hard, supervision-sensitive slice — scope it small, coordinate continuously, and prefer the dispatch surface to keystrokes at every step.
