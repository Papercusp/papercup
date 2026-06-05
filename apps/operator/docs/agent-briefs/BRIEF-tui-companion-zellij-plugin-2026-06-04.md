# BRIEF — Companion zellij plugin for `pui` (P-004 / D-008)

**Plan:** `tui-workbench-ratatui-2026-06-04` (read it: `plans:get { slug, harness:'all' }`). Decision **D-008** is the full rationale + channel analysis — read it before starting.
**Gate:** this is a **wasm spike that needs interactive zellij verification**. The build + unit tests are offline; the live driving is not — do it on your **own Xvfb-driven zellij**, never the user's live session (focus-steal is unacceptable; see `/internal/docs/testing/agent-e2e`).

## Goal
A **thin** `wasm32-wasi` zellij plugin = `pui`'s *eyes + hands inside zellij*. It holds **no backend connection** and renders little/nothing; it observes the live zellij session and executes in-zellij orchestration, linked **full-duplex to `pui` over one long-lived `zellij pipe` child**.

## Why a plugin (and why thin) — verified facts (don't re-derive)
Checked the whole plugin↔outside surface: `web_request`, `run_command`, `pipe_message_to_plugin` are all **buffered** (no streaming); **no raw TCP/Unix sockets** for plugins. So a plugin **cannot be the backend client** — `pui` (external) stays the brain. The ONE streaming channel is the **CLI pipe** (`pipe()` handler + `cli_pipe_output` + `block_cli_pipe_input`/`unblock_cli_pipe_input`, with backpressure), inbound from an external feeder. That feeder is `pui`.

## The link (concrete)
One long-lived `zellij pipe -p <plugin>` child spawned by `pui` = a full-duplex stream:
- `pui` → child **stdin** → plugin `pipe()` handler  (commands: "open layout", "focus pane N", "relaunch agent in pane N")
- plugin `cli_pipe_output` → child **stdout** → `pui` reads  (events: pane/tab map, "pane N exited", focus moved)

## Scope
### Plugin (new crate, e.g. `apps/pui-zellij-plugin`, `crate-type=["cdylib"]`, target `wasm32-wasip1`)
- Dep: `zellij-tile` (check current version via context7 / docs.rs). `rustup target add wasm32-wasip1` (confirm the exact target triple zellij wants).
- Request permissions `ReadApplicationState` + `ChangeApplicationState`. Subscribe `PaneUpdate`, `TabUpdate`, `CommandPaneExited`, focus/key events.
- On a session-state change → serialize a compact pane/tab map (+ the event) → `cli_pipe_output` it (JSON line).
- On `pipe()` (commands from `pui`) → execute via host commands (`new_tabs_with_layout`, focus/close/rename, open a command pane).

### `pui` side (`apps/tui`)
- New module (e.g. `companion.rs`): spawn the `zellij pipe -p <plugin>` child, read its stdout (plugin events → new `Event`s → reducer → live workbench topology in state), write commands to its stdin.
- Wire into the existing `mux.rs` `MuxAction` surface where it makes sense (orchestration now goes through the plugin when present, falling back to `zellij action`).

## Unlocks (the payoff)
Live workbench topology (which agent in which pane + when one exits → offer/auto-relaunch), focus-following, reliable orchestration, and the in-zellij vantage point for **watch-a-peer (D-004)**.

## Testing
- Message format: serialize/parse unit tests **on both sides** (plugin + `pui`).
- Plugin compiles to wasm (`cargo build --target wasm32-wasip1`).
- Live (own Xvfb zellij): load the plugin, open/close a pane, assert the pane map + exit event flow to `pui`; send a command, assert the pane opens. Bar: `cargo test` green + clippy 0.

## Done when
With a real (own) zellij session, `pui` shows the live pane/agent map, detects an agent pane exiting, and can open a pane on command — end-to-end over the duplex pipe.

## Do NOT
- …put any backend/data logic in the plugin — it's thin; if it needs data it asks `pui`.
- …drive the user's live zellij (`:0`) — own Xvfb only; never steal focus.
- …try to stream the backend from inside the plugin (impossible — see D-008); the plugin only talks to `pui`.
